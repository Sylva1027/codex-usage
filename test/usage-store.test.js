import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { UsageStore } from "../src/usage-store.js";
import { buildUsageIndex, summarizeUsageIndex } from "../src/usage-core.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function tokenRow(timestamp, total, input, cached, output, reasoning) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
      },
    },
  };
}

async function makeStoreFixture() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-store-"));
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "12");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-07-12T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "store-session", source: "cli", originator: "codex-tui", cwd: "/work/store" },
      },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      tokenRow("2026-07-12T01:01:00.000Z", 123, 100, 20, 23, 5),
    ]),
  );
  return {
    homeDir,
    sessionFile,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  };
}

test("UsageStore 首次同步并只重建变化文件", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    const first = await store.sync();
    const firstMetadata = store.metadata();
    const firstSummary = store.summarize({ preset: "all", bucket: "day" });

    assert.equal(first.updatedFileCount, 1);
    assert.equal(firstMetadata.eventCount, 1);
    assert.equal(firstMetadata.sessionCount, 1);
    assert.equal(firstSummary.totals.total, 123);
    assert.ok(Math.abs(firstSummary.costEstimate.totalUsd - 0.00023) < 1e-12);
    assert.equal(firstSummary.costEstimate.modelCount, 1);

    await appendFile(sessionFile, JSON.stringify(tokenRow("2026-07-12T01:02:00.000Z", 200, 160, 30, 40, 7)) + "\n");

    const refreshed = await store.sync();
    const refreshedSummary = store.summarize({ preset: "all", bucket: "day" });
    const unchanged = await store.sync();

    assert.equal(refreshed.updatedFileCount, 1);
    assert.equal(refreshedSummary.eventCount, 2);
    assert.equal(refreshedSummary.totals.total, 200);
    assert.ok(Math.abs(refreshedSummary.costEstimate.totalUsd - 0.0004) < 1e-12);
    assert.equal(unchanged.updatedFileCount, 0);
  } finally {
    store.close();
  }
});

test("UsageStore 将非 Git 仓库比较项按工作目录归组", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const sessionIndexPath = path.join(homeDir, ".codex", "session_index.jsonl");
  await writeFile(sessionIndexPath, jsonl([{ id: "store-session", thread_name: "修复用量表格" }]));
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const comparison = store.periodComparison({ now: "2026-07-12T12:00:00.000Z" });
    const directory = comparison.repositories.find((row) => row.key === "directory:/work/store");
    const selectedRangeRepository = store.summarize({ preset: "all", bucket: "day" }).repositories[0];

    assert.equal(directory.name, "/work/store");
    assert.equal(directory.kind, "directory");
    assert.equal(comparison.repositories.length, 1);
    assert.deepEqual(selectedRangeRepository.sessionIds, ["store-session"]);
  } finally {
    store.close();
  }
});

test("UsageStore 汇总结果与内存索引保持一致", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const index = await buildUsageIndex({ homeDir });
    const filtersList = [
      { preset: "all", bucket: "day" },
      { preset: "today", bucket: "hour", now: "2026-07-12T12:00:00.000Z" },
    ];

    for (const filters of filtersList) {
      const actual = store.summarize(filters);
      const expected = summarizeUsageIndex(index, filters);
      assert.deepEqual({ ...actual, generatedAt: "" }, { ...expected, generatedAt: "" });
    }
  } finally {
    store.close();
  }
});

test("UsageStore reindexes a file when its source identity changes", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    store.database.prepare("UPDATE source_files SET home_id = ?").run("legacy-order-based-id");

    const result = await store.sync();
    const source = store.database.prepare("SELECT home_id FROM source_files").get();
    const activeHome = store.homes.find((home) => home.kind === "main");

    assert.equal(result.updatedFileCount, 1);
    assert.equal(source.home_id, activeHome.id);
    assert.equal(store.metadata().eventCount, 1);
  } finally {
    store.close();
  }
});

test("UsageStore preserves indexed data when a source scan fails", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    store.usageFiles = async (homes) => ({
      files: [],
      warnings: ["simulated source scan failure"],
      failedHomes: homes.map(({ id, path }) => ({ id, path })),
    });

    const result = await store.sync();

    assert.equal(result.updatedFileCount, 0);
    assert.equal(store.metadata().eventCount, 1);
    assert.match(store.warnings[0], /simulated source scan failure/);
  } finally {
    store.close();
  }
});

test("UsageStore upgrades schema v2 and reindexes old source files with unknown billing fields", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const initial = new UsageStore({ homeDir, databaseFile });
  await initial.sync();
  initial.close();

  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA user_version = 2");
  for (const column of [
    "price_version", "service_tier", "context_level", "request_input_tokens", "cache_write_known", "cache_write_tokens",
  ]) {
    database.exec(`ALTER TABLE events DROP COLUMN ${column}`);
  }
  database.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    const result = await migrated.sync();
    const event = migrated.database.prepare(
      "SELECT cache_write_known, context_level, service_tier, price_version FROM events",
    ).get();
    assert.equal(result.updatedFileCount, 1);
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), 3);
    assert.equal(event.cache_write_known, 0);
    assert.equal(event.context_level, "unknown");
    assert.equal(event.service_tier, "unknown");
    assert.equal(event.price_version, "2026-09-23");
  } finally {
    migrated.close();
  }
});

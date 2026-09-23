
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  COMPARISON_PERIOD_KEYS,
  buildUsageFingerprint,
  discoverSessionFiles,
  discoverUsageSources,
  previousUsageRange,

  resolveDateRange,
  streamUsageFileEvents,
  usageComparisonFromAggregates,
} from "./usage-core.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { estimateCostForEvents, estimateEventCost } from "./pricing.js";
import { buildTimelineRows } from "../public/timeline-utils.js";

const STORE_SCHEMA_VERSION = 3;

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.database = null;
    this.homes = [];
    this.warnings = [];
    this.generatedAt = "";
    this.fingerprint = "";
    this.checkedAt = "";
    this.repositoryResolver = createRepositoryResolver();
  }

  async open() {
    if (this.database) {
      return;
    }
    await mkdir(path.dirname(this.databaseFile), { recursive: true });
    this.database = new DatabaseSync(this.databaseFile);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
        repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
        repository_kind TEXT NOT NULL DEFAULT 'unknown',
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_known INTEGER NOT NULL DEFAULT 0,
        request_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_level TEXT NOT NULL DEFAULT 'unknown',
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        price_version TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
    `);
    let version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    const migrate = (sql, nextVersion) => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(sql);
        this.database.exec("PRAGMA user_version = " + nextVersion);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        this.database.close();
        this.database = null;
        throw error;
      }
    };
    if (version === 1) {
      migrate([
        "ALTER TABLE events ADD COLUMN cwd TEXT NOT NULL DEFAULT '';",
        "ALTER TABLE events ADD COLUMN repository_key TEXT NOT NULL DEFAULT 'unknown:cwd';",
        "ALTER TABLE events ADD COLUMN repository_path TEXT NOT NULL DEFAULT 'Unknown cwd';",
        "ALTER TABLE events ADD COLUMN repository_kind TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE events ADD COLUMN detail_mask INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN reconciliation_gap INTEGER NOT NULL DEFAULT 0;",
        "UPDATE events SET cwd = project;",
        "UPDATE source_files SET size = -1, mtime_ms = -1;",
      ].join("\n"), 2);
      version = 2;
    }
    if (version === 2) {
      migrate([
        "ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN cache_write_known INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN request_input_tokens INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN context_level TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE events ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE events ADD COLUMN price_version TEXT NOT NULL DEFAULT '';",
        "UPDATE source_files SET size = -1, mtime_ms = -1;",
      ].join("\n"), STORE_SCHEMA_VERSION);
      version = STORE_SCHEMA_VERSION;
    }
    if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
      this.database.close();
      this.database = null;
      throw new Error("不支持的用量索引版本：" + version);
    }
    if (version === 0) this.database.exec("PRAGMA user_version = " + STORE_SCHEMA_VERSION);
    this.database.exec("CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key)");
    this.generatedAt = this.readMeta("generated_at");
    this.fingerprint = this.readMeta("fingerprint");
  }

  readMeta(key) {
    return this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "";
  }

  writeMeta(key, value) {
    this.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  async usageFiles(homes) {
    const files = [];
    const warnings = [];
    const failedHomes = [];
    for (const home of homes) {
      try {
        if (home.kind === "project-log" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await stat(home.usageLogPath) });
          continue;
        }
        for (const filePath of await discoverSessionFiles(home.path)) {
          files.push({ filePath, source: home, info: await stat(filePath) });
        }
      } catch (error) {
        failedHomes.push({ id: home.id, path: home.path });
        warnings.push(`无法读取 ${home.path}: ${error.message}`);
      }
    }
    return { files, warnings, failedHomes };
  }

  async replaceFile({ filePath, source, info }) {
    const database = this.database;
    const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path, repository_kind,
        detail_mask, reconciliation_gap, cache_write_tokens, cache_write_known, request_input_tokens,
        context_level, service_tier, price_version, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertSource.run(
        filePath,
        source.kind || "codex",
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        new Date().toISOString(),
      );
      database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
      await streamUsageFileEvents(filePath, source, (event) => {
        const date = new Date(event.timestampMs);
        insertEvent.run(
          filePath,
          event.timestampMs,
          event.sessionId,
          event.homeId,
          event.homeLabel,
          event.channel,
          event.project || "Unknown cwd",
          event.model || "Unknown model",
          localHourKey(date),
          localDateKey(date),
          localDateKey(startOfLocalWeek(date)),
          localDateKey(date).slice(0, 7),
          event.project || "",
          event.repositoryKey || "unknown:cwd",
          event.repositoryPath || "Unknown cwd",
          event.repositoryKind || "unknown",
          Number(event.detailMask || 0),
          Number(event.reconciliationGap || 0),
          Number(event.cacheWriteTokens || 0),
          event.cacheWriteKnown ? 1 : 0,
          Number(event.requestInputTokens || 0),
          event.contextLevel || "unknown",
          event.serviceTier || "unknown",
          event.priceVersion || "",
          event.usage.total,
          event.usage.input,
          event.usage.cached,
          event.usage.output,
          event.usage.reasoning,
        );
      }, { repositoryResolver: this.repositoryResolver });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async sync({ options } = {}) {
    await this.open();
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = await discoverUsageSources(syncOptions);

    const status = await buildUsageFingerprint({ ...syncOptions, homes });
    const { files, warnings, failedHomes = [] } = await this.usageFiles(homes);
    const knownFiles = new Set(files.map((file) => file.filePath));
    const failedHomeIds = new Set(failedHomes.map((home) => home.id));
    const failedHomePaths = new Set(failedHomes.map((home) => home.path));
    let updatedFileCount = 0;

    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(file.filePath);
      if (existing && Number(existing.size) === file.info.size && Number(existing.mtime_ms) === file.info.mtimeMs &&
          existing.kind === (file.source.kind || "codex") && existing.home_id === file.source.id &&
          existing.home_label === file.source.label && existing.home_path === file.source.path) {
        continue;
      }
      try {
        await this.replaceFile(file);
        updatedFileCount += 1;
      } catch (error) {
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
      }
    }

    for (const row of this.database.prepare("SELECT path, home_id, home_path FROM source_files").all()) {
      if (!knownFiles.has(row.path) && !failedHomeIds.has(row.home_id) && !failedHomePaths.has(row.home_path)) {
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(row.path);
      }
    }

    this.homes = homes;
    this.warnings = warnings;
    this.generatedAt = new Date().toISOString();
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    this.writeMeta("generated_at", this.generatedAt);
    this.writeMeta("fingerprint", this.fingerprint);
    return { ...status, updatedFileCount };
  }

  metadata() {
    const totals = this.database
      .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
      .get();
    const homeRows = new Map(
      this.database
        .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
        .all()
        .map((row) => [row.home_id, row]),
    );
    return {
      generatedAt: this.generatedAt,
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
      homeCount: this.homes.length,
      homes: this.homes.map((home) => {
        const row = homeRows.get(home.id);
        return {
          ...home,
          status: row ? "active" : "no-events",
          eventCount: Number(row?.event_count || 0),
          sessionCount: Number(row?.session_count || 0),
        };
      }),
      warnings: this.warnings,
    };
  }

  aggregateRange(range) {
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)
      `)
      .get(...rangeParameters(range));
  }

  groupedRange(column, range, orderBy = "total DESC") {
    const allowedColumns = new Set(["channel", "home_label", "model", "project", "hour_key", "day_key", "week_key", "month_key"]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const rows = this.database
      .prepare(`
        SELECT
          ${column} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)
        GROUP BY ${column}
        ORDER BY ${orderBy}
      `)
      .all(...rangeParameters(range));
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  costEstimateRange(range) {
    const statement = this.database.prepare("SELECT model, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning FROM events WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)");
    function* events() {
      for (const row of statement.iterate(...rangeParameters(range))) {
        yield {
          model: row.model,
          detailMask: Number(row.detail_mask || 0),
          cacheWriteTokens: Number(row.cache_write_tokens || 0),
          cacheWriteKnown: Boolean(row.cache_write_known),
          requestInputTokens: Number(row.request_input_tokens || 0),
          contextLevel: row.context_level,
          serviceTier: row.service_tier,
          priceVersion: row.price_version,
          total: usageFromRow(row),
        };
      }
    }
    return estimateCostForEvents(events());
  }

  timelineRange(range, bucket) {
    const statement = this.database.prepare("SELECT timestamp_ms, session_id, channel, model, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning FROM events WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)");
    function* events() {
      for (const row of statement.iterate(...rangeParameters(range))) {
        yield {
          timestamp: Number(row.timestamp_ms),
          sessionId: row.session_id,
          channel: row.channel,
          model: row.model,
          detailMask: Number(row.detail_mask || 0),
          cacheWriteTokens: Number(row.cache_write_tokens || 0),
          cacheWriteKnown: Boolean(row.cache_write_known),
          requestInputTokens: Number(row.request_input_tokens || 0),
          contextLevel: row.context_level,
          serviceTier: row.service_tier,
          priceVersion: row.price_version,
          total: usageFromRow(row),
        };
      }
    }
    return buildTimelineRows(events(), range, bucket, { estimateCost: estimateEventCost });
  }

  repositoriesRange(range) {
    const rows = this.database
      .prepare(`
        SELECT
          repository_key AS key,
          MIN(repository_path) AS name,
          MAX(repository_kind) AS kind,
          COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          json_group_array(DISTINCT session_id) AS session_ids,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)
        GROUP BY repository_key
        ORDER BY total DESC, name ASC
      `)
      .all(...rangeParameters(range));
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind,
      pathCount: Number(row.path_count || 0),
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      sessionIds: JSON.parse(row.session_ids || "[]"),
      total: usageFromRow(row),
    }));
  }

  periodAggregate(groupColumn, nameColumn, now, ranges, { includeKind = false } = {}) {
    const dimensionKey = groupColumn;
    const dimensions = dimensionKey
      ? `${dimensionKey} AS dimension_key, ${includeKind ? `MIN(${nameColumn}) AS dimension_name, MIN(repository_kind) AS dimension_kind, COUNT(DISTINCT NULLIF(cwd, '')) AS path_count` : `${nameColumn} AS dimension_name`},`
      : "";
    const fields = [
      ["total", "total"],
      ["input", "CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"],
      ["inputUnavailableTokens", "CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"],
      ["cached", "CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"],
      ["cachedUnavailableTokens", "CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"],
      ["uncachedInput", "CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"],
      ["uncachedInputUnavailableTokens", "CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"],
      ["cacheRateInput", "CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"],
      ["cacheRateCached", "CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"],
      ["output", "CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"],
      ["outputUnavailableTokens", "CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"],
      ["reasoning", "CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"],
      ["reasoningUnavailableTokens", "CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"],
      ["unattributedDetailTokens", "CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"],
      ["inconsistentTokens", "CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"],
      ["reconciliationGap", "reconciliation_gap"],
    ];
    const parameters = [];
    const measures = [];
    for (const period of COMPARISON_PERIOD_KEYS) {
      for (const [field, expression] of fields) {
        measures.push(
          `COALESCE(SUM(CASE WHEN (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?) THEN ${expression} ELSE 0 END), 0) AS "${period}__${field}"`,
        );
        parameters.push(...rangeParameters(ranges[period]));
      }
    }
    const select = `SELECT ${dimensions} ${measures.join(", ")} FROM events`;
    const groupBy = dimensionKey ? ` GROUP BY ${dimensionKey}` : "";
    const orderBy = dimensionKey ? " ORDER BY all__total DESC, dimension_name ASC" : "";
    const rows = this.database.prepare(`${select}${groupBy}${orderBy}`).all(...parameters);
    return rows.map((row) => {
      const result = {
        key: dimensionKey ? String(row.dimension_key) : "all",
        name: dimensionKey ? String(row.dimension_name) : "全部",
        periods: Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => [
            period,
            Object.fromEntries(fields.map(([field]) => [field, Number(row[`${period}__${field}`] || 0)])),
          ]),
        ),
      };
      if (includeKind) {
        result.kind = row.dimension_kind;
        result.pathCount = Number(row.path_count || 0);
      }

      return result;
    });
  }

  periodComparison(options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const bounds = this.database.prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events").get();
    const timestamps = bounds.minimum === null
      ? []
      : [
          { timestamp: new Date(Number(bounds.minimum)).toISOString() },
          { timestamp: new Date(Number(bounds.maximum)).toISOString() },
        ];
    const ranges = Object.fromEntries(
      COMPARISON_PERIOD_KEYS.map((key) => [key, resolveDateRange({ preset: key, now }, timestamps)]),
    );
    return {
      asOf: now.toISOString(),
      periods: COMPARISON_PERIOD_KEYS.map((key) => ({
        key,
        start: ranges[key].start?.toISOString() || null,
        end: ranges[key].end?.toISOString() || null,
      })),
      totals: this.periodAggregate(null, null, now, ranges)[0].periods,
      models: this.periodAggregate("model", "model", now, ranges),
      repositories: this.periodAggregate("repository_key", "repository_path", now, ranges, {
        includeKind: true,
      }),
    };
  }

  summarize(filters = {}) {
    const bounds = this.database.prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events").get();
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange(filters, boundaryEvents);
    const aggregate = this.aggregateRange(range);
    const totals = usageFromRow(aggregate);
    const previousRange = previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange) : null;
    const comparison = usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: filters.now ? new Date(filters.now) : new Date(),
    });
    const bucket = filters.bucket || "day";
    return {
      generatedAt: this.generatedAt,
      range: {
        preset: range.preset,
        start: range.start ? range.start.toISOString() : null,
        end: range.end ? range.end.toISOString() : null,
        bucket,
        rolling: Boolean(range.rolling),
      },
      totals,
      comparison,
      costEstimate: this.costEstimateRange(range),
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline: this.timelineRange(range, bucket),
      channels: this.groupedRange("channel", range),
      homes: this.groupedRange("home_label", range),
      models: this.groupedRange("model", range),
      projects: this.groupedRange("project", range),
      repositories: this.repositoriesRange(range),
    };
  }

  close() {
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }
}

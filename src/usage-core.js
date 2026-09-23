import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { createRepositoryResolver } from "./repository-identity.js";
import { estimateCostForEvents, estimateEventCost, LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { buildTimelineRows } from "../public/timeline-utils.js";

const SESSION_DIRS = ["sessions", "archived_sessions"];
const PROJECT_USAGE_DIR = ".codex-usage";
const PROJECT_USAGE_FILE = "usage.jsonl";
const PROJECT_LOG_SCHEMA_VERSION = "codex-usage.project-log.v1";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE_FIELDS = [
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
];
export const USAGE_DETAIL_MASK = Object.freeze({ input: 1, cached: 2, output: 4, reasoning: 8, complete: 15, cacheWrite: 32 });
const USAGE_DETAIL_INCONSISTENT = 16;
const USAGE_DETAIL_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

export function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function usageFromRaw(raw = {}) {
  return {
    total: Number(raw.total_tokens || 0),
    input: Number(raw.input_tokens || 0),
    cached: Number(raw.cached_input_tokens || 0),
    output: Number(raw.output_tokens || 0),
    reasoning: Number(raw.reasoning_output_tokens || 0),
  };
}

function readCacheWrite(raw = {}) {
  const value = raw.cache_write_input_tokens;
  const known = Object.hasOwn(raw, "cache_write_input_tokens") && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
  return { tokens: known ? Number(value) : 0, known };
}

function readServiceTier(row = {}, payload = {}) {
  const values = [
    row.service_tier,
    payload.service_tier,
    payload.info?.service_tier,
    payload.response?.service_tier,
    payload.info?.response?.service_tier,
  ];
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value ? value.trim().toLowerCase() : "unknown";
}

function lastUsageMatchesDelta(last, lastMask, delta, deltaMask) {
  const required = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.output;
  if ((lastMask & required) !== required || (deltaMask & required) !== required) return false;
  for (const [field, bit] of [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ]) {
    if ((lastMask & bit) && (!(deltaMask & bit) || last[field] !== delta[field])) return false;
  }
  return true;
}

function cacheWriteForEvent({ cumulative, previous, last, lastMatches }) {
  if (!cumulative) return last || { tokens: 0, known: false };
  const hasDelta = cumulative.known && previous.known;
  const deltaTokens = hasDelta ? Math.max(0, cumulative.tokens - previous.tokens) : 0;
  if (lastMatches && last?.known) {
    if (hasDelta && deltaTokens !== last.tokens) return { tokens: 0, known: false };
    return last;
  }
  return hasDelta ? { tokens: deltaTokens, known: true } : { tokens: 0, known: false };
}

function contextForEvent(matches, usage, mask) {
  if (!matches || !(mask & USAGE_DETAIL_MASK.input)) return { requestInputTokens: 0, contextLevel: "unknown" };
  return {
    requestInputTokens: usage.input,
    contextLevel: usage.input > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short",
  };
}

function usageDetailMask(raw = {}, keys = USAGE_DETAIL_KEYS) {
  return keys.reduce((mask, key, index) => {
    const value = raw[key];
    const known = Object.hasOwn(raw, key) && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    return known ? mask | (1 << index) : mask;
  }, 0);
}

function projectLogDetailMask(raw = {}) {
  const has = (...keys) =>
    keys.some((key) => {
      const value = raw[key];
      return Object.hasOwn(raw, key) && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    });
  return (
    (has("input", "input_tokens") ? USAGE_DETAIL_MASK.input : 0) |
    (has("cached", "cached_input_tokens") ? USAGE_DETAIL_MASK.cached : 0) |
    (has("output", "output_tokens") ? USAGE_DETAIL_MASK.output : 0) |
    (has("reasoning", "reasoning_output_tokens") ? USAGE_DETAIL_MASK.reasoning : 0)
  );
}

function validateUsageDetails(usage, detailMask) {
  let gap = 0;
  let mask = detailMask;
  const inputKnown = Boolean(mask & USAGE_DETAIL_MASK.input);
  const cachedKnown = Boolean(mask & USAGE_DETAIL_MASK.cached);
  const outputKnown = Boolean(mask & USAGE_DETAIL_MASK.output);
  const reasoningKnown = Boolean(mask & USAGE_DETAIL_MASK.reasoning);
  if (usage.total > 0 && inputKnown && outputKnown && usage.input === 0 && usage.output === 0) {
    return {
      detailMask: (mask & ~USAGE_DETAIL_MASK.complete) | USAGE_DETAIL_INCONSISTENT,
      reconciliationGap: usage.total,
    };
  }
  if (inputKnown && cachedKnown && usage.cached > usage.input) {
    gap += usage.cached - usage.input;
    mask &= ~USAGE_DETAIL_MASK.cached;
  }
  if (inputKnown && outputKnown && usage.total !== usage.input + usage.output) {
    gap += Math.abs(usage.total - usage.input - usage.output);
  }
  if (outputKnown && reasoningKnown && usage.reasoning > usage.output) {
    gap += usage.reasoning - usage.output;
    mask &= ~USAGE_DETAIL_MASK.reasoning;
  }
  if (gap > 0) {
    mask |= USAGE_DETAIL_INCONSISTENT;
  }
  return { detailMask: mask, reconciliationGap: gap };
}

function addUsage(target, usage) {
  for (const field of USAGE_FIELDS) {
    target[field] += usage[field] || 0;
  }
  return target;
}

function diffUsage(current, previous, currentMask = USAGE_DETAIL_MASK.complete, previousMask = USAGE_DETAIL_MASK.complete) {
  const diff = emptyUsage();
  diff.total = Math.max(0, (current.total || 0) - (previous.total || 0));
  let detailMask = 0;
  for (const [field, bit] of [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ]) {
    if ((currentMask & bit) && (previousMask & bit)) {
      diff[field] = Math.max(0, (current[field] || 0) - (previous[field] || 0));
      detailMask |= bit;
    }
  }
  return { usage: diff, detailMask };
}

function isZeroUsage(usage) {
  return USAGE_FIELDS.every((field) => !usage[field]);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeId(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function codexHomeLooksUsable(homePath) {
  const checks = await Promise.all([
    exists(path.join(homePath, "sessions")),
    exists(path.join(homePath, "archived_sessions")),
    exists(path.join(homePath, "state_5.sqlite")),
  ]);
  return checks.some(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const candidate of paths.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function optionImportDirs(options = {}) {
  const env = options.env || process.env;
  const configured = [];
  if (Array.isArray(options.importDirs)) {
    configured.push(...options.importDirs);
  } else if (typeof options.importDirs === "string") {
    configured.push(...options.importDirs.split(path.delimiter));
  }
  if (env.CODEX_USAGE_IMPORT_DIRS) {
    configured.push(...env.CODEX_USAGE_IMPORT_DIRS.split(path.delimiter));
  }
  return uniquePaths(configured);
}

export async function classifyImportDirectory(importPath) {
  const resolved = path.resolve(importPath);
  if (await codexHomeLooksUsable(resolved)) {
    return {
      type: "codex-home",
      path: resolved,
    };
  }

  const directUsageLogPath = path.join(resolved, PROJECT_USAGE_FILE);
  if (path.basename(resolved) === PROJECT_USAGE_DIR && (await exists(directUsageLogPath))) {
    return {
      type: "project-log",
      path: path.dirname(resolved),
      usageLogPath: directUsageLogPath,
    };
  }

  const usageLogPath = path.join(resolved, PROJECT_USAGE_DIR, PROJECT_USAGE_FILE);
  if (await exists(usageLogPath)) {
    return {
      type: "project-log",
      path: resolved,
      usageLogPath,
    };
  }

  return {
    type: "unsupported",
    path: resolved,
    reason: `目录需要是 Codex home，或包含 ${PROJECT_USAGE_DIR}/${PROJECT_USAGE_FILE}`,
  };
}

function jetBrainsRoots({ homeDir, platform, env }) {
  const roots = [path.join(homeDir, "Library", "Caches", "JetBrains")];

  if (platform === "win32") {
    roots.push(
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "JetBrains") : "",
      env.APPDATA ? path.join(env.APPDATA, "JetBrains") : "",
      path.join(homeDir, "AppData", "Local", "JetBrains"),
      path.join(homeDir, "AppData", "Roaming", "JetBrains"),
    );
  }

  return uniquePaths(roots);
}

export async function discoverCodexHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || os.platform();
  const envHomes = options.extraHomes || env.CODEX_USAGE_HOMES || "";
  const homes = [];
  const seen = new Set();

  async function addHome(label, homePath, kind = "codex") {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await codexHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: normalizeId(`${kind}-${label}-${homes.length + 1}`),
      label,
      path: resolved,
      kind,
    });
  }

  await addHome("Main Codex", path.join(homeDir, ".codex"), "main");

  for (const jetbrainsRoot of jetBrainsRoots({ homeDir, platform, env })) {
    if (!(await exists(jetbrainsRoot))) {
      continue;
    }
    for (const entry of await readdir(jetbrainsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const productName = entry.name;
      await addHome(
        `JetBrains ${productName}`,
        path.join(jetbrainsRoot, productName, "aia", "codex"),
        "jetbrains",
      );
    }
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Extra ${path.basename(extraHome)}`, extraHome, "extra");
  }

  return homes;
}

export async function discoverUsageSources(options = {}) {
  const sources = await discoverCodexHomes(options);
  const seenPaths = new Set(sources.map((source) => source.path));
  const seenProjectLogs = new Set();

  for (const importDir of optionImportDirs(options)) {
    const classified = await classifyImportDirectory(importDir);
    if (classified.type === "codex-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: normalizeId(`extra-${path.basename(classified.path) || "codex"}-${sources.length + 1}`),
        label: `Imported ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "extra",
        imported: true,
      });
      continue;
    }

    if (classified.type !== "project-log") {
      continue;
    }

    if (seenProjectLogs.has(classified.usageLogPath)) {
      continue;
    }
    seenProjectLogs.add(classified.usageLogPath);
    sources.push({
      id: normalizeId(`project-log-${path.basename(classified.path) || "project"}-${sources.length + 1}`),
      label: `Project ${path.basename(classified.path) || classified.path}`,
      path: classified.path,
      kind: "project-log",
      usageLogPath: classified.usageLogPath,
      imported: true,
    });
  }

  return sources;
}

async function walkJsonlFiles(root, files = []) {
  if (!(await exists(root))) {
    return files;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".tmp" || entry.name === "node_modules") {
        continue;
      }
      await walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverSessionFiles(homePath) {
  const groups = await Promise.all(
    SESSION_DIRS.map((dir) => walkJsonlFiles(path.join(homePath, dir), [])),
  );
  return groups.flat().sort();
}

export async function buildUsageFingerprint(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const hash = createHash("sha256");
  let fileCount = 0;

  for (const home of homes) {
    hash.update(`${home.id}\t${home.label}\t${home.path}\t${home.kind || ""}\t${home.usageLogPath || ""}\n`);
    if (home.kind === "project-log" && home.usageLogPath) {
      const info = await stat(home.usageLogPath);
      fileCount += 1;
      hash.update(`${home.usageLogPath}\t${info.size}\t${info.mtimeMs}\n`);
      continue;
    }
    const files = await discoverSessionFiles(home.path);
    for (const file of files) {
      const info = await stat(file);
      fileCount += 1;
      hash.update(`${file}\t${info.size}\t${info.mtimeMs}\n`);
    }
  }

  return {
    fingerprint: hash.digest("hex"),
    fileCount,
    homeCount: homes.length,
    checkedAt: new Date().toISOString(),
  };
}

export function classifyChannel({ originator, source, homeLabel }) {
  const text = `${originator || ""} ${source || ""} ${homeLabel || ""}`.toLowerCase();
  if (text.includes("jetbrains")) {
    return "JetBrains PyCharm";
  }
  if (text.includes("codex desktop")) {
    return "Codex Desktop";
  }
  if (source === "cli" || text.includes("codex-tui") || text.includes("codex_cli")) {
    return "CLI";
  }
  if (source === "exec" || text.includes("codex_exec")) {
    return "Codex Exec";
  }
  if (source === "vscode") {
    return "Editor Integration";
  }
  return originator || source || homeLabel || "Unknown";
}

function fallbackSessionId(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base.replace(/^rollout-/, "") || filePath;
}

function readTokenUsage(payload, row = {}) {
  const info = payload?.info || {};
  const cumulativeRaw = info.total_token_usage;
  const lastRaw = info.last_token_usage;
  const cumulative = cumulativeRaw ? usageFromRaw(cumulativeRaw) : null;
  const last = lastRaw ? usageFromRaw(lastRaw) : null;
  return {
    cumulative,
    cumulativeMask: cumulativeRaw ? usageDetailMask(cumulativeRaw) : 0,
    cumulativeCacheWrite: readCacheWrite(cumulativeRaw),
    last,
    lastMask: lastRaw ? usageDetailMask(lastRaw) : 0,
    lastCacheWrite: readCacheWrite(lastRaw),
    serviceTier: readServiceTier(row, payload),
  };
}

export async function parseSessionFile(filePath, home, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const threadNames = options.threadNames || new Map();
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
    cliVersion: "",
    modelProvider: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };
  let finalUsage = emptyUsage();
  let tokenEventCount = 0;
  const events = [];

  // Stream JSONL rows so full-detail reports do not read large session files at once.
  for await (const row of readJsonlRows(filePath)) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      meta.cliVersion = row.payload?.cli_version || meta.cliVersion;
      meta.modelProvider = row.payload?.model_provider || meta.modelProvider;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } = readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      increment = diff.usage;
      detailMask = diff.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({ cumulative: cumulativeCacheWrite, previous: previousCumulativeCacheWrite, last: lastCacheWrite, lastMatches: lastMatchesDelta });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
      finalUsage = cumulative;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
      addUsage(finalUsage, last);
    }
    const context = contextForEvent(lastMatchesDelta, increment, detailMask);

    if (isZeroUsage(increment)) {
      continue;
    }

    tokenEventCount += 1;
    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const repository = await resolveRepository(meta.cwd);
    const detailValidation = validateUsageDetails(increment, detailMask);
    events.push({
      id: `${meta.id}:${tokenEventCount}`,
      sessionId: meta.id,
      timestamp: row.timestamp || lastAt || firstAt,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      conversationName: threadNames.get(meta.id) || "",
      model,
      total: increment,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier,
      priceVersion: pricingVersionForTimestamp(row.timestamp || lastAt || firstAt),
    });
  }

  if (!events.length) {
    return null;
  }

  const channel = classifyChannel({
    originator: meta.originator,
    source: meta.source,
    homeLabel: home.homeLabel || home.label,
  });

  return {
    session: {
      id: meta.id,
      filePath,
      firstAt,
      lastAt,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      conversationName: threadNames.get(meta.id) || "",
      model,
      cliVersion: meta.cliVersion,
      modelProvider: meta.modelProvider,
      eventCount: events.length,
      total: finalUsage,
    },
    events,
  };
}

async function* readJsonlRows(filePath) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore malformed JSONL rows from interrupted writes.
    }
  }
}

export async function readSessionThreadNames(homePath) {
  const threadNames = new Map();
  const indexPath = path.join(homePath, "session_index.jsonl");
  if (!(await exists(indexPath))) {
    return threadNames;
  }
  try {
    for await (const row of readJsonlRows(indexPath)) {
      const id = String(row.id || "").trim();
      const name = String(row.thread_name || "").trim();
      if (id && name) {
        threadNames.set(id, name);
      }
    }
  } catch {
    // Thread names are optional metadata; usage aggregation must still work if the index is unreadable.
  }
  return threadNames;
}

function usageFromProjectLog(raw = {}) {
  const usage = raw || {};
  const input = Number(usage.input ?? usage.input_tokens ?? 0);
  const cached = Number(usage.cached ?? usage.cached_input_tokens ?? 0);
  const output = Number(usage.output ?? usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoning ?? usage.reasoning_output_tokens ?? 0);
  const total = Number(usage.total ?? usage.total_tokens ?? input + output);
  return { total, input, cached, output, reasoning };
}

function projectLogTimestamp(row) {
  return row.timestamp || row.created_at || row.createdAt || "";
}

function projectLogSource(row) {
  return row.source || "project-log";
}

function projectLogChannel(row) {
  if (row.channel) {
    return row.channel;
  }
  return projectLogSource(row) === "codex-oauth" ? "Codex OAuth" : "Project Log";
}

function projectLogUsage(row) {
  return usageFromProjectLog(row.usage || row.token_usage || row.total_token_usage || {});
}

function projectLogSessionId(row, source, rowNumber) {
  return row.session_id || row.sessionId || row.request_id || row.requestId || `${source.id}:${rowNumber}`;
}

function isSupportedProjectLogRow(row) {
  return !row.schema_version || row.schema_version === PROJECT_LOG_SCHEMA_VERSION;
}

async function parseProjectUsageLogFile(filePath, source, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const sessions = new Map();
  const events = [];
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const rawUsage = row.usage || row.token_usage || row.total_token_usage || {};
    const usage = projectLogUsage(row);
    const cacheWrite = readCacheWrite(rawUsage);
    const detailMask = projectLogDetailMask(rawUsage);
    const requestLinked = Boolean(row.request_id || row.requestId || row.response_id || row.responseId);
    const context = contextForEvent(requestLinked, usage, detailMask);
    if (isZeroUsage(usage)) {
      continue;
    }

    const sessionId = projectLogSessionId(row, source, rowNumber);
    const sourceName = projectLogSource(row);
    const channel = projectLogChannel(row);
    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const repository = await resolveRepository(cwd);
    const model = row.model || "Unknown model";
    const detailValidation = validateUsageDetails(usage, detailMask);
    const event = {
      id: row.event_id || row.eventId || row.request_id || row.requestId || `${sessionId}:${events.length + 1}`,
      sessionId,
      timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model,
      total: usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier: readServiceTier(row, rawUsage),
      priceVersion: pricingVersionForTimestamp(timestamp),
    };
    events.push(event);

    const session = sessions.get(sessionId) || {
      id: sessionId,
      filePath,
      firstAt: timestamp,
      lastAt: timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      model,
      cliVersion: "",
      modelProvider: "",
      eventCount: 0,
      total: emptyUsage(),
    };
    if (time < Date.parse(session.firstAt)) {
      session.firstAt = timestamp;
    }
    if (time > Date.parse(session.lastAt)) {
      session.lastAt = timestamp;
    }
    session.eventCount += 1;
    session.model = model;
    addUsage(session.total, usage);
    sessions.set(sessionId, session);
  }

  return {
    sessions: [...sessions.values()],
    events,
  };
}

function createStringInterner() {
  const values = [];
  const ids = new Map();
  return {
    values,
    intern(value) {
      const text = value || "";
      const existing = ids.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const id = values.length;
      ids.set(text, id);
      values.push(text);
      return id;
    },
  };
}

async function streamSessionUsageFileEvents(filePath, home, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };

  for await (const row of readJsonlRows(filePath)) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } = readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      increment = diff.usage;
      detailMask = diff.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({ cumulative: cumulativeCacheWrite, previous: previousCumulativeCacheWrite, last: lastCacheWrite, lastMatches: lastMatchesDelta });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
    }
    const context = contextForEvent(lastMatchesDelta, increment, detailMask);

    if (isZeroUsage(increment)) {
      continue;
    }

    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const timestamp = row.timestamp || lastAt || firstAt;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    const repository = await resolveRepository(meta.cwd);
    const detailValidation = validateUsageDetails(increment, detailMask);
    await onEvent({
      timestampMs,
      sessionId: meta.id,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      channel,
      project: meta.cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model,
      usage: increment,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier,
      priceVersion: pricingVersionForTimestamp(timestamp),
    });
  }
}

async function streamProjectUsageFileEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const rawUsage = row.usage || row.token_usage || row.total_token_usage || {};
    const usage = projectLogUsage(row);
    const cacheWrite = readCacheWrite(rawUsage);
    const detailMask = projectLogDetailMask(rawUsage);
    const requestLinked = Boolean(row.request_id || row.requestId || row.response_id || row.responseId);
    const context = contextForEvent(requestLinked, usage, detailMask);
    if (isZeroUsage(usage)) {
      continue;
    }

    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const repository = await resolveRepository(cwd);
    const detailValidation = validateUsageDetails(usage, detailMask);
    await onEvent({
      timestampMs: time,
      sessionId: projectLogSessionId(row, source, rowNumber),
      homeId: source.id,
      homeLabel: source.label,
      channel: projectLogChannel(row),
      project: cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model: row.model || "Unknown model",
      usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier: readServiceTier(row, row),
      priceVersion: pricingVersionForTimestamp(timestamp),
    });
  }
}

export async function streamUsageFileEvents(filePath, source, onEvent, options = {}) {
  if (source.kind === "project-log") {
    await streamProjectUsageFileEvents(filePath, source, onEvent, options);
    return;
  }
  await streamSessionUsageFileEvents(filePath, source, onEvent, options);
}

async function parseSessionFileForIndex(filePath, home, intern, resolveRepository) {
  const events = [];
  await streamSessionUsageFileEvents(filePath, home, (event) => {
    events.push({
      t: event.timestampMs,
      s: intern(event.sessionId),
      h: intern(event.homeId),
      l: intern(event.homeLabel),
      c: intern(event.channel),
      p: intern(event.project),
      rk: intern(event.repositoryKey),
      rp: intern(event.repositoryPath),
      rt: intern(event.repositoryKind),
      m: intern(event.model),
      total: event.usage.total,
      input: event.usage.input,
      cached: event.usage.cached,
      output: event.usage.output,
      reasoning: event.usage.reasoning,
      detailMask: event.detailMask,
      reconciliationGap: event.reconciliationGap,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: intern(event.contextLevel),
      serviceTier: intern(event.serviceTier),
      priceVersion: intern(event.priceVersion),
    });
  }, { repositoryResolver: resolveRepository });
  return events;
}

async function parseProjectUsageLogFileForIndex(filePath, source, intern, resolveRepository) {
  const events = [];
  await streamProjectUsageFileEvents(filePath, source, (event) => {
    events.push({
      t: event.timestampMs,
      s: intern(event.sessionId),
      h: intern(event.homeId),
      l: intern(event.homeLabel),
      c: intern(event.channel),
      p: intern(event.project),
      rk: intern(event.repositoryKey),
      rp: intern(event.repositoryPath),
      rt: intern(event.repositoryKind),
      m: intern(event.model),
      total: event.usage.total,
      input: event.usage.input,
      cached: event.usage.cached,
      output: event.usage.output,
      reasoning: event.usage.reasoning,
      detailMask: event.detailMask,
      reconciliationGap: event.reconciliationGap,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: intern(event.contextLevel),
      serviceTier: intern(event.serviceTier),
      priceVersion: intern(event.priceVersion),
    });
  }, { repositoryResolver: resolveRepository });
  return events;
}

export async function buildUsageReport(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const repositoryResolver = createRepositoryResolver();
  const sessions = [];
  const events = [];
  const warnings = [];

  for (const home of homes) {
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        const parsed = await parseProjectUsageLogFile(home.usageLogPath, home, { repositoryResolver });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    const threadNames = await readSessionThreadNames(home.path);
    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSessionFile(file, home, { repositoryResolver, threadNames });
        if (!parsed) {
          continue;
        }
        sessions.push(parsed.session);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  sessions.sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));

  return {
    generatedAt: new Date().toISOString(),
    homes,
    sessions,
    events,
    warnings,
  };
}

export async function buildUsageIndex(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const repositoryResolver = createRepositoryResolver();
  const warnings = [];
  const events = [];
  const interner = createStringInterner();

  for (const home of homes) {
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        events.push(...(await parseProjectUsageLogFileForIndex(home.usageLogPath, home, interner.intern, repositoryResolver)));
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        events.push(...(await parseSessionFileForIndex(file, home, interner.intern, repositoryResolver)));
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  events.sort((a, b) => a.t - b.t);

  return {
    generatedAt: new Date().toISOString(),
    homes,
    warnings,
    strings: interner.values,
    events,
    sessionCount: new Set(events.map((event) => event.s)).size,
  };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfLocalWeek(date) {
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDateStart(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

function parseDateEnd(value) {
  return value ? new Date(`${value}T23:59:59.999`) : null;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function parseRecentValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now) {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  if (parsed.days === 1) {
    return {
      start: new Date(now.getTime() - MS_PER_DAY),
      end: now,
      preset: "recent",
      rolling: true,
    };
  }
  const start = parsed.days
    ? addLocalDays(startOfLocalDay(now), 1 - parsed.days)
    : startOfLocalDay(subtractMonthsClamped(now, parsed.months));
  return {
    start,
    end: endOfLocalDay(now),
    preset: "recent",
  };
}

export function resolveDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
  );
}

function resolveDateRangeFromTimestamps(filters = {}, timestamps = []) {
  // Report and index summaries share this resolver to avoid date-range drift.
  const now = filters.now ? new Date(filters.now) : new Date();
  const preset = filters.preset || "all";
  if (preset === "today") {
    return { start: startOfLocalDay(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "week") {
    return { start: startOfLocalWeek(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfLocalDay(now),
      preset,
    };
  }
  if (preset === "custom") {
    return {
      start: parseDateStart(filters.startDate),
      end: parseDateEnd(filters.endDate),
      preset,
    };
  }
  if (preset === "recent") {
    const range = recentDateRange(filters.recentValue, now);
    if (range) {
      return range;
    }
  }

  if (!timestamps.length) {
    return { start: null, end: null, preset: "all" };
  }
  let earliestTimestamp = timestamps[0];
  let latestTimestamp = timestamps[0];
  for (const timestamp of timestamps) {
    if (timestamp < earliestTimestamp) {
      earliestTimestamp = timestamp;
    }
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }
  return {
    start: startOfLocalDay(new Date(earliestTimestamp)),
    end: endOfLocalDay(new Date(latestTimestamp)),
    preset: "all",
  };
}

function groupByUsage(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.sessionId);
    addUsage(current.total, event.total);
    if (current.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function groupRepositories(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: event.repositoryPath || event.cwd || "Unknown cwd",
      count: 0,
      sessions: new Set(),
      pathCount: 0,
      pathSet: new Set(),
      kind: event.repositoryKind || "directory",
      total: emptyUsage(),
    };
    const repositoryPath = event.repositoryPath || event.cwd || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(event.sessionId);
    if (event.cwd) {
      group.pathSet.add(event.cwd);
    }
    addUsage(group.total, event.total);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return {
        ...row,
        sessions: sessions.size,
        sessionIds: [...sessions],
        pathCount: pathSet.size,
      };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function indexDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => event.t).filter(Number.isFinite),
  );
}

function addIndexedUsage(target, event) {
  for (const field of USAGE_FIELDS) {
    target[field] += event[field] || 0;
  }
  return target;
}

function groupIndexedEvents(index, events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event) || "Unknown";
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.s);
    addIndexedUsage(current.total, event);
    if (current.channelGroups) {
      const channelKey = index.strings[event.c] || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.s);
      addIndexedUsage(channel.total, event);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function groupIndexedRepositories(index, events) {
  const groups = new Map();
  for (const event of events) {
    const strings = index.strings;
    const key = strings[event.rk] || `directory:${strings[event.p] || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: strings[event.rp] || strings[event.p] || "Unknown cwd",
      kind: strings[event.rt] || "directory",
      count: 0,
      sessions: new Set(),
      pathSet: new Set(),
      total: emptyUsage(),
    };
    const repositoryPath = strings[event.rp] || strings[event.p] || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(event.s);
    const cwd = strings[event.p];
    if (cwd) {
      group.pathSet.add(cwd);
    }
    addIndexedUsage(group.total, event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return {
        ...row,
        sessions: sessions.size,
        sessionIds: [...sessions].map((sessionId) => index.strings[sessionId] || String(sessionId)),
        pathCount: pathSet.size,
      };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function usageIndexMetadata(index) {
  const homeStats = homeStatsFromIndex(index);
  return {
    generatedAt: index.generatedAt,
    eventCount: index.events.length,
    sessionCount: index.sessionCount,
    homeCount: index.homes.length,
    homes: index.homes.map((home) => ({
      ...home,
      ...(homeStats.get(home.id) || {
        status: "no-events",
        eventCount: 0,
        sessionCount: 0,
      }),
    })),
    warnings: index.warnings,
  };
}

function homeStatsFromIndex(index) {
  // Attach per-home activity counts without expanding the compact index into full events.
  const stats = new Map();
  for (const event of index.events) {
    const homeId = index.strings[event.h] || "";
    const current = stats.get(homeId) || {
      status: "active",
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.s);
    stats.set(homeId, current);
  }
  return new Map(
    [...stats.entries()].map(([homeId, stat]) => [
      homeId,
      {
        status: stat.eventCount > 0 ? "active" : "no-events",
        eventCount: stat.eventCount,
        sessionCount: stat.sessions.size,
      },
    ]),
  );
}

export function previousUsageRange(range) {
  if (!range.start || !range.end || range.preset === "all") {
    return null;
  }
  if (range.preset === "today") {
    const previousDay = addLocalDays(startOfLocalDay(range.start), -1);
    return {
      start: previousDay,
      end: endOfLocalDay(previousDay),
    };
  }
  if (range.preset === "week") {
    const previousWeekStart = addLocalDays(startOfLocalWeek(range.start), -7);
    return {
      start: previousWeekStart,
      end: endOfLocalDay(addLocalDays(previousWeekStart, 6)),
    };
  }
  if (range.preset === "month") {
    const currentMonthStart = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: endOfLocalDay(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0)),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  if (!range?.start || !range?.end) {
    return 0;
  }
  return Math.max(0, range.end.getTime() - range.start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  if (!range?.start || !range?.end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(range.end.getTime(), Math.max(range.start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - range.start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function comparisonLabel(preset) {
  return {
    today: "较昨日",
    week: "较上周",
    month: "较上月",
    custom: "较上一等长周期",
    recent: "较上一等长周期",
  }[preset] || "暂无对比";
}

function usageComparison({ range, allEvents, eventTime, eventSession, addEventUsage, currentTotals, now }) {
  // 保持调用方事件结构不变，只在这里统一计算上一周期和趋势。
  const previousRange = previousUsageRange(range);
  if (!previousRange) {
    return usageComparisonFromAggregates({ range, currentTotals, now });
  }
  const previousEvents = allEvents.filter((event) => {
    const time = eventTime(event);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addEventUsage(sum, event), emptyUsage());
  const previousSessions = new Set(previousEvents.map(eventSession));
  return usageComparisonFromAggregates({
    range,
    currentTotals,
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: previousSessions.size,
    now,
  });
}

export function usageComparisonFromAggregates({
  range,
  currentTotals,
  previousTotals = emptyUsage(),
  previousEventCount = 0,
  previousSessionCount = 0,
  now,
}) {
  const previousRange = previousUsageRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(range.preset),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);

  return {
    label: comparisonLabel(range.preset),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount,
    previousSessionCount,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

export const COMPARISON_PERIOD_KEYS = ["today", "week", "month", "all"];

function emptyPeriodMetrics() {
  return {
    total: 0,
    input: 0,
    inputUnavailableTokens: 0,
    cached: 0,
    cachedUnavailableTokens: 0,
    uncachedInput: 0,
    uncachedInputUnavailableTokens: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    output: 0,
    outputUnavailableTokens: 0,
    reasoning: 0,
    reasoningUnavailableTokens: 0,
    unattributedDetailTokens: 0,
    inconsistentTokens: 0,
    reconciliationGap: 0,
  };
}

function addPeriodEvent(target, event) {
  const usage = event.total || emptyUsage();
  const total = Number(usage.total || 0);
  const mask = Number.isInteger(event.detailMask) ? event.detailMask : USAGE_DETAIL_MASK.complete;
  target.total += total;
  if (mask & USAGE_DETAIL_MASK.input) {
    target.input += Number(usage.input || 0);
  } else {
    target.inputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.cached) {
    target.cached += Number(usage.cached || 0);
  } else {
    target.cachedUnavailableTokens += total;
  }
  if ((mask & (USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached)) === (USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached)) {
    target.uncachedInput += Math.max(0, Number(usage.input || 0) - Number(usage.cached || 0));
    target.cacheRateInput += Number(usage.input || 0);
    target.cacheRateCached += Number(usage.cached || 0);
  } else {
    target.uncachedInputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.output) {
    target.output += Number(usage.output || 0);
  } else {
    target.outputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.reasoning) {
    target.reasoning += Number(usage.reasoning || 0);
  } else {
    target.reasoningUnavailableTokens += total;
  }
  if ((mask & USAGE_DETAIL_MASK.complete) !== USAGE_DETAIL_MASK.complete) {
    target.unattributedDetailTokens += total;
  }
  if (mask & USAGE_DETAIL_INCONSISTENT) {
    target.inconsistentTokens += total;
  }
  target.reconciliationGap += Number(event.reconciliationGap || 0);
}

function comparisonRow(map, key, name, event, periodKeys, { includeRepositoryMetadata = false } = {}) {
  let row = map.get(key);
  if (!row) {
    row = {
      key,
      name,
      ...(includeRepositoryMetadata
        ? { kind: event.repositoryKind || "directory", pathSet: new Set() }
        : {}),
      periods: Object.fromEntries(periodKeys.map((period) => [period, emptyPeriodMetrics()])),
    };
    map.set(key, row);
  } else if (includeRepositoryMetadata && name < row.name) {
    row.name = name;
  }
  if (includeRepositoryMetadata && event.cwd) {
    row.pathSet.add(event.cwd);
  }

  return row;
}

export function summarizePeriodComparison(events = [], options = {}) {
  const asOf = options.now ? new Date(options.now) : new Date();
  const timestamps = events
    .map((event) => ({ timestamp: event.timestamp }))
    .filter((event) => Number.isFinite(Date.parse(event.timestamp)));
  const ranges = Object.fromEntries(
    COMPARISON_PERIOD_KEYS.map((key) => [key, resolveDateRange({ preset: key, now: asOf }, timestamps)]),
  );
  const rows = { models: new Map(), repositories: new Map() };
  const totals = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()]));

  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const modelKey = event.model || "Unknown model";
    const repositoryKey = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const modelRow = comparisonRow(rows.models, modelKey, modelKey, event, COMPARISON_PERIOD_KEYS);
    const repositoryRowKey = repositoryKey;
    const repositoryName = event.repositoryPath || event.cwd || "Unknown cwd";
    const repositoryRow = comparisonRow(rows.repositories, repositoryRowKey, repositoryName, event, COMPARISON_PERIOD_KEYS, {
      includeRepositoryMetadata: true,
    });

    for (const period of COMPARISON_PERIOD_KEYS) {
      const range = ranges[period];
      if ((range.start && timestamp < range.start.getTime()) || (range.end && timestamp > range.end.getTime())) {
        continue;
      }
      addPeriodEvent(totals[period], event);
      addPeriodEvent(modelRow.periods[period], event);
      addPeriodEvent(repositoryRow.periods[period], event);
    }
  }

  function sortedRows(map) {
    return [...map.values()]
      .map((row) => {
        const { pathSet, ...result } = row;
        return pathSet
          ? { ...result, pathCount: pathSet.size }
          : result;
      })
      .sort((a, b) => b.periods.all.total - a.periods.all.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return {
    asOf: asOf.toISOString(),
    periods: COMPARISON_PERIOD_KEYS.map((key) => ({
      key,
      start: ranges[key].start?.toISOString() || null,
      end: ranges[key].end?.toISOString() || null,
    })),
    totals,
    models: sortedRows(rows.models),
    repositories: sortedRows(rows.repositories),
  };
}

export function summarizeUsageIndex(index, filters = {}) {
  const bucket = filters.bucket || "day";
  const strings = index.strings;
  const range = indexDateRange(filters, index.events);
  const now = filters.now ? new Date(filters.now) : new Date();
  const events = index.events.filter((event) => {
    if (!Number.isFinite(event.t)) {
      return false;
    }
    if (range.start && event.t < range.start.getTime()) {
      return false;
    }
    if (range.end && event.t > range.end.getTime()) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => event.s));
  const totals = events.reduce((sum, event) => addIndexedUsage(sum, event), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents: index.events,
    eventTime: (event) => event.t,
    eventSession: (event) => event.s,
    addEventUsage: addIndexedUsage,
    currentTotals: totals,
    now,
  });
  const timelineEvents = events.map((event) => ({
    timestamp: event.t,
    sessionId: strings[event.s] || String(event.s),
    channel: strings[event.c] || "Unknown",
    model: strings[event.m] || "Unknown model",
    total: { total: event.total, input: event.input, cached: event.cached, output: event.output, reasoning: event.reasoning },
    detailMask: event.detailMask,
    cacheWriteTokens: event.cacheWriteTokens,
    cacheWriteKnown: Boolean(event.cacheWriteKnown),
    contextLevel: strings[event.contextLevel] || event.contextLevel,
    requestInputTokens: event.requestInputTokens,
    serviceTier: strings[event.serviceTier] || event.serviceTier,
    priceVersion: strings[event.priceVersion] || event.priceVersion,
  }));
  const timeline = buildTimelineRows(timelineEvents, range, bucket, { estimateCost: estimateEventCost });

  return {
    generatedAt: index.generatedAt,
    range: {
      preset: range.preset,
      start: range.start ? range.start.toISOString() : null,
      end: range.end ? range.end.toISOString() : null,
      bucket,
      rolling: Boolean(range.rolling),
    },
    totals,
    comparison,
    costEstimate: estimateCostForEvents(events.map((event) => ({
      model: strings[event.m] || "Unknown model",
      detailMask: event.detailMask,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: strings[event.contextLevel] || event.contextLevel,
      serviceTier: strings[event.serviceTier] || event.serviceTier,
      priceVersion: strings[event.priceVersion] || event.priceVersion,
      total: {
        total: event.total,
        input: event.input,
        cached: event.cached,
        output: event.output,
      },
    }))),
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.h)).size,
    timeline,
    channels: groupIndexedEvents(index, events, (event) => strings[event.c]),
    homes: groupIndexedEvents(index, events, (event) => strings[event.l]),
    models: groupIndexedEvents(index, events, (event) => strings[event.m] || "Unknown model"),
    projects: groupIndexedEvents(index, events, (event) => strings[event.p] || "Unknown cwd"),
    repositories: groupIndexedRepositories(index, events),
  };
}

export function summarizeUsage(report, filters = {}) {
  const bucket = filters.bucket || "day";
  const range = resolveDateRange(filters, report.events);
  const now = filters.now ? new Date(filters.now) : new Date();
  const events = report.events.filter((event) => {
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => event.sessionId));
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents: report.events,
    eventTime: (event) => Date.parse(event.timestamp),
    eventSession: (event) => event.sessionId,
    addEventUsage: (sum, event) => addUsage(sum, event.total),
    currentTotals: totals,
    now,
  });
  const timeline = buildTimelineRows(events, range, bucket, { estimateCost: estimateEventCost });

  return {
    generatedAt: report.generatedAt,
    range: {
      preset: range.preset,
      start: range.start ? range.start.toISOString() : null,
      end: range.end ? range.end.toISOString() : null,
      bucket,
      rolling: Boolean(range.rolling),
    },
    totals,
    comparison,
    costEstimate: estimateCostForEvents(events),
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.homeId)).size,
    timeline,
    channels: groupByUsage(events, (event) => event.channel),
    homes: groupByUsage(events, (event) => event.homeLabel),
    models: groupByUsage(events, (event) => event.model || "Unknown model"),
    projects: groupByUsage(events, (event) => event.cwd || "Unknown cwd"),
    repositories: groupRepositories(events),
  };
}

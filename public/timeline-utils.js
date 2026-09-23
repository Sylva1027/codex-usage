const USAGE_FIELDS = ["total", "input", "cached", "output", "reasoning"];

export function timelineDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function timelineBucketKey(value, bucket = "day") {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (bucket === "hour") {
    return `${timelineDateKey(date)} ${String(date.getHours()).padStart(2, "0")}:00`;
  }
  if (bucket === "month") {
    return timelineDateKey(date).slice(0, 7);
  }
  if (bucket === "week") {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    return timelineDateKey(start);
  }
  return timelineDateKey(date);
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addCalendarDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export const MAX_TIMELINE_SLOTS = 2_000;

function appendCalendarKey(keys, key, limit) {
  if (keys.length >= limit) {
    const error = new RangeError(`Time range exceeds ${limit} timeline slots.`);
    error.code = "TIMELINE_RANGE_TOO_LARGE";
    throw error;
  }
  keys.push(key);
}

function generateCalendarKeys(start, end, bucket, limit = MAX_TIMELINE_SLOTS) {
  const keys = [];
  if (!start || !end || end < start) return keys;
  if (bucket === "hour") {
    let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate(), end.getHours());
    const seen = new Set();
    while (cursor <= last) {
      const key = timelineBucketKey(cursor, bucket);
      if (!seen.has(key)) {
        seen.add(key);
        appendCalendarKey(keys, key, limit);
      }
      cursor.setHours(cursor.getHours() + 1);
    }
    return keys;
  }
  if (bucket === "day") {
    let cursor = startOfDay(start);
    const last = startOfDay(end);
    while (cursor <= last) {
      appendCalendarKey(keys, timelineBucketKey(cursor, bucket), limit);
      cursor = addCalendarDays(cursor, 1);
    }
    return keys;
  }
  if (bucket === "week") {
    let cursor = startOfWeek(start);
    const last = startOfWeek(end);
    while (cursor <= last) {
      appendCalendarKey(keys, timelineBucketKey(cursor, bucket), limit);
      cursor = addCalendarDays(cursor, 7);
    }
    return keys;
  }
  if (bucket === "month") {
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= last) {
      appendCalendarKey(keys, timelineBucketKey(cursor, bucket), limit);
      cursor.setMonth(cursor.getMonth() + 1, 1);
    }
  }
  return keys;
}

function slotKeys(range, bucket, existingRows) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  const preset = range?.preset;
  if (bucket === "hour" && preset === "today" && start) {
    const date = timelineDateKey(start);
    return Array.from({ length: 24 }, (_, hour) => `${date} ${String(hour).padStart(2, "0")}:00`);
  }
  if (bucket === "day" && preset === "week" && start) {
    const monday = startOfWeek(start);
    return Array.from({ length: 7 }, (_, index) => timelineBucketKey(addCalendarDays(monday, index), "day"));
  }
  if (bucket === "day" && preset === "month" && start) {
    const first = new Date(start.getFullYear(), start.getMonth(), 1);
    const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    return Array.from({ length: days }, (_, index) => timelineBucketKey(addCalendarDays(first, index), "day"));
  }
  if (start && end) return generateCalendarKeys(start, end, bucket);
  return [...existingRows].sort((a, b) => a.key.localeCompare(b.key)).map((row) => row.key);
}

function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function emptyRow(key) {
  return {
    key,
    name: key,
    count: 0,
    sessions: 0,
    total: emptyUsage(),
    channels: [],
    models: [],
    costByModel: {},
    pricedTokens: 0,
    unpricedTokens: 0,
    serviceTierUnknownTokens: 0,
    contextUnknownTokens: 0,
    cacheWriteUnknownTokens: 0,
    pricingStatus: "no-data",
  };
}

function addUsage(target, usage = {}) {
  for (const field of USAGE_FIELDS) target[field] += Number(usage[field] || 0);
}

function addSegment(group, event) {
  group.count += 1;
  group.sessions.add(event.sessionId || "");
  addUsage(group.total, event.total || event.usage);
}

function materializeSegments(groups) {
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
    }))
    .sort((a, b) => b.total.total - a.total.total || a.name.localeCompare(b.name));
}

export function buildTimelineRows(events = [], range = {}, bucket = "day", options = {}) {
  const hasBoundedRange = Boolean(asDate(range?.start) && asDate(range?.end));
  const rangedKeys = hasBoundedRange ? slotKeys(range, bucket, []) : null;
  const rowsByKey = new Map();
  const estimateCost = options.estimateCost || ((event) => event.costEstimate || null);
  for (const event of events) {
    const key = timelineBucketKey(event.timestamp ?? event.timestampMs, bucket);
    if (!key) continue;
    const row = rowsByKey.get(key) || {
      ...emptyRow(key),
      channelGroups: new Map(),
      modelGroups: new Map(),
      modelCosts: new Map(),
      sessionsSet: new Set(),
      estimatedRecords: 0,
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens: 0,
    };
    row.count += 1;
    row.sessionsSet.add(event.sessionId || "");
    addUsage(row.total, event.total || event.usage);
    const channelName = String(event.channel || "Unknown");
    const channel = row.channelGroups.get(channelName) || {
      key: channelName,
      name: channelName,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
    };
    addSegment(channel, event);
    row.channelGroups.set(channelName, channel);

    const modelName = String(event.model || "Unknown model");
    const model = row.modelGroups.get(modelName) || {
      key: modelName,
      name: modelName,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
    };
    addSegment(model, event);
    row.modelGroups.set(modelName, model);

    const estimate = estimateCost(event);
    if (estimate) {
      options.onEstimate?.(event, estimate);
      row.estimatedRecords += 1;
      const cost = row.modelCosts.get(modelName) || {
        totalUsd: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        serviceTierUnknownTokens: 0,
        contextUnknownTokens: 0,
        cacheWriteUnknownTokens: 0,
        pricingStatuses: new Set(),
      };
      cost.totalUsd += Number(estimate.totalUsd || 0);
      cost.pricedTokens += Number(estimate.pricedTokens || 0);
      cost.unpricedTokens += Number(estimate.unpricedTokens || 0);
      cost.serviceTierUnknownTokens += Number(estimate.serviceTierUnknownTokens || 0);
      cost.contextUnknownTokens += Number(estimate.contextUnknownTokens || 0);
      cost.cacheWriteUnknownTokens += Number(estimate.cacheWriteUnknownTokens || 0);
      if (estimate.pricingStatus) cost.pricingStatuses.add(estimate.pricingStatus);
      row.modelCosts.set(modelName, cost);
      row.pricedTokens += Number(estimate.pricedTokens || 0);
      row.unpricedTokens += Number(estimate.unpricedTokens || 0);
      row.serviceTierUnknownTokens += Number(estimate.serviceTierUnknownTokens || 0);
      row.contextUnknownTokens += Number(estimate.contextUnknownTokens || 0);
      row.cacheWriteUnknownTokens += Number(estimate.cacheWriteUnknownTokens || 0);
    }
    rowsByKey.set(key, row);
  }

  const rows = [...rowsByKey.values()].map((row) => {
    const statusValues = [...row.modelCosts.values()].flatMap((entry) => [...entry.pricingStatuses]);
    let pricingStatus = "unavailable";
    if (row.estimatedRecords > 0) {
      pricingStatus = row.unpricedTokens > 0
        ? (row.pricedTokens > 0 ? "partial" : "unpriced")
        : "estimated";
      if (!row.pricedTokens && !row.unpricedTokens && statusValues.includes("unknown")) pricingStatus = "unknown";
    }
    return {
      key: row.key,
      name: row.name,
      count: row.count,
      sessions: row.sessionsSet.size,
      total: row.total,
      channels: materializeSegments(row.channelGroups),
      models: materializeSegments(row.modelGroups),
      costByModel: Object.fromEntries([...row.modelCosts].map(([name, cost]) => [name, {
        totalUsd: cost.totalUsd,
        pricedTokens: cost.pricedTokens,
        unpricedTokens: cost.unpricedTokens,
        serviceTierUnknownTokens: cost.serviceTierUnknownTokens,
        contextUnknownTokens: cost.contextUnknownTokens,
        cacheWriteUnknownTokens: cost.cacheWriteUnknownTokens,
        pricingStatus: cost.unpricedTokens > 0 ? (cost.pricedTokens > 0 ? "partial" : "unpriced") : "estimated",
      }])),
      pricedTokens: row.pricedTokens,
      unpricedTokens: row.unpricedTokens,
      serviceTierUnknownTokens: row.serviceTierUnknownTokens,
      contextUnknownTokens: row.contextUnknownTokens,
      cacheWriteUnknownTokens: row.cacheWriteUnknownTokens,
      pricingStatus,
    };
  });
  rows.sort((a, b) => a.key.localeCompare(b.key));

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const ordered = (rangedKeys || slotKeys(range, bucket, rows)).map((key) => byKey.get(key) || emptyRow(key));
  const included = new Set(ordered.map((row) => row.key));
  for (const row of rows) if (!included.has(row.key)) ordered.push(row);
  return ordered;
}

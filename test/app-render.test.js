import assert from "node:assert/strict";
import test from "node:test";

import {
  datePickerMonthModel,
  drawTimeline,
  filterPeriodComparisonRows,
  formatTokenMillions,
  renderBarListHtml,
  renderComparisonHtml,
  renderDatePickerHtml,
  renderHomesHtml,
  renderPeriodComparisonTableHtml,
  timelineAxisLabels,
} from "../public/app.js";

test("token values use two decimal places in millions and retain exact hover values", () => {
  assert.equal(formatTokenMillions(62_617_267), "62.62M");

  const barHtml = renderBarListHtml([
    { key: "gpt-6-luna", name: "gpt-6-luna", total: { total: 62_617_267 } },
  ]);
  assert.match(barHtml, /title="62,617,267">62\.62M/);

  const comparisonHtml = renderPeriodComparisonTableHtml([
    {
      key: "gpt-6-luna",
      name: "gpt-6-luna",
      periods: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
  ], {
    totals: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
  });
  assert.match(comparisonHtml, /title="62,617,267">62\.62M/);
  assert.match(comparisonHtml, /<td title="62,617,267">62\.62M<\/td>/);
});

test("period comparison only shows active models and repositories in the selected range", () => {
  const models = filterPeriodComparisonRows(
    [{ key: "gpt-6-luna" }, { key: "gpt-6-sol" }, { key: "gpt-6-astra" }],
    [
      { key: "gpt-6-luna", total: { total: 120 } },
      { key: "gpt-6-sol", total: { total: 4 } },
      { key: "gpt-6-astra", total: { total: 0 } },
    ],
  );
  assert.deepEqual(models.map((row) => row.key), ["gpt-6-luna", "gpt-6-sol"]);

  const repositories = filterPeriodComparisonRows(
    [
      { key: "directory:shared", kind: "directory" },
      { key: "directory:inactive", kind: "directory" },
      { key: "git:repo", kind: "git", sourceKeys: ["git:repo"] },
    ],
    [
      { key: "directory:shared", total: { total: 12 } },
      { key: "git:repo", total: { total: 30 }, sessionIds: ["other-session"] },
    ],
    "repository",
  );
  assert.deepEqual(repositories.map((row) => row.key), ["directory:shared", "git:repo"]);
});

test("render helpers escape usage row names before inserting HTML", () => {
  const rows = [
    {
      name: '<img src=x onerror="alert(1)">',
      total: { total: 42, input: 40, cached: 0, output: 2, reasoning: 0 },
    },
  ];

  const barHtml = renderBarListHtml(rows);

  assert.doesNotMatch(barHtml, /<img/i);
  assert.match(barHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("renderHomesHtml shows escaped statuses and removable imported directories", () => {
  const html = renderHomesHtml(
    [
      {
        label: "Project <unsafe>",
        kind: "project-log",
        path: "/tmp/project&one",
        imported: true,
        status: "active",
        eventCount: 3,
      },
    ],
    { canModify: true },
  );

  assert.doesNotMatch(html, /Project <unsafe>/);
  assert.match(html, /Project &lt;unsafe&gt;/);
  assert.match(html, /\/tmp\/project&amp;one/);
  assert.match(html, /data-import-action="remove"/);
  assert.match(html, /有用量记录/);
});

test("renderComparisonHtml renders trend, average trend, and previous totals", () => {
  const html = renderComparisonHtml({
    label: "较上周",
    previousRange: {
      start: "2026-06-15T00:00:00.000Z",
      end: "2026-06-21T23:59:59.999Z",
    },
    previousTotals: { total: 62_617_267, input: 62_617_267, cached: 0, output: 0, reasoning: 0 },
    previousSessionCount: 2,
    totalDelta: -25_518_704,
    percentChange: -57.14,
    averageBaselineTotal: 50,
    averageDelta: 8_581_809,
    averagePercentChange: 500,
  });

  assert.match(html, /较上周/);
  assert.match(html, /平均趋势变化/);
  assert.match(html, /上周 tokens/);
  assert.match(html, /<strong title="-25,518,704">-25\.52M<\/strong>/);
  assert.match(html, /<strong title="\+8,581,809">\+8\.58M<\/strong>/);
  assert.match(html, /<strong title="62,617,267">62\.62M<\/strong>/);
  assert.match(html, /2 个会话/);
});

test("renderComparisonHtml names the previous token period for day, week, and month", () => {
  const labels = [
    ["较昨日", "昨日 tokens"],
    ["较上周", "上周 tokens"],
    ["较上月", "上月 tokens"],
  ];

  for (const [comparisonLabel, expected] of labels) {
    const html = renderComparisonHtml({
      label: comparisonLabel,
      previousRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-01T23:59:59.999Z" },
      previousTotals: { total: 1_000_000 },
      previousSessionCount: 1,
      totalDelta: 0,
      percentChange: 0,
      averageDelta: 0,
      averagePercentChange: 0,
    });

    assert.ok(html.includes(`<span>${expected}</span>`), `expected ${comparisonLabel} to render ${expected}`);
  }
});

test("renderComparisonHtml explains all-time comparisons and dates custom baselines", () => {
  const allTimeHtml = renderComparisonHtml({ label: "暂无对比", previousRange: null });
  assert.match(allTimeHtml, /全部范围没有可比较的上一周期/);
  assert.doesNotMatch(allTimeHtml, /上一周期 tokens/);
  const incompleteCustomHtml = renderComparisonHtml({ label: "较上一等长周期", previousRange: null });
  assert.match(incompleteCustomHtml, /当前范围没有可比较的上一周期/);

  const customHtml = renderComparisonHtml({
    label: "较上一等长周期",
    previousRange: {
      start: new Date(2026, 7, 31),
      end: new Date(2026, 8, 9, 23, 59, 59, 999),
    },
    previousTotals: { total: 12_345_678 },
    previousSessionCount: 4,
    totalDelta: 1_000_000,
    percentChange: 8.1,
    averageDelta: 500_000,
    averagePercentChange: 4.2,
  });
  assert.match(customHtml, /前一等长区间 tokens/);
  assert.match(customHtml, /2026-08-31 至 2026-09-09 · 4 个会话/);
});

test("datePickerMonthModel starts weeks on Monday and keeps outside-month days selectable", () => {
  const model = datePickerMonthModel(new Date("2026-07-15T12:00:00"), "2026-06-30");

  assert.deepEqual(model.weekdays, ["一", "二", "三", "四", "五", "六", "日"]);
  assert.deepEqual(
    model.cells.slice(0, 7).map((cell) => [cell.date, cell.inCurrentMonth]),
    [
      ["2026-06-29", false],
      ["2026-06-30", false],
      ["2026-07-01", true],
      ["2026-07-02", true],
      ["2026-07-03", true],
      ["2026-07-04", true],
      ["2026-07-05", true],
    ],
  );
  assert.equal(model.cells[1].selected, true);
});

test("renderDatePickerHtml marks outside-month dates as dim but selectable buttons", () => {
  const html = renderDatePickerHtml({
    field: "start",
    viewDate: new Date("2026-07-15T12:00:00"),
    selectedValue: "2026-06-30",
  });

  assert.match(html, /<div class="date-picker-weekday">一<\/div>/);
  assert.match(html, /data-date="2026-06-29"[^>]*class="date-picker-day outside-month"/);
  assert.match(html, /data-date="2026-06-30"[^>]*class="date-picker-day outside-month selected"/);
  assert.match(html, /data-date="2026-07-01"[^>]*class="date-picker-day"/);
  assert.match(html, /type="button"[^>]*data-date="2026-06-29"/);
});

test("timelineAxisLabels shows all 24 labels for a single hourly day", () => {
  // Single-day hourly charts should label every hour from midnight through the last hour.
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    key: `2026-06-18 ${String(hour).padStart(2, "0")}:00`,
  }));

  assert.deepEqual(
    timelineAxisLabels(rows, {
      bucket: "hour",
      range: {
        start: "2026-06-18T00:00:00",
        end: "2026-06-18T23:59:59.999",
      },
      maxLabels: 8,
    }).map((label) => label.label),
    Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
  );
});

test("timelineAxisLabels samples hourly labels outside a single day", () => {
  // Multi-day hourly charts keep labels evenly distributed instead of drawing every hour.
  const rows = Array.from({ length: 48 }, (_, index) => {
    const day = index < 24 ? "18" : "19";
    const hour = String(index % 24).padStart(2, "0");
    return { key: `2026-06-${day} ${hour}:00` };
  });
  const labels = timelineAxisLabels(rows, {
    bucket: "hour",
    range: {
      start: "2026-06-18T00:00:00",
      end: "2026-06-19T23:59:59.999",
    },
    maxLabels: 8,
  });

  assert.equal(labels.length, 8);
  assert.deepEqual(
    labels.map((label) => label.index),
    [0, 7, 13, 20, 27, 34, 40, 47],
  );
  assert.deepEqual(
    [labels[0].label, labels.at(-1).label],
    ["06-18 00", "06-19 23"],
  );
});

test("drawTimeline does not draw visible bars for zero-token rows", () => {
  // Empty hourly buckets should keep hit areas and labels without painting 2px fake bars.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, [
      {
        key: "2026-06-18 00:00",
        total: { total: 0 },
        channels: [],
      },
    ]);

    assert.equal(calls.filter(([name]) => name === "fillRect").length, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("drawTimeline renders model and cost stacks and rejects missing breakdowns", () => {
  const calls = [];
  let currentFillStyle = "";
  const context = {
    clearRect: () => {},
    scale: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillRect: (...args) => calls.push({ type: "rect", fillStyle: currentFillStyle, args }),
    fillText: (text) => calls.push({ type: "text", text }),
    save: () => {},
    translate: () => {},
    rotate: () => {},
    restore: () => {},
    set fillStyle(value) { currentFillStyle = value; },
    get fillStyle() { return currentFillStyle; },
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });

  try {
    const row = {
      key: "2026-09-23 12:00",
      total: { total: 100 },
      channels: [],
      models: [{ name: "gpt-6-sol", total: { total: 100 } }],
      costByModel: {
        "gpt-6-sol": { totalUsd: 0.25, pricedTokens: 100, unpricedTokens: 0 },
      },
      pricedTokens: 100,
      unpricedTokens: 0,
    };
    const modelRows = [{ name: "gpt-6-sol", total: { total: 100 } }];

    drawTimeline(canvas, [row], [], new Map(), null, "model", modelRows);
    const modelBars = calls.filter((call) => call.type === "rect");
    assert.equal(modelBars.length, 1);
    assert.match(modelBars[0].fillStyle, /^hsl\(/);

    calls.length = 0;
    drawTimeline(canvas, [row], [], new Map(), null, "cost", modelRows);
    const costBars = calls.filter((call) => call.type === "rect");
    assert.equal(costBars.length, 1);
    assert.ok(calls.some((call) => call.type === "text" && call.text === "$0.25"));

    const staleRow = { key: row.key, total: row.total };
    for (const [mode, message] of [
      ["model", "模型明细不可用"],
      ["cost", "费用明细不可用"],
    ]) {
      calls.length = 0;
      drawTimeline(canvas, [staleRow], [], new Map(), null, mode, modelRows);
      assert.equal(calls.filter((call) => call.type === "rect").length, 0);
      assert.ok(calls.some((call) => call.type === "text" && call.text.includes(message)));
    }
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});
test("drawTimeline keeps dense hourly bars inside the chart width", () => {
  // Dense all-time hourly charts must shrink visual bars instead of pushing later bars off-canvas.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 1200,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  const rows = Array.from({ length: 700 }, (_, index) => ({
    key: `2026-06-${String(Math.floor(index / 24) + 1).padStart(2, "0")} ${String(index % 24).padStart(2, "0")}:00`,
    total: { total: index === 699 ? 100 : 1 },
    channels: [],
  }));
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, rows);

    const visibleBars = calls.filter(([name]) => name === "fillRect");
    const lastBar = visibleBars.at(-1);
    assert.ok(lastBar[1] + lastBar[3] <= 1200 - 18);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("timeline labels show natural week weekdays and full month dates", () => {
  const weekRows = Array.from({ length: 7 }, (_, index) => ({
    key: `2026-05-${String(4 + index).padStart(2, "0")}`,
  }));
  assert.deepEqual(
    timelineAxisLabels(weekRows, {
      bucket: "day",
      range: { preset: "week", start: "2026-05-04T00:00:00", end: "2026-05-05T23:59:59" },
    }).map((label) => label.label),
    ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  );

  const monthRows = Array.from({ length: 29 }, (_, index) => ({
    key: `2024-02-${String(index + 1).padStart(2, "0")}`,
  }));
  const labels = timelineAxisLabels(monthRows, {
    bucket: "day",
    range: { preset: "month", start: "2024-02-01T00:00:00", end: "2024-02-10T23:59:59" },
    chartWidth: 2000,
    maxLabels: 31,
  });
  assert.equal(labels.length, 29);
  assert.deepEqual([labels[0].label, labels.at(-1).label], ["01", "29"]);

  assert.equal(
    timelineAxisLabels([{ key: "2026-05-04" }], {
      bucket: "week",
      range: { preset: "all", start: "2026-05-04T00:00:00", end: "2026-05-10T23:59:59" },
    })[0].label,
    "05-04",
  );
});

test("drawTimeline centers date ticks under capped slot bars", () => {
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  try {
    drawTimeline(canvas, [{ key: "2026-05-26", total: { total: 100 }, channels: [] }], [], new Map(), {
      preset: "custom", start: "2026-05-26T00:00:00", end: "2026-05-26T23:59:59",
    }, "channel");
    const bar = calls.find(([name]) => name === "fillRect");
    const tick = calls.find(([name]) => name === "translate");
    assert.ok(bar);
    assert.equal(bar[3], 30);
    assert.equal(bar[1] + bar[3] / 2, tick[1]);
    assert.ok(bar[3] < (960 - 64 - 18));
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

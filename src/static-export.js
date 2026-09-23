import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildUsageReport, summarizePeriodComparison } from "./usage-core.js";
import { API_PRICING_CHECKED_AT, API_PRICING_MODE, API_PRICING_SOURCE, estimateEventCost } from "./pricing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function safeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function renderStaticDashboardHtml(report) {
  const indexHtml = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const styles = readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");
  const app = readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const timelineUtils = readFileSync(path.join(PUBLIC_DIR, "timeline-utils.js"), "utf8");
  const inlineTimelineUtils = timelineUtils.replace(/^export\s+/gm, "");
  const bundledApp = app.replace(/^import \{ buildTimelineRows \} from "\.\/timeline-utils\.js";\s*/m, "");
  const periodComparison = summarizePeriodComparison(report.events, { now: report.generatedAt });
  const pricedReport = {
    ...report,
    pricing: {
      checkedAt: API_PRICING_CHECKED_AT,
      mode: API_PRICING_MODE,
      source: API_PRICING_SOURCE,
    },
    events: report.events.map((event) => ({ ...event, costEstimate: estimateEventCost(event) })),
  };
  return indexHtml
    .replace('<link rel="stylesheet" href="/styles.css" />', `<style>\n${styles}\n</style>`)
    .replace(
      '<script src="/app.js" type="module"></script>',
      `<script>window.__CODEX_USAGE_REPORT__ = ${safeScriptJson(pricedReport)}; window.__CODEX_USAGE_PERIOD_COMPARISON__ = ${safeScriptJson(periodComparison)};</script>\n<script type="module">\n${inlineTimelineUtils}\n${bundledApp}\n</script>`,
    );
}

export async function exportStaticDashboard(options = {}) {
  const outFile = options.outFile || path.join(ROOT_DIR, "dist", "codex-usage.html");
  const report = options.report || (await buildUsageReport(options));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, renderStaticDashboardHtml(report));
  return outFile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outArgIndex = process.argv.indexOf("--out");
  const outFile = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : undefined;
  exportStaticDashboard({ outFile })
    .then((file) => {
      console.log(file);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}

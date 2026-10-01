import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUsageReport } from "../../../src/usage-core.js";
import { renderStaticDashboardHtml } from "../../../src/static-export.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(output, "assets");
const originals = process.env.AGENT_USAGE_GPT_IMAGES || "C:/Users/Silver/Downloads/art-access/lineart";
const names = ["gpt-side-lineart.png", "gpt-lineart.png"];
await mkdir(assets, { recursive: true });
for (const name of names) {
  try {
    await readFile(path.join(assets, name));
  } catch {
    await copyFile(path.join(originals, name), path.join(assets, name));
  }
}

// Only synthetic project logs are read; the user's running service is untouched.
const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-usage-gpt-preview-"));
const timestamp = new Date("2026-10-02T04:00:00+08:00");
const projectNames = ["界面开发", "数据分析", "文档整理", "实验项目"];
const models = ["gpt-6-sol", "claude-sonnet-4-6", "glm-5.3", "gpt-6.1-sol"];
const channels = ["Codex Desktop", "OpenCode", "ZCode Subagent", "DSH Subagent"];
const homes = [];
for (const [projectIndex, projectName] of projectNames.entries()) {
  const cwd = path.join(fixture, projectName);
  const logDir = path.join(cwd, ".codex-usage");
  await mkdir(logDir, { recursive: true });
  const rows = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(timestamp);
    date.setUTCDate(date.getUTCDate() - index);
    date.setUTCHours(4 + projectIndex);
    const total = (12 - index) * (projectIndex + 2) * 12000;
    return {
      schema_version: "codex-usage.project-log.v1",
      timestamp: date.toISOString(),
      session_id: `preview-${projectIndex}-${index}`,
      request_id: `preview-request-${projectIndex}-${index}`,
      cwd,
      model: models[projectIndex],
      channel: channels[projectIndex],
      usage: { total, input: total * 0.8, cached: total * 0.2, output: total * 0.2 },
    };
  });
  const usageLogPath = path.join(logDir, "usage.jsonl");
  await writeFile(usageLogPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  homes.push({ label: projectName, path: cwd, kind: "project-log", usageLogPath });
}
const report = await buildUsageReport({ homes, homeDir: fixture, env: {} });
const images = await Promise.all(names.map((name) => readFile(path.join(assets, name))));
const imageUrls = images.map((data) => `data:image/png;base64,${data.toString("base64")}`);
const style = `
  html { --preview-opacity: .8; --preview-shell: min(1200px, calc(100vw - 360px)); }
  body { overflow-x: clip; }
  .shell { position: relative; z-index: 1; width: var(--preview-shell); }
  .preview-controls {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
    gap: 12px 20px; margin-bottom: 18px; padding: 14px 18px;
    border: 1px solid var(--neo-edge); border-radius: 18px;
    background: var(--neo-surface); box-shadow: var(--neo-raised-small);
  }
  .preview-intro { display: grid; gap: 4px; }
  .preview-intro strong { font-size: 15px; }
  .preview-intro span { color: var(--muted); font-size: 12px; }
  .preview-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
  .preview-mode { display: flex; gap: 3px; padding: 4px; border-radius: 12px;
    background: var(--ceramic-well); box-shadow: var(--neo-inset-small); }
  .preview-mode button { cursor: pointer; border: 0; padding: 8px 12px; border-radius: 9px;
    background: transparent; color: var(--muted); font-size: 13px; font-weight: 650; }
  .preview-mode button[aria-pressed="true"] { color: var(--ink); background: var(--neo-surface);
    box-shadow: var(--neo-raised-small); }
  .preview-mode button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  .preview-opacity { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
  .preview-opacity input { width: 86px; accent-color: var(--blue); }
  .preview-opacity output { min-width: 3ch; font-variant-numeric: tabular-nums; }
  .preview-visibility { display: flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 12px; }
  .preview-visibility input { accent-color: var(--blue); }
  .preview-mobile-note { display: none; color: var(--muted); font-size: 12px; }
  .character-layer { position: fixed; inset: 0; z-index: 0; pointer-events: none;
    --gutter: calc((100vw - min(1200px, calc(100vw - 360px))) / 2); }
  .character-rail { position: absolute; top: 124px; bottom: 20px; width: var(--gutter); overflow: hidden; }
  .character-rail--left { left: 0; }
  .character-rail--right { right: 0; }
  .character-rail img, .character-ink { position: absolute; top: 0; left: 50%; display: block;
    width: calc(min(920px, calc(100svh - 156px)) * 941 / 1672);
    height: min(920px, calc(100svh - 156px)); max-width: none; aspect-ratio: 941 / 1672;
    opacity: var(--preview-opacity); transform: translateX(-48%); }
  .character-rail img { visibility: hidden; }
  .character-ink { background: var(--ink); mask-mode: alpha; mask-repeat: no-repeat; mask-size: 100% 100%; }
  html[data-character-layout="full"] .character-rail { top: 160px; overflow: visible; }
  html[data-character-layout="full"] .character-rail img,
  html[data-character-layout="full"] .character-ink {
    width: calc(var(--gutter) - 24px); height: auto; max-height: calc(100svh - 188px);
    object-fit: contain; transform: translateX(-50%);
  }
  html[data-characters="hidden"] .character-layer { display: none; }
  html[data-characters="hidden"] .shell { width: min(1440px, calc(100vw - 32px)); }
  @media (min-width: 1200px) and (max-width: 1559px) {
    .toolbar { grid-template-columns: minmax(220px, 1fr) minmax(300px, 1.25fr); }
    .toolbar > .range-controls { grid-column: 1 / -1; }
    .toolbar > .date-range-controls { grid-column: 1; }
    .toolbar > .auto-refresh-status { grid-column: 2; }
    .date-range-values { flex-direction: row; }
    .chart-panel .timeline-mode-select { width: auto; }
    .chart-panel .timeline-mode-select > button { padding-inline: 10px; }
    .metrics { gap: 12px; }
    .metric strong { padding-inline: 6px; font-size: 22px; }
  }
  @media (max-width: 1199px) {
    .shell { width: min(1440px, calc(100vw - 32px)); }
    .character-layer { display: none; }
    .preview-mobile-note { display: block; }
  }
  @media (max-width: 720px) {
    .shell, html[data-characters="hidden"] .shell { width: calc(100vw - 20px); }
    .preview-controls { padding: 12px; gap: 10px; }
    .preview-tools { gap: 8px 12px; }
    .preview-mode button { padding: 7px 10px; }
  }
`;
const controls = `
  <section class="preview-controls" aria-label="角色预览设置">
    <div class="preview-intro"><strong>ChatGPT 双侧线稿预览</strong><span>示例数据 · 左侧侧视 / 右侧正视 · 透明线稿</span></div>
    <div class="preview-tools">
      <div class="preview-mode" role="group" aria-label="立绘展示方式">
        <button type="button" data-character-mode="full" aria-pressed="false">完整展示</button>
        <button type="button" data-character-mode="large" aria-pressed="true">放大贴边</button>
      </div>
      <label class="preview-opacity">透明度 <input id="characterOpacity" type="range" min="25" max="100" value="80" /><output id="characterOpacityValue" for="characterOpacity">80%</output></label>
      <label class="preview-visibility"><input id="showCharacters" type="checkbox" checked />显示角色</label>
    </div>
    <span class="preview-mobile-note">窄屏收起双侧立绘，保留看板可用宽度。</span>
  </section>
`;
const layer = `
  <div class="character-layer" aria-hidden="true">
    <div class="character-rail character-rail--left"><img id="characterSide" src="${imageUrls[0]}" alt="" /></div>
    <div class="character-rail character-rail--right"><img id="characterFront" src="${imageUrls[1]}" alt="" /></div>
  </div>
`;
const script = `
  for (const image of document.querySelectorAll(".character-rail img")) {
    const ink = document.createElement("span");
    ink.className = "character-ink";
    ink.style.maskImage = 'url("' + image.src + '")';
    image.after(ink);
  }
  document.documentElement.dataset.characterLayout = new URLSearchParams(location.search).get("layout") === "full" ? "full" : "large";
  function syncCharacterMode() {
    for (const button of document.querySelectorAll("[data-character-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.characterMode === document.documentElement.dataset.characterLayout));
    }
  }
  for (const button of document.querySelectorAll("[data-character-mode]")) {
    button.addEventListener("click", () => {
      document.documentElement.dataset.characterLayout = button.dataset.characterMode;
      syncCharacterMode();
    });
  }
  document.querySelector("#characterOpacity").addEventListener("input", event => {
    const value = event.target.value;
    document.documentElement.style.setProperty("--preview-opacity", String(Number(value) / 100));
    document.querySelector("#characterOpacityValue").value = value + "%";
  });
  document.querySelector("#showCharacters").addEventListener("change", event => {
    document.documentElement.dataset.characters = event.target.checked ? "visible" : "hidden";
    window.dispatchEvent(new Event("resize"));
  });
  syncCharacterMode();
  window.addEventListener("load", () => document.querySelector('[data-preset="all"]').click());
`;
let html = renderStaticDashboardHtml({ ...report, generatedAt: timestamp.toISOString(), asOf: timestamp.toISOString() });
html = html.replace("</head>", `<style>${style}</style></head>`);
html = html.replace('<main class="shell">', `${layer}<main class="shell">${controls}`);
html = html.replace("</body>", `<script>${script}</script></body>`);
const file = path.join(output, "preview.html");
await writeFile(file, html);
const dashboardStyles = await readFile(path.resolve(output, "../../../public/styles.css"), "utf8");
const viewer = `<!doctype html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><title>ChatGPT 双侧角色效果</title>
<style>${dashboardStyles}
  .viewer-shell { max-width: 1920px; margin: auto; padding: 16px; }
  .viewer-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
    gap: 12px; margin-bottom: 16px; padding: 14px 18px; border-radius: 18px;
    background: var(--neo-surface); box-shadow: var(--neo-raised-small); }
  .viewer-toolbar strong { font-size: 16px; }
  .viewer-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .viewer-tools button, .viewer-tools select { padding: 8px 12px; border: 1px solid var(--neo-edge);
    border-radius: 9px; background: var(--neo-surface); color: var(--ink); cursor: pointer; }
  .viewer-tools button[aria-pressed="true"] { box-shadow: var(--neo-inset-small); color: var(--record); }
  .viewer-tools button:focus-visible, .viewer-tools select:focus-visible { outline: 2px solid var(--blue); }
  #viewerStage { position: relative; width: 100%; overflow: hidden; border-radius: 16px; }
  #viewerFrame { position: absolute; top: 0; border: 0; transform-origin: top left; }
  .viewer-caption { margin-top: 14px; color: var(--muted); font-size: 12px; }
</style></head><body><main class="viewer-shell">
  <div class="viewer-toolbar"><strong>ChatGPT 双侧角色效果</strong><div class="viewer-tools">
    <select id="viewerWidth" aria-label="预览屏幕宽度"><option value="1920">1920px 宽屏</option><option value="1440">1440px 桌面</option><option value="390">390px 手机</option></select>
    <button type="button" data-viewer-mode="full" aria-pressed="false">完整展示</button>
    <button type="button" data-viewer-mode="large" aria-pressed="true">放大贴边</button>
    <button id="viewerTheme" type="button">切换明暗</button>
  </div></div>
  <div id="viewerStage"><iframe id="viewerFrame" title="角色双侧展示预览"></iframe></div>
  <p class="viewer-caption">按所选屏幕尺寸渲染并缩放展示。页面使用示例数据与当前配色；图中预览面板可调透明度和角色显示。</p>
</main><script>
  const frame = document.querySelector("#viewerFrame");
  const stage = document.querySelector("#viewerStage");
  let mode = "large";
  function fit() {
    const width = Number(document.querySelector("#viewerWidth").value);
    const height = width === 390 ? 844 : 1080;
    const scale = Math.min(1, stage.clientWidth / width);
    frame.style.width = width + "px";
    frame.style.height = height + "px";
    frame.style.transform = "scale(" + scale + ")";
    frame.style.left = Math.max(0, (stage.clientWidth - width * scale) / 2) + "px";
    stage.style.height = height * scale + "px";
  }
  function sync() {
    const documentInside = frame.contentDocument;
    const button = documentInside?.querySelector("#themeToggle");
    if (button && documentInside.documentElement.dataset.theme !== document.documentElement.dataset.theme) button.click();
    documentInside?.querySelector('[data-character-mode="' + mode + '"]')?.click();
  }
  frame.addEventListener("load", sync);
  document.querySelector("#viewerWidth").addEventListener("change", fit);
  document.querySelector("#viewerTheme").addEventListener("click", () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    sync();
  });
  for (const button of document.querySelectorAll("[data-viewer-mode]")) {
    button.addEventListener("click", () => {
      mode = button.dataset.viewerMode;
      for (const choice of document.querySelectorAll("[data-viewer-mode]")) choice.setAttribute("aria-pressed", String(choice.dataset.viewerMode === mode));
      sync();
    });
  }
  new ResizeObserver(fit).observe(stage);
  frame.srcdoc = ${JSON.stringify(html).replaceAll("<", "\\u003c")};
  fit();
</script></body></html>`;
await writeFile(path.join(output, "viewer.html"), viewer);
await writeFile(path.join(output, "assets.json"), `${JSON.stringify({
  date: "2026-10-02",
  variant: "transparent-lineart",
  rendering: "Original PNG alpha mask rendered with the existing --ink color; source files unchanged",
  images: names.map((name, index) => ({ name, width: images[index].readUInt32BE(16), height: images[index].readUInt32BE(20), bytes: images[index].length, sha256: createHash("sha256").update(images[index]).digest("hex") })),
  htmlBytes: Buffer.byteLength(html),
  fixture: "Synthetic project logs; no personal usage data",
}, null, 2)}\n`);
console.log(`Built ${file}`);

if (process.argv.includes("--serve")) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port.");
  const server = createServer((request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(request.url?.split("?")[0] === "/preview.html" ? html : viewer);
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`Preview: http://127.0.0.1:${server.address().port}/`);
}

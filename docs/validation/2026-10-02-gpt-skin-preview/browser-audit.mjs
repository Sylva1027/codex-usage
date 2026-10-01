import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const output = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
const externalRequests = [];
page.on("pageerror", (error) => errors.push(error.message));
await context.route("**/*", (route) => {
  if (/^https?:/.test(route.request().url())) {
    externalRequests.push(route.request().url());
    return route.abort();
  }
  return route.continue();
});
const results = { date: "2026-10-02", browser: await browser.version(), layouts: [], checks: [], errors, externalRequests };
async function check(name, action) {
  await action();
  results.checks.push(name);
  console.log(`PASS ${name}`);
}
async function theme(value) {
  if (await page.locator("html").getAttribute("data-theme") !== value) await page.locator("#themeToggle").click();
}
async function settle() {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function geometry() {
  return page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    const styles = getComputedStyle(document.querySelector(".character-layer"));
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, shell: rect(".shell"), left: rect(".character-rail--left"), right: rect(".character-rail--right"), charactersVisible: styles.display !== "none", mode: document.documentElement.dataset.characterLayout, theme: document.documentElement.dataset.theme, images: [...document.querySelectorAll(".character-rail img")].map((img) => ({ id: img.id, complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight })), background: getComputedStyle(document.body).backgroundColor };
  });
}
try {
  await page.goto(pathToFileURL(path.join(output, "preview.html")).href);
  await page.waitForFunction(() => document.querySelector("#totalTokens").textContent.trim() !== "-");
  await page.locator('[data-preset="all"]').click();
  await check("Both original images load", async () => {
    for (const image of (await geometry()).images) assert.ok(image.complete && image.naturalWidth === 941 && image.naturalHeight === 1672);
  });
  for (const value of ["dark", "light"]) {
    await theme(value);
    await check(`${value} lineart follows the current text color without image fill`, async () => {
      const mask = await page.locator(".character-ink").first().evaluate((element) => ({
        image: getComputedStyle(element).maskImage,
        mode: getComputedStyle(element).maskMode,
        color: getComputedStyle(element).backgroundColor,
        textColor: getComputedStyle(document.body).color,
      }));
      assert.ok(mask.image.includes("data:image/png;base64,"));
      assert.equal(mask.mode, "alpha");
      assert.equal(mask.color, mask.textColor);
    });
  }
  for (const width of [1920, 1680, 1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
    for (const value of ["dark", "light"]) {
      await theme(value);
      await settle();
      const data = await geometry();
      results.layouts.push(data);
      await check(`${width}px ${value} no overflow or character overlap`, async () => {
        assert.ok(data.documentWidth <= width + 1, JSON.stringify(data));
        assert.equal(data.charactersVisible, width >= 1200);
        if (data.charactersVisible) {
          assert.ok(data.left.right <= data.shell.x + 1);
          assert.ok(data.right.x >= data.shell.right - 1);
          assert.equal(await page.locator(".character-layer").evaluate((element) => getComputedStyle(element).pointerEvents), "none");
        }
      });
      if ([1920, 1440, 390].includes(width)) {
        await page.screenshot({ path: path.join(output, `${width}-${value}-large.png`), fullPage: false });
      }
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('[data-character-mode="full"]').click();
  await check("Full mode retains complete image inside each gutter", async () => {
    assert.equal(await page.locator("html").getAttribute("data-character-layout"), "full");
    assert.equal(await page.locator('[data-character-mode="full"]').getAttribute("aria-pressed"), "true");
    for (const selector of [".character-rail--left", ".character-rail--right"]) {
      const boxes = await page.locator(selector).evaluate((element) => ({ rail: element.getBoundingClientRect().toJSON(), image: element.querySelector(".character-ink").getBoundingClientRect().toJSON() }));
      assert.ok(boxes.image.x >= boxes.rail.x && boxes.image.right <= boxes.rail.right);
    }
  });
  for (const value of ["dark", "light"]) {
    await theme(value);
    await settle();
    await page.screenshot({ path: path.join(output, `1920-${value}-full.png`), fullPage: false });
  }
  await check("Opacity slider updates only the character layer", async () => {
    const background = (await geometry()).background;
    await page.locator("#characterOpacity").fill("50");
    assert.equal(await page.locator(".character-ink").first().evaluate((element) => getComputedStyle(element).opacity), "0.5");
    assert.equal((await geometry()).background, background);
  });
  await check("Hide characters restores central dashboard width", async () => {
    await page.locator("#showCharacters").uncheck();
    assert.equal((await geometry()).charactersVisible, false);
    assert.equal(Math.round((await geometry()).shell.width), 1440);
    await page.locator("#showCharacters").check();
  });
  await check("Dashboard interactions retain the selected layout", async () => {
    const total = await page.locator("#totalTokens").textContent();
    await page.locator('[data-character-mode="large"]').click();
    assert.equal(await page.locator("#totalTokens").textContent(), total);
    await theme("dark");
    assert.equal(await page.locator("html").getAttribute("data-character-layout"), "large");
    await page.locator("#dateRangeButton").click();
    assert.equal(await page.locator("#dateRangePicker").isVisible(), true);
    await page.screenshot({ path: path.join(output, "1920-dark-calendar.png"), fullPage: false });
    await page.keyboard.press("Escape");
  });
  await check("Offline preview has no external requests or page errors", async () => {
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
    const html = await readFile(path.join(output, "preview.html"), "utf8");
    assert.equal((html.match(/data:image\/png;base64,/g) || []).length, 2);
  });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(pathToFileURL(path.join(output, "viewer.html")).href);
  const embedded = page.frameLocator("#viewerFrame");
  await embedded.locator('[data-preset="all"]').click();
  await embedded.locator("#totalTokens").filter({ hasText: "13.10M" }).waitFor();
  await check("Narrow preview panel still displays the 1920px desktop composition", async () => {
    assert.equal(await embedded.locator("body").evaluate(() => innerWidth), 1920);
    assert.equal(await embedded.locator(".character-layer").isVisible(), true);
    assert.ok(await page.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  });
  await check("Preview viewer switches layout, theme and phone viewport", async () => {
    await page.locator('[data-viewer-mode="full"]').click();
    assert.equal(await embedded.locator("html").getAttribute("data-character-layout"), "full");
    await page.locator("#viewerTheme").click();
    assert.equal(await embedded.locator("html").getAttribute("data-theme"), "light");
    await page.locator("#viewerWidth").selectOption("390");
    await settle();
    assert.equal(await embedded.locator("body").evaluate(() => innerWidth), 390);
    assert.equal(await embedded.locator(".character-layer").isVisible(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
  });
} finally {
  await writeFile(path.join(output, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  await browser.close();
}
console.log(`${results.checks.length} browser checks passed.`);

// Android-sized Feed regression: real React Feed + VideoSurface + hls.js, mocked Tauri IPC, local media stalled.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "mobile-feed", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const viewport = { width: 412, height: 915 };
const userAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const report = { device: `Android UA, ${viewport.width}x${viewport.height}, touch`, passed: [], metrics: {} };
const stalled = [];
let vite, browser, page;
try {
  vite = await createServer({ root, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport, userAgent, isMobile: true, hasTouch: true });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin) return route.continue();
    if (url.hostname === "hg.localhost" && url.pathname === "/hls") {
      // A valid playlist whose only segment never arrives: the player stays loading, without an error overlay.
      return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "Access-Control-Allow-Origin": "*" },
        body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\nhttp://hg.localhost/seg?u=seg0\n#EXT-X-ENDLIST\n" });
    }
    if (url.hostname === "hg.localhost") { stalled.push(route); return undefined; }
    return route.abort();
  });
  const plays = () => page.evaluate(() => window.apiLoadingFixture.feedCalls.filter(r => r.cmd === "api_play").map(r => r.args.ep));
  const sections = () => page.locator("section").count();
  const swipe = async (fromX, toX, y = 400) => {
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) await page.mouse.move(fromX + ((toX - fromX) * step) / 8, y);
    await page.mouse.up();
  };

  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  const bar = page.locator('[role="slider"][aria-label="播放进度"]');
  await bar.waitFor({ state: "visible" });
  await page.locator("section video").waitFor({ state: "attached" });

  const box = await bar.boundingBox();
  const gap = viewport.height - (box.y + box.height);
  report.metrics.progress_bar = { touch_height_px: Math.round(box.height), bottom_gap_px: Math.round(gap) };
  assert(box.height >= 38, `Progress bar touch area is ${box.height}px`);
  assert(gap >= 56, `Progress bar touch area ends ${gap}px above the screen bottom`);
  report.passed.push("Portrait progress bar: 38px touch area, at least 56px above the bottom gesture area");

  assert.equal(await sections(), 1);
  await swipe(100, 300);
  await page.waitForFunction(() => document.querySelectorAll("section").length === 4);
  await page.locator("section").first().evaluate(section => { section.parentElement.scrollTop = section.parentElement.clientHeight; });
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_play" && r.args.ep === 2));
  await swipe(300, 100);
  await page.waitForFunction(() => document.querySelectorAll("section").length === 1);
  await page.getByText(/详情 · 第 2 集/).waitFor({ state: "visible" });
  report.metrics.episode_mode = { plays_requested: await plays() };
  report.passed.push("Swipe right lists the series' episodes, vertical swipe plays episode 2, swipe left returns and keeps episode 2");

  await page.getByRole("button", { name: "全屏", exact: true }).click();
  const unmute = page.getByRole("button", { name: "取消静音", exact: true });
  await unmute.waitFor({ state: "visible" });
  await unmute.click();
  await page.getByRole("button", { name: "静音", exact: true }).waitFor({ state: "visible" });
  await page.locator('button[aria-label="选集"]').click();
  const ep3 = page.getByRole("button", { name: "3", exact: true });
  await ep3.waitFor({ state: "visible" });
  // The sheet slides in; once settled, the episode button must be the topmost element at its own centre.
  const onTop = await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "3");
    if (!button) return false;
    const r = button.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && button.contains(hit);
  }, null, { timeout: 3000 }).then(() => true, () => false);
  assert(onTop, "Episode sheet must render above the fullscreen layer");
  await ep3.click();
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_play" && r.args.ep === 3));
  report.passed.push("Fullscreen: mute toggles; episodes button opens the sheet above the fullscreen layer and switches episodes");

  assert.deepEqual(errors, [], "No page errors");
  await page.screenshot({ path: join(output, "final.png") });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  for (const route of stalled) await route.abort().catch(() => {});
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}

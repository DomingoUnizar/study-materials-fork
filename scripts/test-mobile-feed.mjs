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
const mediaRequests = [];
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
    if (url.hostname === "hg.localhost" && (url.pathname === "/hls" || url.pathname.endsWith(".m3u8"))) {
      mediaRequests.push(url.pathname);
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

  // Offline cache: a cached episode plays from local files; online playback pauses downloads; the
  // cache sheet queues only episodes that are neither cached nor downloading.
  const offlineCalls = () => page.evaluate(() => window.apiLoadingFixture.feedCalls.filter(r => r.cmd.startsWith("offline_")).map(r => ({ cmd: r.cmd, args: r.args })));
  const until = async (check, what) => {
    for (let i = 0; i < 100 && !(await check()); i++) await new Promise(r => setTimeout(r, 50));
    assert(await check(), what);
  };
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile&offline=1`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  await until(() => mediaRequests.includes("/offline/991/1/index.m3u8"), "Cached episode loads its local playlist");
  assert.deepEqual(await plays(), [], "Cached episode must not request a play address");
  assert(!(await offlineCalls()).some(c => c.cmd === "offline_set_paused" && c.args.paused), "Local playback keeps downloads running");
  await page.getByRole("button", { name: "缓存", exact: true }).click();
  const cacheRest = page.getByRole("button", { name: /缓存本剧剩余 2 集/ });
  await cacheRest.waitFor({ state: "visible" });
  assert(await page.getByRole("button", { name: /缓存本集（第 1 集）/ }).isDisabled(), "A cached episode cannot be queued again");
  await cacheRest.click();
  await until(async () => (await offlineCalls()).some(c => c.cmd === "offline_enqueue"), "Cache sheet queues episodes");
  const enqueued = (await offlineCalls()).find(c => c.cmd === "offline_enqueue").args;
  assert.deepEqual([enqueued.vid, enqueued.eps], [991, [3, 4]], "Only episodes neither cached nor downloading are queued");
  await cacheRest.waitFor({ state: "detached" }); // the closing sheet's backdrop would swallow the swipe
  await swipe(100, 300);
  await page.waitForFunction(() => document.querySelectorAll("section").length === 4);
  await page.locator("section").first().evaluate(section => { section.parentElement.scrollTop = section.parentElement.clientHeight; });
  await until(async () => (await plays()).includes(2), "Uncached episode 2 requests a play address");
  await until(async () => (await offlineCalls()).some(c => c.cmd === "offline_set_paused" && c.args.paused === true), "Online playback pauses downloads");
  report.metrics.offline = { local_playlists: mediaRequests.filter(u => u.startsWith("/offline/")), queued: enqueued.eps };
  report.passed.push("Offline: cached episode plays locally without a play request; cache sheet queues episodes 3-4; online playback pauses downloads");

  // Favourites load in batches of 12 as the list scrolls; every detail is requested once.
  await page.evaluate(() => localStorage.setItem("hghub_app_v1", JSON.stringify({ favs: Array.from({ length: 30 }, (_, i) => 5000 + i) })));
  await page.goto(`${origin}tests/api-loading.html?page=profile&layout=mobile&detail=episodes`);
  const videoCalls = () => page.evaluate(() => window.apiLoadingFixture.feedCalls.filter(r => r.cmd === "api_video").map(r => r.args.id));
  await until(async () => (await videoCalls()).length >= 12, "First batch of favourites loads");
  await page.waitForTimeout(400);
  const firstLoad = (await videoCalls()).length;
  assert(firstLoad < 30, `Favourites must not all load at once (${firstLoad})`);
  for (let i = 0; i < 8 && (await videoCalls()).length < 30; i++) {
    await page.evaluate(() => { const el = document.querySelector(".scroll-y"); el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(250);
  }
  const ids = await videoCalls();
  assert.equal(ids.length, 30, "Scrolling reaches every favourite");
  assert.equal(new Set(ids).size, 30, "No favourite detail is requested twice");
  report.metrics.favourites = { total: 30, loaded_before_scrolling: firstLoad };
  report.passed.push("Profile: 30 favourites load in batches of 12 while scrolling, each detail requested once");
  await page.evaluate(() => localStorage.clear());

  await page.goto(`${origin}tests/api-loading.html?page=profile&layout=mobile&offline=1`);
  await page.getByRole("button", { name: "离线缓存", exact: true }).click();
  await page.getByText("测试短剧", { exact: true }).waitFor({ state: "visible" });
  await page.getByText(/已缓存 1\/2 集/).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "删除缓存", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await until(async () => (await offlineCalls()).some(c => c.cmd === "offline_delete" && c.args.vid === 991 && c.args.ep === null), "Delete removes the whole series");
  await page.getByText("还没有离线缓存", { exact: true }).waitFor({ state: "visible" });
  report.passed.push("Profile: offline tab lists the cached series with progress; delete needs a second tap");

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

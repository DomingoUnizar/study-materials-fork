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
const playlists = []; // upstream address behind every proxied playlist request
const coverPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
let hevcFailure = "403"; // how the hevc stream fails: "403" on its playlist, or "codec" (declares a codec the device cannot decode)
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
      const upstream = url.searchParams.get("u") || "";
      if (url.pathname === "/hls") playlists.push(upstream);
      const hevc = upstream.includes("-hevc.m3u8");
      if (hevc && hevcFailure === "403") return route.fulfill({ status: 403, headers: { "Access-Control-Allow-Origin": "*" }, body: "forbidden" });
      if (hevc && hevcFailure === "codec") {
        return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "Access-Control-Allow-Origin": "*" },
          body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1326000,RESOLUTION=720x1254,CODECS="hvc1.2.4.L93.90"\nhttp://hg.localhost/hls?u=hevc-media\n' });
      }
      // A valid playlist whose only segment never arrives: the player stays loading, without an error overlay.
      return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "Access-Control-Allow-Origin": "*" },
        body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.0,\nhttp://hg.localhost/seg?u=seg0\n#EXT-X-ENDLIST\n" });
    }
    if (url.hostname === "hg.localhost" && url.pathname === "/img") return route.fulfill({ status: 200, contentType: "image/png", body: coverPng });
    if (url.hostname === "hg.localhost") { stalled.push(route); return undefined; }
    return route.abort();
  });
  // The stalled test media never draws a frame; keep the first-frame callbacks so a test can fire them on purpose.
  await page.addInitScript(() => {
    const proto = HTMLVideoElement.prototype;
    const original = proto.requestVideoFrameCallback;
    if (!original) return;
    proto.requestVideoFrameCallback = function (callback) {
      (window.__frameCallbacks ||= []).push(callback);
      return original.call(this, callback);
    };
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
  // The bottom shade must reach the screen edge: anchored to the raised block it left a lighter band under the bar.
  const greyVideo = await page.addStyleTag({ content: "section video{visibility:hidden!important} section .bg-black{background:#c8c8c8!important}" });
  const strip = await page.screenshot({ clip: { x: 8, y: viewport.height - 150, width: 1, height: 150 } });
  await greyVideo.evaluate(el => el.remove());
  const decoder = await context.newPage();
  const shadeStep = await decoder.evaluate(async b64 => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const ctx = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d");
    ctx.drawImage(img, 0, 0);
    const level = Array.from({ length: img.height }, (_, y) => ctx.getImageData(0, y, 1, 1).data[1]);
    return Math.max(...level.slice(1).map((v, y) => Math.abs(v - level[y])));
  }, strip.toString("base64"));
  await decoder.close();
  report.metrics.progress_bar.bottom_shade_max_step = shadeStep;
  assert(shadeStep <= 8, `The bottom shade jumps ${shadeStep} levels below the progress bar`);
  report.passed.push("Portrait progress bar: 38px touch area, at least 56px above the bottom gesture area, bottom shade without a band");

  assert.equal(await sections(), 1);
  await swipe(100, 300); // left to right only returns from episode mode
  await page.waitForTimeout(300);
  assert.equal(await sections(), 1, "A left-to-right swipe outside episode mode does nothing");
  await swipe(300, 100);
  await page.waitForFunction(() => document.querySelectorAll("section").length === 4);
  await page.locator("section").first().evaluate(section => { section.parentElement.scrollTop = section.parentElement.clientHeight; });
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_play" && r.args.ep === 2));
  await swipe(100, 300);
  await page.waitForFunction(() => document.querySelectorAll("section").length === 1);
  await page.getByText(/详情 · 第 2 集/).waitFor({ state: "visible" });
  report.metrics.episode_mode = { plays_requested: await plays() };
  report.passed.push("Right-to-left swipe lists the series' episodes (left-to-right does not), vertical swipe plays episode 2, left-to-right swipe returns and keeps episode 2");

  // Long press plays 2x; sliding up locks it; another long press sliding down goes back to 1x.
  const rateNow = () => page.evaluate(() => document.querySelector("section video")?.playbackRate);
  const longPressSlide = async dy => {
    await page.mouse.move(206, 450);
    await page.mouse.down();
    await page.waitForTimeout(500);
    for (let s = 1; s <= 6; s++) await page.mouse.move(206, 450 + (dy * s) / 6);
    await page.mouse.up();
  };
  await longPressSlide(-120);
  await page.getByText(/已锁定 · 点按解除/).waitFor({ state: "visible" });
  assert.equal(await rateNow(), 2, "Long press + slide up locks 2x");
  await longPressSlide(120);
  await page.getByText(/已锁定 · 点按解除/).waitFor({ state: "detached" });
  assert.equal(await rateNow(), 1, "Long press + slide down returns to 1x");
  report.passed.push("Speed: long press + slide up locks 2x; long press + slide down returns to 1x");

  await page.getByRole("button", { name: "全屏", exact: true }).click();
  const unmute = page.getByRole("button", { name: "取消静音", exact: true });
  await unmute.waitFor({ state: "visible" });
  // Muting is real until sound has been on once. After that it keeps the audio output open at an inaudible volume:
  // closing and reopening the output freezes the picture and pops on Android WebView.
  const audio = () => page.evaluate(() => { const v = document.querySelector("section video"); return { muted: v.muted, volume: v.volume }; });
  assert.equal((await audio()).muted, true, "Before sound has been on, muting is real");
  await unmute.click();
  await page.getByRole("button", { name: "静音", exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(await audio(), { muted: false, volume: 0.7 }, "Sound on at the stored volume");
  await page.getByRole("button", { name: "静音", exact: true }).click();
  await unmute.waitFor({ state: "visible" });
  const silent = await audio();
  assert(!silent.muted && silent.volume < 0.001, `Muting after sound was on keeps the output open: ${JSON.stringify(silent)}`);
  await unmute.click();
  await page.getByRole("button", { name: "静音", exact: true }).waitFor({ state: "visible" });
  assert.deepEqual(await audio(), { muted: false, volume: 0.7 }, "Unmuting restores the volume");
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
  // Next to the current time in the fullscreen bar: play the following episode; disabled on the last one.
  const next = page.locator('button[aria-label="下一集"]');
  await next.click();
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_play" && r.args.ep === 4));
  await page.waitForFunction(() => document.querySelector('button[aria-label="下一集"]')?.disabled === true);
  report.passed.push("Fullscreen: mute toggles (after sound was on, muting keeps the output open); episodes button opens the sheet above the fullscreen layer and switches episodes; next-episode button plays episode 4, then is disabled on the last episode");

  // Episode mode on the last episode: sliding on towards a next episode says there is none.
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile&toasts=1`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  await page.locator("section video").waitFor({ state: "attached" });
  // Episode mode needs the series' episodes; until they arrive the swipe only says they are still loading.
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_video"));
  for (let i = 0; i < 5 && (await sections()) !== 4; i++) {
    await swipe(300, 100);
    await page.waitForTimeout(400);
  }
  assert.equal(await sections(), 4, "Episode mode lists the 4 episodes");
  await page.locator("section").first().evaluate(section => { section.parentElement.scrollTop = section.parentElement.clientHeight * 3; });
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_play" && r.args.ep === 4));
  await page.mouse.move(206, 600);
  await page.mouse.down();
  for (let s = 1; s <= 8; s++) await page.mouse.move(206, 600 - s * 25);
  await page.mouse.up();
  await page.getByText("没有下一集啦", { exact: true }).waitFor({ state: "visible" });
  report.passed.push("Episode mode: sliding on from the last episode says there is no next episode");

  // Switching episodes must not flash: every section keeps its cover underneath and, in portrait, the player has no
  // black backdrop of its own. Before, the incoming episode went cover → black → poster → black → video and the
  // outgoing one re-faded its cover from the placeholder.
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile&covers=1`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_video"));
  for (let i = 0; i < 5 && (await sections()) !== 4; i++) {
    await swipe(300, 100);
    await page.waitForTimeout(400);
  }
  assert.equal(await sections(), 4, "Episode mode lists the 4 episodes");
  await page.waitForFunction(() => document.querySelector("section video"));
  const shows = () => page.evaluate(() => [...document.querySelectorAll("section")].slice(0, 2).map(sec => {
    const v = sec.querySelector("video");
    const base = [...sec.querySelectorAll("img")].find(img => !v || !v.parentElement.contains(img));
    if (v && parseFloat(getComputedStyle(v).opacity) > 0.99) return "video";
    if (v && getComputedStyle(v.parentElement).backgroundColor !== "rgba(0, 0, 0, 0)") return "black";
    return base && base.complete && base.naturalWidth > 0 && parseFloat(getComputedStyle(base).opacity) > 0.95 ? "cover" : "placeholder";
  }));
  await page.waitForFunction(() => [...document.querySelectorAll("section img")].some(img => img.complete && img.naturalWidth > 0));
  await page.waitForTimeout(400);
  // Mid-swipe (both episodes half on screen) nothing switches yet: the outgoing episode keeps its video, the incoming
  // one only gets its address and playlist fetched ahead. Snapping is turned off and scrollend swallowed just to hold
  // the position the way a finger does (a scripted scroll ends at once).
  const playsOf = async ep => (await plays()).filter(e => e === ep).length;
  await page.locator("section").first().evaluate(section => {
    window.__holdSwipe = event => event.stopPropagation();
    window.addEventListener("scrollend", window.__holdSwipe, true);
    section.parentElement.style.scrollSnapType = "none";
    section.parentElement.scrollTop = section.parentElement.clientHeight * 0.6;
  });
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_play" && r.args.ep === 2));
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "media_prefetch"));
  await page.waitForTimeout(300);
  assert(await page.evaluate(() => !!document.querySelectorAll("section")[0].querySelector("video") && !document.querySelectorAll("section")[1].querySelector("video")),
    "Mid-swipe the outgoing episode keeps its video and the incoming one has no player yet");
  await page.locator("section").first().evaluate(section => {
    window.removeEventListener("scrollend", window.__holdSwipe, true);
    section.parentElement.scrollTop = section.parentElement.clientHeight;
    section.parentElement.style.scrollSnapType = "";
  });
  assert.deepEqual(await shows(), ["cover", "cover"], "Right after the switch both episodes show their cover");
  await page.waitForFunction(() => document.querySelectorAll("section")[1]?.querySelector("video"));
  assert.deepEqual(await shows(), ["cover", "cover"], "Once the next player mounts, its cover stays until the video can fade in over it");
  assert.equal(await playsOf(2), 1, "The settled episode plays the address fetched mid-swipe instead of asking again");
  // Buffered data is not a drawn frame (Android's hardware decoder needs a few hundred ms more, and showing the element
  // early flashes its black background): the video stays see-through until the browser reports the first frame.
  const look = () => page.evaluate(() => {
    const style = getComputedStyle(document.querySelectorAll("section")[1].querySelector("video"));
    return { opacity: parseFloat(style.opacity), background: style.backgroundColor };
  });
  await page.evaluate(() => document.querySelectorAll("section")[1].querySelector("video").dispatchEvent(new Event("loadeddata")));
  await page.waitForTimeout(300);
  const beforeFrame = await look();
  assert(beforeFrame.opacity < 0.05 && beforeFrame.background === "rgba(0, 0, 0, 0)", `Data alone does not show the video: ${JSON.stringify(beforeFrame)}`);
  await page.evaluate(() => (window.__frameCallbacks || []).splice(0).forEach(cb => cb(performance.now(), {})));
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelectorAll("section")[1].querySelector("video")).opacity) > 0.99);
  assert.equal((await look()).background, "rgb(0, 0, 0)", "Once a frame is drawn the video shows, with its black backdrop for letterboxing");
  report.passed.push("Switching episodes: nothing switches mid-swipe (the next episode is only fetched ahead), both sections keep their cover, and the video shows only once its first frame is drawn");

  // Back from the background the video layer often stays white on Android while playback goes on; the player
  // swaps in a new video element (same address, no new play request). A blink shorter than 0.8 s keeps it.
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  await page.locator("section video").waitFor({ state: "attached" });
  const background = ms => page.evaluate(async away => {
    window.__vis = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__vis === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise(r => setTimeout(r, away));
    window.__vis = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  }, ms);
  const markVideo = () => page.evaluate(() => { document.querySelector("section video").__before = true; });
  const sameVideo = () => page.evaluate(() => document.querySelector("section video")?.__before === true);
  const playsBefore = (await plays()).length;
  await markVideo();
  await background(200);
  await page.waitForTimeout(300);
  assert(await sameVideo(), "A blink shorter than 0.8 s keeps the video element");
  await background(1000);
  await page.waitForFunction(() => { const v = document.querySelector("section video"); return v && v.__before !== true; });
  assert.equal((await plays()).length, playsBefore, "Rebuilding the player reuses the play address");
  report.passed.push("Back from the background: the player swaps in a new video element with the same address (not after a sub-second blink)");

  // Offline cache: a cached episode plays from local files; online playback pauses downloads; the
  // cache sheet queues only episodes that are neither cached nor downloading.
  const offlineCalls = () => page.evaluate(() => window.apiLoadingFixture.feedCalls.filter(r => r.cmd.startsWith("offline_")).map(r => ({ cmd: r.cmd, args: r.args })));
  const until = async (check, what, tries = 100) => {
    for (let i = 0; i < tries && !(await check()); i++) await new Promise(r => setTimeout(r, 50));
    assert(await check(), what);
  };
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile&offline=1`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  await until(() => mediaRequests.includes("/offline/991/1/index.m3u8"), "Cached episode loads its local playlist");
  assert.deepEqual(await plays(), [], "Cached episode must not request a play address");
  assert(!(await offlineCalls()).some(c => c.cmd === "offline_set_paused" && c.args.paused), "Local playback keeps downloads running");
  await page.getByRole("button", { name: "缓存", exact: true }).click();
  // The sheet lists every episode to pick from. Cached and downloading ones cannot be picked again; the episode
  // on screen (1) is already cached, so nothing starts out picked.
  const cell = n => page.getByRole("button", { name: new RegExp(`^第 ${n} 集`) });
  const queueButton = page.getByRole("button", { name: /缓存所选|先点选/ });
  await cell(4).waitFor({ state: "visible" });
  assert(await cell(1).isDisabled(), "A cached episode cannot be queued again");
  assert(await cell(2).isDisabled(), "A downloading episode cannot be queued again");
  assert(await queueButton.isDisabled(), "Nothing is picked while the episode on screen is cached");
  await cell(4).click();
  await page.getByRole("button", { name: "缓存所选 1 集", exact: true }).waitFor({ state: "visible" });
  await cell(4).click(); // picking again un-picks
  assert(await queueButton.isDisabled(), "Un-picking leaves nothing to queue");
  await page.getByRole("button", { name: "全选", exact: true }).click();
  assert.equal(await cell(3).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "缓存所选 2 集", exact: true }).click();
  await until(async () => (await offlineCalls()).some(c => c.cmd === "offline_enqueue"), "Cache sheet queues episodes");
  const enqueued = (await offlineCalls()).find(c => c.cmd === "offline_enqueue").args;
  assert.deepEqual([enqueued.vid, enqueued.eps], [991, [3, 4]], "Only the picked episodes are queued");
  await queueButton.waitFor({ state: "detached" }); // the closing sheet's backdrop would swallow the swipe
  await swipe(300, 100);
  await page.waitForFunction(() => document.querySelectorAll("section").length === 4);
  await page.locator("section").first().evaluate(section => { section.parentElement.scrollTop = section.parentElement.clientHeight; });
  await until(async () => (await plays()).includes(2), "Uncached episode 2 requests a play address");
  await until(async () => (await offlineCalls()).some(c => c.cmd === "offline_set_paused" && c.args.paused === true), "Online playback pauses downloads while it starts");
  // Downloads only give way while the video on screen is short of data: with 15 s or more buffered ahead they go on
  // (watching and caching at once); buffering pauses them again.
  const pausedState = async () => (await offlineCalls()).filter(c => c.cmd === "offline_set_paused").map(c => c.args.paused).at(-1);
  await page.evaluate(() => {
    const v = document.querySelector("section video");
    Object.defineProperty(v, "buffered", { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 30 }) });
    v.dispatchEvent(new Event("playing"));
    v.dispatchEvent(new Event("timeupdate"));
  });
  await until(async () => (await pausedState()) === false, "With enough buffered the download goes on during playback");
  await page.evaluate(() => document.querySelector("section video").dispatchEvent(new Event("waiting")));
  await until(async () => (await pausedState()) === true, "Buffering pauses the download again");
  report.metrics.offline = { local_playlists: mediaRequests.filter(u => u.startsWith("/offline/")), queued: enqueued.eps };
  report.passed.push("Offline: cached episode plays locally without a play request; the cache sheet picks episodes one by one (cached/downloading ones locked, select all) and queues 3-4; online playback pauses downloads only while it is short of buffer");

  // A download stopped by a network interruption waits in the queue; it goes on when the app comes back to the
  // foreground (or the network returns), and the cache list says why it stopped.
  await page.goto(`${origin}tests/api-loading.html?page=profile&layout=mobile&offline=1&interrupted=1`);
  await page.getByRole("button", { name: "离线缓存", exact: true }).click();
  await page.getByText(/第 2 集网络中断（网络超时），回到应用后自动继续/).waitFor({ state: "visible" });
  await page.getByText(/第 3 集失败（HTTP 404），点集数重试/).waitFor({ state: "visible" });
  const resumes = async () => (await offlineCalls()).filter(c => c.cmd === "offline_resume").length;
  assert.equal(await resumes(), 0, "Nothing resumes on its own");
  await background(50);
  await until(async () => (await resumes()) === 1, "Coming back to the app resumes the interrupted download");
  await page.getByRole("button", { name: /^第 2 集/ }).click();
  await until(async () => (await resumes()) === 2, "Tapping the interrupted episode resumes it");
  report.passed.push("Offline: an interrupted download shows why and resumes when the app returns to the foreground or the episode is tapped; failures show their reason");

  // Sleep timer (clock button, top right): 「播完本集」stops at the end of the episode instead of playing the next
  // one; a timed choice pauses the video when the time is up. Either way the timer is off afterwards.
  playlists.length = 0;
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile&toasts=1`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  await page.locator("section video").waitFor({ state: "attached" });
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_video"));
  await until(() => playlists.length > 0, "Episode 1 loads");
  const endEpisode = () => page.evaluate(() => document.querySelector("section video").dispatchEvent(new Event("ended")));
  const loadedBeforeEnd = playlists.length;
  await endEpisode();
  await until(async () => (await plays()).includes(2), "Without a timer the next episode follows");
  await until(() => playlists.length > loadedBeforeEnd, "Episode 2 loads");
  const clock = page.getByRole("button", { name: "定时关闭", exact: true });
  assert.equal(await clock.getAttribute("aria-pressed"), "false");
  await clock.click();
  const afterEpisode = page.getByRole("button", { name: "播完本集", exact: true });
  await afterEpisode.click();
  await page.getByText("本集播完后暂停播放", { exact: true }).waitFor({ state: "visible" });
  await afterEpisode.waitFor({ state: "detached" });
  assert.equal(await clock.getAttribute("aria-pressed"), "true", "The clock shows the timer is on");
  const playsAtEnd = (await plays()).length;
  await endEpisode();
  await page.getByText("定时关闭：本集已播完", { exact: true }).waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  assert.equal((await plays()).length, playsAtEnd, "「播完本集」stops instead of playing episode 3");
  assert.equal(await clock.getAttribute("aria-pressed"), "false", "The timer is off once it has stopped playback");
  await clock.click();
  await page.getByRole("button", { name: "30 分钟", exact: true }).click();
  await page.getByRole("button", { name: "30 分钟", exact: true }).waitFor({ state: "detached" });
  await clock.click();
  await page.getByText(/^将在 \d\d:\d\d 暂停播放$/).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("button", { name: "30 分钟", exact: true }).getAttribute("aria-pressed"), "true", "The sheet marks the running choice");
  await page.getByRole("button", { name: "取消定时", exact: true }).click();
  await page.getByRole("button", { name: "30 分钟", exact: true }).waitFor({ state: "detached" });
  assert.equal(await clock.getAttribute("aria-pressed"), "false", "取消定时 switches it off");
  // Time up: the same module call the sheet makes, with a 60 ms timer.
  await page.evaluate(() => { const v = document.querySelector("section video"); v.__pauses = 0; const pause = v.pause.bind(v); v.pause = () => { v.__pauses++; pause(); }; });
  await page.evaluate(async () => (await import("/src/sleepTimer.ts")).setSleepTimer(0.001));
  await page.getByText("定时关闭：已暂停播放", { exact: true }).waitFor({ state: "visible" });
  assert(await page.evaluate(() => document.querySelector("section video").__pauses > 0), "Time up pauses the video");
  assert.equal(await clock.getAttribute("aria-pressed"), "false");
  report.passed.push("Sleep timer: the clock button opens it; 「播完本集」stops at the end instead of playing the next episode; a timed choice pauses the video when time is up; 取消定时 switches it off");

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

  // Favourite updates: a check compares every favourite's episode count with the last one seen (the fixture
  // detail has 4 episodes). Updated favourites move to the front with a badge and a count on the tab; checks are
  // at least 6 hours apart; seeing the series clears its badge.
  const favUpdates = (fn, ...args) => page.evaluate(async ([name, rest]) => (await import("/src/favUpdates.ts"))[name](...rest), [fn, args]);
  const seenTwoOfFour = () => page.evaluate(() => {
    localStorage.setItem("hghub_app_v1", JSON.stringify({ favs: [5001, 991] }));
    localStorage.setItem("hghub_fav_seen", JSON.stringify({ 991: 2, 5001: 4 }));
  });
  // The timed check (start-up / back in the foreground) runs on a page that does not load the favourites itself.
  await seenTwoOfFour();
  await page.goto(`${origin}tests/api-loading.html?page=home&detail=episodes`);
  await page.waitForFunction(() => window.apiLoadingFixture?.ready);
  assert.deepEqual(await favUpdates("checkFavUpdates", [5001, 991]), [991], "Only the favourite with new episodes is reported");
  assert.deepEqual(await favUpdates("checkFavUpdates", [5001, 991]), [], "A second check within 6 hours is skipped");
  await page.goto(`${origin}tests/api-loading.html?page=profile&layout=mobile&detail=episodes`);
  await page.getByText("更新至 4 集", { exact: true }).waitFor({ state: "visible" });
  assert.match(await page.getByRole("button", { name: /我的收藏/ }).innerText(), /我的收藏\s*·\s*1/, "The favourites tab shows the update count");
  const firstCard = await page.locator(".grid button").first().innerText();
  assert(firstCard.includes("更新至 4 集"), "The updated favourite comes first");
  // Every favourite's cover says how many episodes it has; an updated one says 更新至 N 集 in that place instead.
  assert(!firstCard.includes("4集"), "The updated favourite does not repeat its episode count");
  // Top-left badge like the category cards: "N集", or "完结 · N集" once the series is finished.
  assert.equal(await page.getByText("4集", { exact: true }).count(), 1, "The other favourite shows its episode count in the corner");
  const badge = await page.getByText("4集", { exact: true }).boundingBox();
  const cardBox = await page.locator(".grid button").nth(1).boundingBox();
  assert(badge.y - cardBox.y < 20 && badge.x - cardBox.x < 20, "The episode count sits in the top-left corner");
  await favUpdates("markSeen", 991, 4);
  await page.getByText("更新至 4 集", { exact: true }).waitFor({ state: "detached" });
  assert.equal(await page.getByText("4集", { exact: true }).count(), 2, "Once seen, it shows its episode count again");
  await page.evaluate(() => localStorage.clear());

  // Opening the favourites compares the details the page loads anyway: the update shows at once, before the timed
  // check is due again, and without any extra request.
  await seenTwoOfFour();
  await page.evaluate(() => localStorage.setItem("hghub_fav_checked_at", String(Date.now())));
  await page.goto(`${origin}tests/api-loading.html?page=profile&layout=mobile&detail=episodes`);
  await page.getByText("更新至 4 集", { exact: true }).waitFor({ state: "visible" });
  assert((await page.locator(".grid button").first().innerText()).includes("更新至 4 集"), "The update found on opening comes first");
  assert.deepEqual((await videoCalls()).sort((a, b) => a - b), [991, 5001], "Only the details the page shows are requested");
  await page.evaluate(() => localStorage.clear());

  // A check that gets nothing (offline, upstream down) gives up after a few failures and does not count: the next
  // return to the app checks again instead of waiting 6 hours.
  const tenFavs = Array.from({ length: 10 }, (_, i) => 6000 + i);
  await page.evaluate(favs => localStorage.setItem("hghub_app_v1", JSON.stringify({ favs })), tenFavs);
  await page.goto(`${origin}tests/api-loading.html?page=home`); // every detail request fails here
  await page.waitForFunction(() => window.apiLoadingFixture?.ready);
  assert.deepEqual(await favUpdates("checkFavUpdates", tenFavs), []);
  const failedCalls = (await videoCalls()).length;
  assert(failedCalls > 0 && failedCalls <= 4, `A failing check stops after a few requests (${failedCalls})`);
  assert.equal(await page.evaluate(() => localStorage.getItem("hghub_fav_checked_at")), null, "A check that got nothing does not count");
  report.passed.push("Favourite updates: new episodes are found per favourite, shown first with a badge and a tab count; timed checks are 6 hours apart, a check that got nothing does not count; opening the favourites shows updates at once with no extra requests; seeing the series clears it; every favourite's cover shows its episode count in the top-left corner");
  await page.evaluate(() => localStorage.clear());

  // HEVC: an Android device that reports HEVC support tries the hevc stream first (same resolution, about
  // half the bitrate); when it fails, the same episode switches to H.264 without the error overlay. A decode
  // failure stops preferring HEVC on this device, a network failure does not. Offline caching uses hevc only
  // once hevc has actually played on this device.
  await page.addInitScript(() => {
    if (!location.search.includes("hevc=1")) return;
    // The simulated device decodes HEVC Main (what the app checks) but no other HEVC profile, whatever the host supports.
    const original = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = type => /(hvc1|hev1)\.1\.6\.L120/.test(type) || (!/hvc1|hev1/.test(type) && original(type));
  });
  const openHevcFeed = async failure => {
    hevcFailure = failure;
    playlists.length = 0;
    await page.goto(`${origin}tests/api-loading.html?page=home&play=signed&detail=episodes&layout=mobile&hevc=1`);
    await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
    await page.evaluate(() => window.apiLoadingFixture.complete("api_feed", "", "item"));
  };
  const usesMain = () => playlists.some(u => u.includes("/ep1.m3u8"));
  const errorOverlays = () => page.getByRole("button", { name: "重新加载" }).count();
  const cacheThisEpisode = async () => {
    const queued = async () => (await offlineCalls()).filter(c => c.cmd === "offline_enqueue");
    const before = (await queued()).length;
    await page.getByRole("button", { name: "缓存", exact: true }).click();
    // The episode on screen starts out picked
    const button = page.getByRole("button", { name: "缓存所选 1 集", exact: true });
    await button.click();
    await until(async () => (await queued()).length > before, "Cache sheet queues the episode");
    await button.waitFor({ state: "detached" });
    return (await queued()).at(-1).args.hevc;
  };

  await openHevcFeed("403");
  await until(usesMain, "Rejected hevc playlist falls back to H.264");
  const networkFallback = playlists.map(u => u.split("?")[0].split("/").pop());
  assert.equal(networkFallback[0], "ep1-hevc.m3u8", `The hevc playlist is tried first: ${networkFallback}`);
  await page.waitForTimeout(300);
  assert.equal(await errorOverlays(), 0, "Falling back to H.264 shows no error overlay");
  assert.equal(await page.evaluate(() => localStorage.getItem("hghub_hevc_off")), null, "A network failure keeps HEVC preferred");
  assert.equal(await cacheThisEpisode(), false, "Offline cache stays H.264 until hevc has played on this device");
  await page.evaluate(() => localStorage.setItem("hghub_hevc_ok", "1"));
  assert.equal(await cacheThisEpisode(), true, "Once hevc has played on this device, offline cache uses hevc");

  await page.evaluate(() => localStorage.clear());
  const started = Date.now();
  await openHevcFeed("codec");
  await until(usesMain, "An hevc codec the device cannot decode falls back to H.264");
  const decodeFallbackMs = Date.now() - started;
  assert.equal(await page.evaluate(() => localStorage.getItem("hghub_hevc_off")), "1", "A decode failure stops preferring HEVC");
  await page.waitForTimeout(300);
  assert.equal(await errorOverlays(), 0, "Decode fallback shows no error overlay");
  await openHevcFeed("codec");
  await until(() => playlists.length > 0, "Next play requests a playlist");
  await page.waitForTimeout(300);
  assert(playlists.every(u => !u.includes("-hevc")), `After a decode failure this device plays H.264 directly: ${playlists}`);
  // The settings switch shows why HEVC is off, can retry it, and can turn it off by hand.
  const hevc = (fn, ...args) => page.evaluate(async ([name, rest]) => {
    const m = await import("/src/hevc.ts");
    m[name]?.(...rest);
    return { status: m.hevcStatus(), prefer: m.preferHevc() };
  }, [fn, args]);
  assert.deepEqual(await hevc("hevcStatus"), { status: "auto_off", prefer: false }, "Settings explain the automatic switch to H.264");
  assert.deepEqual(await hevc("setHevcEnabled", true), { status: "on", prefer: true }, "Turning it back on retries HEVC");
  assert.deepEqual(await hevc("setHevcEnabled", false), { status: "off", prefer: false }, "Turning it off plays H.264 only");
  await openHevcFeed("403");
  await until(() => playlists.length > 0, "Next play requests a playlist");
  await page.waitForTimeout(300);
  assert(playlists.every(u => !u.includes("-hevc")), `Switched off by hand, HEVC is not tried: ${playlists}`);
  report.metrics.hevc = { network_fallback: networkFallback, decode_fallback_ms: decodeFallbackMs };
  report.passed.push("HEVC: tried first, falls back to H.264 without an error overlay; decode failure disables it; cache uses hevc only after it played; settings switch retries or turns it off");
  await page.evaluate(() => localStorage.clear());

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

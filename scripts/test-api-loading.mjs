// Fault injection is local only; real React pages + api.call, mocked Tauri IPC.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "test-results", "api-loading", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(output, { recursive: true });
const report = { transport: "local browser fixture; Tauri IPC mocked", passed: [], external: [] };
let vite, browser, page;
try {
  vite = await createServer({ root, server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await vite.listen();
  const origin = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  const errors = [];
  const mediaRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (new URL(url).origin === new URL(origin).origin) return route.continue();
    // Local media protocol: answer the way the Rust proxy does when the upstream rejects an expired signature
    // (media::upstream_status keeps 403 so hls.js does not retry it).
    if (new URL(url).hostname === "hg.localhost") {
      mediaRequests.push(url);
      return route.fulfill({ status: 403, contentType: "text/plain", headers: { "Access-Control-Allow-Origin": "*" }, body: "HTTP 403 Forbidden" });
    }
    report.external.push(url); return route.abort();
  });
  const complete = (cmd, key, result) => page.evaluate(args => window.apiLoadingFixture.complete(...args), [cmd, key, result]);
  const calls = () => page.evaluate(() => window.apiLoadingFixture.history);
  const visible = async locator => { await locator.waitFor({ state: "visible" }); };

  await page.goto(`${origin}tests/api-loading.html?page=home`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await complete("api_feed", "", "404");
  await visible(page.getByText("首页加载失败", { exact: true }));
  await visible(page.getByText(/服务器请求失败（HTTP 404）/));
  assert.equal(await page.locator(".spinner").count(), 0, "Failed home must stop spinning");
  assert(!await page.locator("body").innerText().then(s => s.includes("<html>")), "Hide gateway HTML from UI");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 2);
  await complete("api_feed", "", "empty");
  await visible(page.getByText("暂无视频", { exact: true }));
  assert.equal(await page.locator(".spinner").count(), 0);
  report.passed.push("Home: 404 ends loading, readable error, explicit retry, empty result");

  // While a video plays, Feed writes watch progress to the store every 5s. Those unrelated store
  // writes must not re-request (and log) a video detail that already failed or is still loading.
  await page.goto(`${origin}tests/api-loading.html?page=home`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await complete("api_feed", "", "item");
  await page.waitForFunction(() => window.apiLoadingFixture.feedCalls.some(r => r.cmd === "api_video"));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const feedStats = () => page.evaluate(() => ({
    video: window.apiLoadingFixture.feedCalls.filter(r => r.cmd === "api_video").length,
    debug: window.apiLoadingFixture.debug.filter(line => line.includes("api_video")).length,
  }));
  await settle();
  const before = await feedStats();
  const writes = 6;
  for (let i = 1; i <= writes; i++) {
    await page.evaluate(t => window.apiLoadingFixture.saveProgress(t), i * 5);
    await settle();
  }
  const after = await feedStats();
  report.metrics = { progress_writes: writes, api_video_before: before.video, api_video_after: after.video, api_video_debug_lines_added: after.debug - before.debug };
  assert.equal(after.video - before.video, 0, `Progress writes re-requested video details ${after.video - before.video} times`);
  assert.equal(after.debug - before.debug, 0, "Progress writes must not append repeated detail failures to debug.log");
  report.passed.push("Home: watch-progress writes do not re-request or re-log failed video details");

  // Play addresses carry time-limited auth_key signatures. A stale address must end in the error
  // overlay (not an endless spinner), and "重新加载" must fetch a fresh address instead of retrying it.
  await page.goto(`${origin}tests/api-loading.html?page=home&play=signed`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  await complete("api_feed", "", "item");
  const signature = url => /auth_key%3D(\d+)/.exec(url)?.[1];
  const started = Date.now();
  await page.getByText("视频暂时无法加载", { exact: true }).waitFor({ state: "visible", timeout: 45000 });
  const overlayMs = Date.now() - started;
  const stale = signature(mediaRequests.at(-1) || "");
  assert(stale, "Player requested the signed playlist");
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  const deadline = Date.now() + 15000;
  while (!mediaRequests.some(url => Number(signature(url)) > Number(stale)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  const fresh = mediaRequests.map(signature).filter(s => Number(s) > Number(stale));
  report.metrics.expired_signature = { overlay_ms: overlayMs, stale_auth_key: stale, fresh_auth_key: fresh[0] ?? null, playlist_requests: mediaRequests.length };
  assert(fresh.length > 0, "Reload must request a newly signed play address");
  report.passed.push("Feed: stale signed address shows the error overlay; reload fetches a fresh address");

  // Upstream's recommendation order never changes, so Home picks random pages: with the page count known from an
  // earlier visit (50 pages) and Math.random fixed at 0.5, the first request is page 26 instead of page 1.
  await page.addInitScript(() => {
    if (!location.search.includes("random=1")) return;
    localStorage.setItem("hghub_feed_pages", "50");
    Math.random = () => 0.5;
  });
  await page.goto(`${origin}tests/api-loading.html?page=home&random=1`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  const firstPage = (await calls())[0].args.page;
  assert.equal(firstPage, 26, `Home starts on a random page (got page ${firstPage})`);
  await page.evaluate(() => localStorage.clear());
  report.passed.push("Home: starts on a random page among the known pages instead of always page 1");

  await page.goto(`${origin}tests/api-loading.html`);
  await page.waitForFunction(() => window.apiLoadingFixture.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await calls()).length, 0, "Hidden categories must not prefetch");
  await page.evaluate(() => window.apiLoadingFixture.setActive(true));
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 3);
  // 「AI换脸」「AI魔改」are gone upstream (HTTP 410 内容已下线): not listed, not requested.
  for (const gone of ["AI换脸", "AI魔改"]) assert.equal(await page.getByRole("region", { name: gone, exact: true }).count(), 0, `${gone} is not listed`);
  assert(!(await calls()).some(r => ["ai-huanlian", "ai-mogai"].includes(r.args.cate)), "Removed channels are not requested");
  await complete("api_category", "ai-duanju", "item");
  await visible(page.getByText("已加载ai-duanju", { exact: true }));
  await visible(page.getByRole("region", { name: "AI成人漫剧", exact: true }).getByText("加载中…", { exact: true }));
  await complete("api_posts", "", "item");
  await visible(page.getByText("已加载api_posts", { exact: true }));
  await complete("api_category", "ai-manju", "503");
  await page.getByRole("button", { name: "重试AI成人漫剧", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 4);
  await complete("api_category", "ai-manju", "empty");
  await visible(page.getByRole("region", { name: "AI成人漫剧", exact: true }).getByText("暂无内容", { exact: true }));
  assert.equal((await calls()).filter(r => r.args.cate === "ai-duanju").length, 1, "Retry must only reload the failed channel");
  await page.evaluate(() => window.apiLoadingFixture.setActive(false));
  await page.evaluate(() => window.apiLoadingFixture.setActive(true));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal((await calls()).length, 4, "Revisiting must preserve previews without reloading all channels");
  report.passed.push("Category: only live channels (AI换脸/AI魔改 removed), defer hidden loading, show successful rows/posts before slow row, independent error/retry, preserve data on revisit");
  // Channel sorting: 「最新」asks upstream for newest first; 「最热」is upstream's default order; 「高分」re-sorts locally.
  await page.goto(`${origin}tests/api-loading.html?page=channel`);
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 1);
  assert.equal((await calls())[0].args.sort, "new", "最新 requests sort=new");
  await page.getByRole("button", { name: "最热", exact: true }).click();
  await page.waitForFunction(() => window.apiLoadingFixture.history.length === 2);
  assert.equal((await calls())[1].args.sort, null, "最热 uses the default upstream order");
  await page.getByRole("button", { name: "高分", exact: true }).click();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  assert.equal((await calls()).length, 2, "高分 only re-sorts what is loaded");
  // Series tagged 男同 are hidden by default. Cards fill the grid row by row: CSS columns filled the left column
  // first and moved cards between columns whenever a page loaded, so the right column kept losing its covers.
  await complete("api_category", "ai-duanju", "mixed"); // the superseded 最新 request: ignored
  await complete("api_category", "ai-duanju", "mixed");
  await visible(page.getByText("另一部", { exact: true }));
  assert.equal(await page.getByText("男同题材", { exact: true }).count(), 0, "Series tagged 男同 are hidden");
  const firstCard = await page.getByText("已加载ai-duanju", { exact: true }).boundingBox();
  const secondCard = await page.getByText("另一部", { exact: true }).boundingBox();
  assert(Math.abs(firstCard.y - secondCard.y) < 2 && secondCard.x > firstCard.x, "Cards fill the grid row by row");
  assert.equal(await page.getByText("共 1 集", { exact: true }).count(), 4, "Every card shows its episode count above the title");
  report.passed.push("Channel: 最新 uses upstream sort=new, 最热 the default order, 高分 sorts locally; 男同-tagged series hidden; grid fills row by row; episode count on every cover");
  assert.deepEqual(errors, [], "No page errors");
  assert.deepEqual(report.external, [], "No upstream traffic");
  await page.screenshot({ path: join(output, "final.png"), fullPage: true });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser?.close();
  await vite?.close();
  console.log(`Artifacts: ${output}`);
}

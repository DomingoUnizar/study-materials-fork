import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../src/pages/Home";
import Category, { ChannelPage } from "../src/pages/Category";
import Profile from "../src/pages/Profile";
import { initOffline } from "../src/offline";
import { AppProvider, useStore } from "../src/store";
import { ToastHost } from "../src/components/ui";
import "../src/index.css";

type Request = { cmd: string; args: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: string) => void };
const params = new URLSearchParams(location.search);
const signedPlayUrls = params.get("play") === "signed";
const withEpisodes = params.get("detail") === "episodes";
// Upstream also offers an hevc stream for every episode (same resolution, about half the bitrate).
const hevcStreams = params.get("hevc") === "1";
// Series detail with a real cover image (the test serves it), to check what each section shows while switching.
const withCovers = params.get("covers") === "1";
// Offline cache fixture: series 991, episode 1 cached, episode 2 still downloading. With interrupted=1, episode 2
// instead waits in the queue after a network interruption, and episode 3 failed for good.
const interruptedDownload = params.get("interrupted") === "1";
const offlineList = params.get("offline") === "1" ? {
  episodes: [
    { vid: 991, ep: 1, title: "测试短剧", state: "done", done: 3, total: 3, bytes: 3 * 1024 * 1024, seq: 1 },
    interruptedDownload
      ? { vid: 991, ep: 2, title: "测试短剧", state: "queued", error: "网络超时", done: 1, total: 2, bytes: 1024 * 1024, seq: 2 }
      : { vid: 991, ep: 2, title: "测试短剧", state: "downloading", done: 1, total: 2, bytes: 1024 * 1024, seq: 2 },
    ...(interruptedDownload ? [{ vid: 991, ep: 3, title: "测试短剧", state: "error", error: "HTTP 404", done: 0, total: 0, bytes: 0, seq: 3 }] : []),
  ],
  series: { 991: { id: 991, title: "测试短剧", cover: "", description: "", tags: [], score: 0, episode_count: 4, total_episodes: 4,
    episodes: [1, 2, 3, 4].map(ep_num => ({ ep_num, title: `第${ep_num}集`, duration: 60, status: 1 })) } },
} : { episodes: [], series: {} };
const pending: Request[] = [];
const fixture = {
  history: [] as { cmd: string; args: Record<string, unknown> }[],
  feedCalls: [] as { cmd: string; args: Record<string, unknown> }[],
  debug: [] as string[],
  ready: false,
  setActive: (_active: boolean) => {},
  saveProgress: (_t: number) => {},
  complete(cmd: string, key: string, result: "404" | "503" | "empty" | "item" | "mixed") {
    const index = pending.findIndex(r => r.cmd === cmd && (!key || r.args.cate === key));
    if (index < 0) throw new Error(`No pending request: ${cmd}/${key}`);
    const request = pending.splice(index, 1)[0];
    if (result === "404" || result === "503") {
      request.reject(`HTTP ${result} Gateway: <html><h1>nginx error</h1></html>`);
      return;
    }
    const card = (id: number, title: string, tags: string[]) => ({
      id, title, cover: "", tags, score: 0, hot: 0, episode_count: 1, total_episodes: 1, is_finished: true, is_original: 0,
      like_count: 0, comment_count: 0, collect_count: 0,
    });
    // "mixed": four series plus one tagged 男同 (hidden by the default tag filter) in second place
    const items = result === "empty" ? [] : result === "mixed"
      ? [card(991, `已加载${key || cmd}`, []), card(992, "男同题材", ["都市", "男同"]), card(993, "另一部", ["校园"]),
        card(994, "第三部", ["古风"]), card(995, "第四部", ["职场"])]
      : [card(991, `已加载${key || cmd}`, [])];
    // "mixed" also reports the channel's full upstream size, far more than one loaded page
    request.resolve({ items, pagination: { page: 1, pages: 1, size: 8, total: result === "mixed" ? 1764 : items.length } });
  },
};

// Preserve the real api.call error formatting and React pages; replace only Tauri IPC.
Object.assign(window, {
  apiLoadingFixture: fixture,
  __TAURI_INTERNALS__: { invoke(cmd: string, args: Record<string, unknown> = {}) {
    if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
    if (cmd === "debug_log") { fixture.debug.push(String(args.msg)); return Promise.resolve(); }
    // Feed detail/play requests fail like an unavailable upstream; record them to count re-requests.
    if (cmd.startsWith("offline_")) {
      fixture.feedCalls.push({ cmd, args });
      return Promise.resolve(cmd === "offline_list" ? offlineList : null);
    }
    if (cmd === "api_video" || cmd === "api_play") {
      fixture.feedCalls.push({ cmd, args });
      if (cmd === "api_video" && withEpisodes) {
        return Promise.resolve({
          id: args.id, title: "测试短剧", description: "", cover: withCovers ? "https://cdn.fixture.invalid/cover.jpg" : "", tags: [], score: 0, episode_count: 4, total_episodes: 4,
          episodes: [1, 2, 3, 4].map(ep_num => ({ ep_num, title: `第${ep_num}集`, duration: 60, status: 1 })),
        });
      }
      if (cmd === "api_play" && signedPlayUrls) {
        // Every play request returns a freshly signed address, as the upstream does.
        const n = fixture.feedCalls.filter(r => r.cmd === "api_play").length;
        return Promise.resolve({
          video_url: `https://cdn.fixture.invalid/ep1.m3u8?auth_key=${n}`,
          ...(hevcStreams ? { video_url_hevc: `https://cdn.fixture.invalid/ep1-hevc.m3u8?auth_key=${n}` } : {}),
        });
      }
      return Promise.reject("HTTP 503 Gateway: <html><h1>nginx error</h1></html>");
    }
    if (!["api_feed", "api_category", "api_posts"].includes(cmd)) return Promise.reject(`Unexpected IPC: ${cmd}`);
    fixture.history.push({ cmd, args });
    return new Promise((resolve, reject) => pending.push({ cmd, args, resolve, reject }));
  } },
});

// The player stores watch progress every 5s; drive the same store write without media.
function StoreProbe() {
  const { addHistory } = useStore();
  fixture.saveProgress = (t: number) => addHistory(424242, 1, t, 100);
  return null;
}

function Fixture() {
  const [active, setActive] = useState(false);
  fixture.setActive = setActive;
  fixture.ready = true;
  const page = params.get("page");
  return <AppProvider>
    <StoreProbe />
    {params.get("toasts") === "1" && <ToastHost />}
    <div style={params.get("layout") === "mobile" ? { position: "fixed", inset: 0 } : { position: "relative", width: 900, height: 1000 }}>
      {page === "home" ? <Home active bottomInset={0} /> : page === "profile" ? <Profile wide={false} />
        : page === "channel" ? <ChannelPage cate="ai-duanju" name="AI成人短剧" onBack={() => {}} wide />
        : <Category wide active={active} />}
    </div>
  </AppProvider>;
}
initOffline();
createRoot(document.querySelector("#root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);

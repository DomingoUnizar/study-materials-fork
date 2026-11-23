import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Home from "../src/pages/Home";
import Category from "../src/pages/Category";
import { AppProvider, useStore } from "../src/store";
import "../src/index.css";

type Request = { cmd: string; args: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: string) => void };
const params = new URLSearchParams(location.search);
const signedPlayUrls = params.get("play") === "signed";
const withEpisodes = params.get("detail") === "episodes";
const pending: Request[] = [];
const fixture = {
  history: [] as { cmd: string; args: Record<string, unknown> }[],
  feedCalls: [] as { cmd: string; args: Record<string, unknown> }[],
  debug: [] as string[],
  ready: false,
  setActive: (_active: boolean) => {},
  saveProgress: (_t: number) => {},
  complete(cmd: string, key: string, result: "404" | "503" | "empty" | "item") {
    const index = pending.findIndex(r => r.cmd === cmd && (!key || r.args.cate === key));
    if (index < 0) throw new Error(`No pending request: ${cmd}/${key}`);
    const request = pending.splice(index, 1)[0];
    if (result === "404" || result === "503") {
      request.reject(`HTTP ${result} Gateway: <html><h1>nginx error</h1></html>`);
      return;
    }
    request.resolve({
      items: result === "empty" ? [] : [{
        id: 991, title: `已加载${key || cmd}`, cover: "", tags: [], score: 0, hot: 0,
        episode_count: 1, total_episodes: 1, is_finished: true, is_original: 0,
        like_count: 0, comment_count: 0, collect_count: 0,
      }],
      pagination: { page: 1, pages: 1, size: 8, total: result === "empty" ? 0 : 1 },
    });
  },
};

// Preserve the real api.call error formatting and React pages; replace only Tauri IPC.
Object.assign(window, {
  apiLoadingFixture: fixture,
  __TAURI_INTERNALS__: { invoke(cmd: string, args: Record<string, unknown> = {}) {
    if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
    if (cmd === "debug_log") { fixture.debug.push(String(args.msg)); return Promise.resolve(); }
    // Feed detail/play requests fail like an unavailable upstream; record them to count re-requests.
    if (cmd === "api_video" || cmd === "api_play") {
      fixture.feedCalls.push({ cmd, args });
      if (cmd === "api_video" && withEpisodes) {
        return Promise.resolve({
          id: args.id, title: "测试短剧", description: "", cover: "", tags: [], score: 0, episode_count: 4, total_episodes: 4,
          episodes: [1, 2, 3, 4].map(ep_num => ({ ep_num, title: `第${ep_num}集`, duration: 60, status: 1 })),
        });
      }
      if (cmd === "api_play" && signedPlayUrls) {
        // Every play request returns a freshly signed address, as the upstream does.
        const n = fixture.feedCalls.filter(r => r.cmd === "api_play").length;
        return Promise.resolve({ video_url: `https://cdn.fixture.invalid/ep1.m3u8?auth_key=${n}` });
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
  const home = new URLSearchParams(location.search).get("page") === "home";
  return <AppProvider>
    <StoreProbe />
    <div style={params.get("layout") === "mobile" ? { position: "fixed", inset: 0 } : { position: "relative", width: 900, height: 1000 }}>
      {home ? <Home active bottomInset={0} /> : <Category wide active={active} />}
    </div>
  </AppProvider>;
}
createRoot(document.querySelector("#root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);

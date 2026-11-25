import { useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "./api";

/* 收藏更新提醒：只在启动后和回到前台时检查，两次检查至少隔 6 小时，不常驻、不轮询。
   上游没有按更新时间排序的列表（sort 只支持按上架时间的 new），所以每次检查给每部收藏取一次详情
   （同时最多 2 个请求），拿最新集数和「上次看到的集数」比，多出来就算有更新。
   打开「我的收藏」时，收藏页本来就取的详情也顺带比一次，所以一打开就能看到更新，不用等定时检查。
   在信息流里看到这部剧（点开它，或刚收藏它）就算看过；第一次见到的收藏只记下当时的集数，不提醒。 */
const SEEN_KEY = "hghub_fav_seen";
const NEW_KEY = "hghub_fav_updates";
const CHECKED_KEY = "hghub_fav_checked_at";
const INTERVAL = 6 * 3600 * 1000;

type Counts = Record<number, number>;
const read = (key: string): Counts => {
  try { const v = JSON.parse(localStorage.getItem(key) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
};
const write = (key: string, value: Counts) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 只影响本次 */ } };

let seen = read(SEEN_KEY);
let updates = read(NEW_KEY);
const listeners = new Set<() => void>();
const publish = () => { write(SEEN_KEY, seen); write(NEW_KEY, updates); listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** 有更新的收藏：{ id: 最新集数 }（可能含已取消收藏的 id，显示时按收藏列表取） */
export const useFavUpdates = () => useSyncExternalStore(subscribe, () => updates);

/** 看到了这部收藏的详情：记下集数（离线时的旧详情集数可能偏少，只往大里记），清掉已看到的更新提醒 */
export function markSeen(id: number, count: number) {
  count = Math.max(count, seen[id] || 0);
  if (!count || (seen[id] === count && !(id in updates && updates[id] <= count))) return;
  seen = { ...seen, [id]: count };
  if (id in updates && updates[id] <= count) {
    updates = Object.fromEntries(Object.entries(updates).filter(([key]) => Number(key) !== id));
  }
  publish();
}

/** 拿到一部收藏的最新集数：第一次见到只记下；比上次看到的多就记为有更新。返回是否新发现了更新 */
function note(id: number, count: number) {
  if (!count) return false;
  if (!(id in seen)) { seen = { ...seen, [id]: count }; return false; }
  if (count <= seen[id] || updates[id] === count) return false;
  updates = { ...updates, [id]: count };
  return true;
}

/** 收藏页本来就要取每部收藏的详情：顺带比一下集数，有更新马上标出来（不另外请求上游，不等 6 小时的定时检查） */
export function noteFavDetail(id: number, count: number) {
  const before = { seen: seen[id], update: updates[id] };
  note(id, count);
  if (seen[id] !== before.seen || updates[id] !== before.update) publish();
}

let running = false;
/** 检查收藏有没有更新；返回这次新发现有更新的 id */
export async function checkFavUpdates(favs: number[], now = Date.now()): Promise<number[]> {
  let last = 0;
  try { last = Number(localStorage.getItem(CHECKED_KEY)) || 0; } catch { /* 当作没查过 */ }
  if (running || !favs.length || now - last < INTERVAL) return [];
  running = true;
  const found: number[] = [];
  try {
    // 只保留仍在收藏里的记录
    const keep = (m: Counts) => Object.fromEntries(Object.entries(m).filter(([id]) => favs.includes(Number(id))));
    seen = keep(seen);
    updates = keep(updates);
    const queue = [...favs];
    let ok = 0;
    let failed = 0;
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        // 一部都没取到就连着失败：多半是断网或上游出问题，不再一部部白请求
        if (!ok && failed >= 3) return;
        try {
          const d = await api.video(id);
          ok += 1;
          if (note(id, d?.episode_count || d?.episodes?.length || 0)) found.push(id);
        } catch { failed += 1; /* 这部这次取不到，下次再查 */ }
      }
    };
    await Promise.all([worker(), worker()]);
    // 一部都没取到的检查不算数：下次回到前台就重查，不用再等 6 小时
    if (ok) { try { localStorage.setItem(CHECKED_KEY, String(now)); } catch { /* 下次启动再查 */ } }
    publish();
  } finally {
    running = false;
  }
  return found;
}

/** 启动 8 秒后（让开首页视频）查一次，之后每次回到前台时按间隔决定是否再查 */
export function useFavUpdateCheck(favs: number[], notify: (count: number) => void) {
  const latest = useRef({ favs, notify });
  latest.current = { favs, notify };
  useEffect(() => {
    const run = () => {
      void checkFavUpdates(latest.current.favs).then((found) => { if (found.length) latest.current.notify(found.length); });
    };
    const timer = window.setTimeout(run, 8000);
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
}

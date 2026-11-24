import { useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "./api";

/* 收藏更新提醒：只在启动后和回到前台时检查，两次检查至少隔 6 小时，不常驻、不轮询。
   上游没有按更新时间排序的列表（sort 只支持按上架时间的 new），所以每次检查给每部收藏取一次详情
   （同时最多 2 个请求），拿最新集数和「上次看到的集数」比，多出来就算有更新。
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
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const d = await api.video(id);
          const count = d?.episode_count || d?.episodes?.length || 0;
          if (!count) continue;
          if (!(id in seen)) seen = { ...seen, [id]: count };
          else if (count > seen[id] && updates[id] !== count) {
            updates = { ...updates, [id]: count };
            found.push(id);
          }
        } catch { /* 这部这次取不到，下次再查 */ }
      }
    };
    await Promise.all([worker(), worker()]);
    try { localStorage.setItem(CHECKED_KEY, String(now)); } catch { /* 下次启动再查 */ }
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

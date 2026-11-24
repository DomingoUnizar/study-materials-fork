import { useSyncExternalStore } from "react";

/* 按上游标签屏蔽题材（默认开启，设置里可关）。
   上游给男同题材打的是「男同」标签；只按标签精确匹配，不看标题和简介：
   简介里的「男男女女」之类会误伤，搜「BL」也能搜出不相干的剧。
   收藏和观看历史是自己选的，不过滤。 */
const OFF_KEY = "hghub_tag_filter_off";
const BLOCKED = new Set(["男同", "耽美"]);

let enabled = (() => { try { return localStorage.getItem(OFF_KEY) !== "1"; } catch { return true; } })();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const useTagFilter = () => useSyncExternalStore(subscribe, () => enabled);

export function setTagFilter(on: boolean) {
  enabled = on;
  try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, "1"); } catch { /* 只影响本次 */ }
  listeners.forEach((fn) => fn());
}

/** 去掉带屏蔽标签的条目；`on` 传 useTagFilter() 的值，让开关变化时重新渲染 */
export const visibleByTags = <T extends { tags?: string[] }>(list: T[], on: boolean): T[] =>
  on ? list.filter((item) => !item.tags?.some((tag) => BLOCKED.has(tag.trim()))) : list;

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { LOCAL } from "./api";
import { cacheHevc } from "./hevc";
import type { Detail } from "./types";

/** 一集的离线缓存状态（与 src-tauri/src/offline.rs 的 Episode 一致） */
export type OfflineEpisode = {
  vid: number;
  ep: number;
  title: string;
  state: "queued" | "downloading" | "done" | "error";
  done: number;
  total: number;
  bytes: number;
  error?: string;
  seq: number;
};

type Snapshot = { episodes: Record<string, OfflineEpisode>; series: Record<number, Detail> };

const key = (vid: number, ep: number) => `${vid}:${ep}`;
let snapshot: Snapshot = { episodes: {}, series: {} };
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const useOffline = () => useSyncExternalStore(subscribe, () => snapshot);
export const offlineEpisode = (vid: number, ep: number): OfflineEpisode | undefined => snapshot.episodes[key(vid, ep)];
export const offlineSeries = (vid: number): Detail | undefined => snapshot.series[vid];
export const isOffline = (vid: number, ep: number) => offlineEpisode(vid, ep)?.state === "done";
export const offlineUrl = (vid: number, ep: number) => `${LOCAL}/offline/${vid}/${ep}/index.m3u8`;
export const offlineCover = (vid: number) => `${LOCAL}/offline/${vid}/cover`;
export const isOfflineUrl = (url: string) => url.startsWith(`${LOCAL}/offline/`);

let started = false;
/** 启动时读一次缓存列表，之后靠后端推送的进度事件更新，不轮询 */
export function initOffline() {
  if (started) return;
  started = true;
  invoke<{ episodes: OfflineEpisode[]; series: Record<string, Detail> }>("offline_list")
    .then((r) => {
      const episodes: Record<string, OfflineEpisode> = {};
      for (const e of r.episodes) episodes[key(e.vid, e.ep)] = e;
      const series: Record<number, Detail> = {};
      for (const [vid, detail] of Object.entries(r.series)) series[Number(vid)] = detail;
      publish({ episodes: { ...episodes, ...snapshot.episodes }, series: { ...series, ...snapshot.series } });
    })
    .catch(() => { /* 非 Tauri 环境（浏览器回归页）没有离线缓存 */ });
  listen<OfflineEpisode>("offline-progress", (e) => {
    publish({ ...snapshot, episodes: { ...snapshot.episodes, [key(e.payload.vid, e.payload.ep)]: e.payload } });
  }).catch(() => {});
  /* 下载因网络中断停下后，回到应用或网络恢复时接着下（只响应这两个事件，不定时重试） */
  const nudge = () => { if (document.visibilityState === "visible" && isInterrupted()) resumeOffline(); };
  document.addEventListener("visibilitychange", nudge);
  window.addEventListener("online", nudge);
}

/** 这一集因网络中断停在队列里（后端会把中断原因写在 error 里） */
export const interrupted = (e?: OfflineEpisode) => e?.state === "queued" && !!e.error;
const isInterrupted = () => Object.values(snapshot.episodes).some(interrupted);

/** 让网络中断后停着的下载接着下 */
export function resumeOffline() {
  invoke("offline_resume").catch(() => {});
}

/** 把若干集加入离线下载队列 */
export async function cacheEpisodes(detail: Detail, eps: number[]) {
  // 本机播放过 hevc 的设备缓存 hevc 流（同分辨率、体积约一半）
  await invoke("offline_enqueue", { vid: detail.id, eps, title: detail.title, cover: detail.cover || "", detail, hevc: cacheHevc() });
  publish({ ...snapshot, series: { ...snapshot.series, [detail.id]: detail } });
}

/** 删除一集，或省略 ep 删除整部剧的缓存 */
export async function removeOffline(vid: number, ep?: number) {
  await invoke("offline_delete", { vid, ep: ep ?? null });
  const episodes = { ...snapshot.episodes };
  for (const k of Object.keys(episodes)) if (episodes[k].vid === vid && (ep === undefined || episodes[k].ep === ep)) delete episodes[k];
  const series = { ...snapshot.series };
  if (!Object.values(episodes).some((e) => e.vid === vid)) delete series[vid];
  publish({ episodes, series });
}

/* 在线播放时暂停离线下载，避免和播放抢带宽；多个播放页按引用计数，只在总状态变化时通知后端 */
const streaming = new Set<string>();
let pausedSent = false;
export function setStreaming(id: string, on: boolean) {
  if (on) streaming.add(id);
  else streaming.delete(id);
  const paused = streaming.size > 0;
  if (paused === pausedSent) return;
  pausedSent = paused;
  invoke("offline_set_paused", { paused }).catch(() => {});
}

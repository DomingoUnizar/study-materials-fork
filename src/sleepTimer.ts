import { useSyncExternalStore } from "react";

/* 定时关闭：到点暂停正在播放的视频；或者播完本集就停下，不再自动连播下一集。
   只在用户选了时长时挂一个一次性计时器，到点、改选或关闭时清掉；不轮询，也不在后台常驻。
   状态只在内存里，重启应用即取消。 */
export type SleepTimer =
  | { kind: "off" }
  | { kind: "time"; minutes: number; until: number }
  | { kind: "episode" };

let state: SleepTimer = { kind: "off" };
let timer = 0;
const listeners = new Set<() => void>();
const stoppers = new Set<() => void>();
const publish = (next: SleepTimer) => { state = next; listeners.forEach((fn) => fn()); };
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const useSleepTimer = () => useSyncExternalStore(subscribe, () => state);

/** 选一个时长（分钟）、「播完本集」或关闭 */
export function setSleepTimer(choice: number | "episode" | "off") {
  window.clearTimeout(timer);
  timer = 0;
  if (typeof choice === "number") {
    timer = window.setTimeout(() => {
      timer = 0;
      publish({ kind: "off" });
      stoppers.forEach((fn) => fn());
    }, choice * 60_000);
    publish({ kind: "time", minutes: choice, until: Date.now() + choice * 60_000 });
  } else {
    publish(choice === "episode" ? { kind: "episode" } : { kind: "off" });
  }
}

/** 播放页登记到点要做的事（暂停正在播的视频）；返回注销函数 */
export function onSleepTime(fn: () => void) {
  stoppers.add(fn);
  return () => { stoppers.delete(fn); };
}

/** 一集播完时调用：选了「播完本集」就停在这里（返回 true，调用方不再连播下一集） */
export function stopAfterEpisode() {
  if (state.kind !== "episode") return false;
  publish({ kind: "off" });
  return true;
}

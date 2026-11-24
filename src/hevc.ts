import { platform } from "./api";

/* 上游每集同时提供 main（H.264）与 hevc（H.265）两路，分辨率相同、hevc 码率约一半。
   安卓上设备能用 MediaSource 解码 HEVC 时在线优先播 hevc，出错自动换回 H.264（见 Feed）；
   出现过 HEVC 解码错误就记在本机，之后都改回 H.264。设置里也可以手动关掉（只播 H.264）或重新打开。
   离线缓存是永久文件，只有本机真正播放成功过 hevc 才缓存 hevc，避免存下放不出的格式。 */
const OFF_KEY = "hghub_hevc_off";
/** OFF_KEY 是解码出错后自动设上的（设置里据此说明原因）；手动关闭时不设 */
const AUTO_KEY = "hghub_hevc_auto_off";
const OK_KEY = "hghub_hevc_ok";
const CODECS = ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'];

const flag = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const setFlag = (key: string, on = true) => {
  try { if (on) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch { /* 存储不可用时只影响本次 */ }
};

/** 本机（安卓）能否用 MediaSource 解码 HEVC */
export function hevcSupported(): boolean {
  if (platform !== "android") return false;
  const source = (window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource }).MediaSource
    ?? (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  return !!source?.isTypeSupported && CODECS.some((type) => source.isTypeSupported(type));
}

export const preferHevc = () => !flag(OFF_KEY) && hevcSupported();

/** 设置页显示用：不支持 / 优先 HEVC / 手动关闭 / 解码出错后自动关闭 */
export function hevcStatus(): "unsupported" | "on" | "off" | "auto_off" {
  if (!hevcSupported()) return "unsupported";
  if (!flag(OFF_KEY)) return "on";
  return flag(AUTO_KEY) ? "auto_off" : "off";
}
/** 本机是否已经正常播放过 hevc */
export const hevcVerified = () => flag(OK_KEY);
/** 设置里手动开关；重新打开会清掉「解码出错」的记录，再试一次 */
export function setHevcEnabled(on: boolean) {
  setFlag(OFF_KEY, !on);
  setFlag(AUTO_KEY, false);
}

/** 离线缓存是否下载 hevc 流 */
export const cacheHevc = () => preferHevc() && flag(OK_KEY);
/** hevc 在本机开始正常播放 */
export const hevcPlayed = () => setFlag(OK_KEY);
/** hevc 在本机解码出错 */
export const disableHevc = () => { setFlag(OFF_KEY); setFlag(AUTO_KEY); };

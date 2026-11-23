import { platform } from "./api";

/* 上游每集同时提供 main（H.264）与 hevc（H.265）两路，分辨率相同、hevc 码率约一半。
   安卓上设备能用 MediaSource 解码 HEVC 时在线优先播 hevc，出错自动换回 H.264（见 Feed）；
   出现过 HEVC 解码错误就记在本机，之后都改回 H.264。
   离线缓存是永久文件，只有本机真正播放成功过 hevc 才缓存 hevc，避免存下放不出的格式。 */
const OFF_KEY = "hghub_hevc_off";
const OK_KEY = "hghub_hevc_ok";
const CODECS = ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'];

const flag = (key: string) => { try { return localStorage.getItem(key) === "1"; } catch { return false; } };
const setFlag = (key: string) => { try { localStorage.setItem(key, "1"); } catch { /* 存储不可用时只影响本次 */ } };

export function preferHevc(): boolean {
  if (platform !== "android" || flag(OFF_KEY)) return false;
  const source = (window as unknown as { MediaSource?: typeof MediaSource; ManagedMediaSource?: typeof MediaSource }).MediaSource
    ?? (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
  return !!source?.isTypeSupported && CODECS.some((type) => source.isTypeSupported(type));
}

/** 离线缓存是否下载 hevc 流 */
export const cacheHevc = () => preferHevc() && flag(OK_KEY);
/** hevc 在本机开始正常播放 */
export const hevcPlayed = () => setFlag(OK_KEY);
/** hevc 在本机解码出错 */
export const disableHevc = () => setFlag(OFF_KEY);

import React, { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isLocalMedia, platform, playlist } from "../api";
import { mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, sourceOrAutoResume?: string | boolean) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 缩放倍率与平移偏移（用于移动端竖屏下双指缩放横屏视频） */
  scale?: number;
  panX?: number;
  panY?: number;
  isGesturing?: boolean;
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
  /** 外层不铺黑底：视频准备好之前露出下面的封面，准备好后直接在封面上淡入（黑边由 video 元素自己的黑底提供） */
  seeThrough?: boolean;
};

/* 安卓 WebView 静音时会关掉音频输出、取消静音时再重新打开：每次画面停一下，还有爆音。
   本次启动后开过一次声音，之后的「静音」就把音量压到听不见（0.0001），不真正关掉输出；
   还没开过声音时照旧真正静音：不占用音频焦点，不打断其它应用正在放的音乐。 */
let soundTurnedOn = false;
const SILENT = 0.0001;
function audioOutput(muted: boolean, volume: number) {
  if (!muted && volume > 0) soundTurnedOn = true;
  return muted && soundTurnedOn && platform === "android" ? { muted: false, volume: SILENT } : { muted, volume };
}
function applyAudio(v: HTMLVideoElement, muted: boolean, volume: number) {
  const out = audioOutput(muted, volume);
  if (v.volume !== out.volume) v.volume = out.volume;
  if (v.muted !== out.muted) v.muted = out.muted;
}

/* 画面真正画出第一帧时浏览器会回调 requestVideoFrameCallback（安卓 WebView 83+ 都有）。
   数据进了缓冲区（FRAG_BUFFERED / loadeddata）不等于画出来了：安卓硬解首帧常要再等几百毫秒，
   这时就把 video 显示出来，看到的是它的黑底——滑到下一集时「封面 → 黑一下 → 视频」的闪烁就是这么来的。 */
type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};
const HAS_FRAME_CALLBACK = typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, diagnosticContext = {}, muted = false, loop = false, fit = "contain",
    scale = 1, panX = 0, panY = 0, isGesturing = false,
    volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "", seeThrough = false },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoverCountRef = useRef(0);
  const recoverTimerRef = useRef<number | null>(null);
  const lastSizeRef = useRef({ w: 0, h: 0 });
  /** 显示 video（淡入）；支持首帧回调时等画出第一帧再显示 */
  const [ready, setReady] = useState(false);
  /** 已经画出过画面：此后才给 video 铺黑底（横屏片的上下黑边），之前保持透明，透出下面的封面 */
  const [framed, setFramed] = useState(false);
  /** 首帧回调万一不来时的兜底（只在开播或加载完成时挂一次，不轮询） */
  const frameFallbackRef = useRef<number | null>(null);
  const armFrameFallback = (ms: number, markFramed: boolean) => {
    if (!HAS_FRAME_CALLBACK || frameFallbackRef.current !== null) return;
    frameFallbackRef.current = window.setTimeout(() => {
      frameFallbackRef.current = null;
      setReady(true);
      if (markFramed) setFramed(true);
    }, ms);
  };
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });

  const reportSizeAndDuration = (v: HTMLVideoElement) => {
    if (v.duration && Number.isFinite(v.duration) && v.duration > 0) {
      onDuration?.(v.duration);
    }
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    if (w > 0 && h > 0 && (w !== lastSizeRef.current.w || h !== lastSizeRef.current.h)) {
      lastSizeRef.current = { w, h };
      onSize?.(w, h);
    }
  };

  const safeSeek = (t: number, sourceOrAutoResume: string | boolean = "handle") => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(t)) return;
    const dur = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
    const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
    const source = typeof sourceOrAutoResume === "string" ? sourceOrAutoResume : "handle";
    const autoResume = typeof sourceOrAutoResume === "boolean" ? sourceOrAutoResume : !v.paused;

    requestSeek(target, source);
    onWaiting?.();
    if (hlsRef.current) {
      try {
        hlsRef.current.startLoad(target);
      } catch { /* ignore */ }
    }

    try {
      v.currentTime = target;
      trace("seek.assigned", { target, source });
    } catch (e) {
      trace("seek.rejected", { error_name: (e as Error).name });
    }

    if (autoResume && activity.isActive()) {
      const resumeOnce = () => {
        v.removeEventListener("seeked", resumeOnce);
        v.removeEventListener("canplay", resumeOnce);
        if (activity.isActive()) v.play().catch(() => {});
      };
      v.addEventListener("seeked", resumeOnce, { once: true });
      v.addEventListener("canplay", resumeOnce, { once: true });
      // 兜底：若 350ms 内已经就绪则直接播
      window.setTimeout(() => {
        if (v.readyState >= 2 && v.paused && activity.isActive()) {
          v.removeEventListener("seeked", resumeOnce);
          v.removeEventListener("canplay", resumeOnce);
          v.play().catch(() => {});
        }
      }, 350);
    }
  };

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, sourceOrAutoResume: string | boolean = "handle") => safeSeek(t, sourceOrAutoResume),
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) applyAudio(v, m, volume); },
    volume: (vol: number) => { const v = videoRef.current; if (v) applyAudio(v, muted, vol); },
  }));

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);
    setFramed(false);
    if (frameFallbackRef.current !== null) { window.clearTimeout(frameFallbackRef.current); frameFallbackRef.current = null; }
    // 画出新源的第一帧时再显示（见 HAS_FRAME_CALLBACK）
    const frameVideo = video as FrameVideo;
    const frameRequest = frameVideo.requestVideoFrameCallback?.(() => { setFramed(true); setReady(true); });
    recoverCountRef.current = 0;
    lastSizeRef.current = { w: 0, h: 0 };
    if (recoverTimerRef.current) {
      window.clearTimeout(recoverTimerRef.current);
      recoverTimerRef.current = null;
    }
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const proxied = isLocalMedia(src);
    const url = proxied ? src : playlist(src);
    const useHls = !url.includes("/seg?u=");
    const isIos = platform === "ios";
    trace("source.load", { engine: useHls && Hls.isSupported() ? "hls.js" : "native", auto_play: autoPlay, resource: mediaResource(src) });

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      applyAudio(v, muted, volume);
      v.playbackRate = rate;
    };
    applySettings();

    if (useHls && Hls.isSupported()) {
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // iOS WKWebView 下 WebWorker 跨自定义协议 hg:// 高频中断易死锁，关闭 Worker 走主线程加载更稳
        enableWorker: !isIos,
        // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        lowLatencyMode: false,
        // 前向缓冲 60 秒：上游偶尔变慢时多攒一些再播，减少卡顿（内存上限仍由 hls.js 的 maxBufferSize 约束）
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 20000,
        levelLoadingMaxRetry: 4,
        // 与本地代理一致：分片读得慢也让它读完（代理 15 秒等不到响应头会自己重试），不到 25 秒就放弃重来
        fragLoadingTimeOut: 60000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
        startFragPrefetch: true,
      });
      hlsRef.current = hls;
      observeHls(hls, trace);
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad();
        if (autoPlay) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        recoverCountRef.current = 0;
        if (!HAS_FRAME_CALLBACK) setReady(true);
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        // 非致命卡顿错误（常见于拖动进度条后缓冲空洞）：主动触发加载与微调跳帧
        if (!data.fatal) {
          if (
            activity.isActive() && (
              data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
              data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
            )
          ) {
            try {
              hls.startLoad(video.currentTime || -1);
            } catch { /* ignore */ }
          }
          return;
        }

        if (!activity.isActive()) return;

        // 致命错误：优先自动重连/恢复解码器，最多静默恢复 4 次，避免拖动进度条直接弹报错层
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // 清单失败时 hls.js 已按 manifestLoadingMaxRetry 重试过，而 startLoad 不会重新请求清单
          // （只有 loadSource 会），静默恢复只会一直转圈；直接报错，交给「重新加载」换取新地址。
          const manifestFailed = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
            || data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
            || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR;
          if (!manifestFailed && recoverCountRef.current < 4) {
            recoverCountRef.current += 1;
            const delay = 250 * recoverCountRef.current;
            if (recoverTimerRef.current) window.clearTimeout(recoverTimerRef.current);
            recoverTimerRef.current = window.setTimeout(() => {
              if (!hlsRef.current || !activity.isActive()) return;
              try {
                hlsRef.current.startLoad(video.currentTime || -1);
                if (!video.paused) video.play().catch(() => {});
              } catch { /* ignore */ }
            }, delay);
            return;
          }
          onError?.(`${data.type}/${data.details}`);
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          // 设备解不了流声明的编码（如 HEVC 的某个档次）：恢复解码器无济于事，清单级的这个错误也不会再报，
          // 静默恢复只会一直转圈；直接报错（Feed 播 hevc 时据此自动换回 H.264）
          const unsupported = data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR
            || data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR;
          if (!unsupported && recoverCountRef.current < 4) {
            recoverCountRef.current += 1;
            try {
              if (recoverCountRef.current === 2) hls.swapAudioCodec();
              hls.recoverMediaError();
              video.play().catch(() => {});
            } catch { /* ignore */ }
            return;
          }
          onError?.(`${data.type}/${data.details}`);
          hls.recoverMediaError();
        } else {
          onError?.(`${data.type}/${data.details}`);
          hls.destroy();
          hlsRef.current = null;
        }
      });
    } else {
      video.src = url;
      if (autoPlay) activity.play("native_autoplay", true);
    }

    return () => {
      trace("source.cleanup");
      if (frameRequest !== undefined) frameVideo.cancelVideoFrameCallback?.(frameRequest);
      if (frameFallbackRef.current !== null) { window.clearTimeout(frameFallbackRef.current); frameFallbackRef.current = null; }
      if (recoverTimerRef.current) {
        window.clearTimeout(recoverTimerRef.current);
        recoverTimerRef.current = null;
      }
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => { if (videoRef.current) applyAudio(videoRef.current, muted, volume); }, [muted, volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    applyAudio(v, muted, volume);
    v.playbackRate = rate;
  };

  const nearEndFiredRef = useRef(false);
  useEffect(() => {
    nearEndFiredRef.current = false;
  }, [src]);

  // Native Resize Event listener for HTMLVideoElement (React doesn't always bind onResize on <video>)
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onVideoResize = () => reportSizeAndDuration(v);
    v.addEventListener("resize", onVideoResize);
    return () => v.removeEventListener("resize", onVideoResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const hasTransform = scale !== 1 || panX !== 0 || panY !== 0;

  return (
    <div className={`relative w-full h-full ${seeThrough ? "" : "bg-black"} overflow-hidden ${className}`}>
      {!ready && poster && (
        <img
          src={poster}
          alt=""
          className={`absolute inset-0 w-full h-full pointer-events-none ${fit === "cover" ? "object-cover" : "object-contain"}`}
        />
      )}
      <video
        ref={videoRef}
        playsInline
        webkit-playsinline="true"
        preload="auto"
        muted={audioOutput(muted, volume).muted}
        loop={loop}
        onClick={onClick}
        // 画出画面前不铺黑底（透出下面的封面）；不支持首帧回调的老内核照旧
        className={`w-full h-full ${framed || !HAS_FRAME_CALLBACK ? "bg-black" : ""} ${fit === "cover" ? "object-cover" : "object-contain"}`}
        style={{
          // 未显示时留 1% 而不是 0：完全透明的 video 浏览器可能不合成，首帧回调就不来了
          opacity: ready ? 1 : HAS_FRAME_CALLBACK ? 0.01 : 0,
          transform: hasTransform ? `translate3d(${panX}px, ${panY}px, 0) scale(${scale})` : "translateZ(0)",
          transformOrigin: "center center",
          transition: isGesturing ? "opacity .25s" : "opacity .25s, transform .2s cubic-bezier(.2,0,0,1)",
        }}
        onLoadedData={(e) => {
          const v = e.target as HTMLVideoElement;
          // 有首帧回调时等它；暂停着加载（如回到前台重建播放器）万一一直不回调，1.5 秒后照样显示（仍不铺黑底）
          if (HAS_FRAME_CALLBACK) armFrameFallback(1500, false); else setReady(true);
          reapply(v);
          reportSizeAndDuration(v);
        }}
        onCanPlay={(e) => {
          const v = e.target as HTMLVideoElement;
          if (!HAS_FRAME_CALLBACK) setReady(true);
          reportSizeAndDuration(v);
        }}
        onTimeUpdate={(e) => {
          const v = e.target as HTMLVideoElement;
          onTime?.(v.currentTime);
          if (lastSizeRef.current.w === 0 && v.videoWidth > 0) {
            reportSizeAndDuration(v);
          }
          // 借鉴 stclock1988/hghub-ios：部分 HLS 流容器标称时长比最后一个分片略长 0.5~1.2s，
          // 接近片尾时提前复位准备，若卡在片尾则自动触发连播
          if (!loop && !nearEndFiredRef.current && activity.isActive() && v.duration > 5 && v.currentTime >= v.duration - 0.35) {
            nearEndFiredRef.current = true;
            onEnded?.();
          }
        }}
        onLoadedMetadata={(e) => {
          const v = e.target as HTMLVideoElement;
          reapply(v);
          reportSizeAndDuration(v);
        }}
        onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
        onPause={() => onPause?.()}
        onWaiting={(e) => {
          const v = e.target as HTMLVideoElement;
          if (!loop && !nearEndFiredRef.current && activity.isActive() && v.duration > 5 && v.currentTime >= v.duration - 1.5) {
            nearEndFiredRef.current = true;
            onEnded?.();
            return;
          }
          onWaiting?.();
        }}
        onPlaying={(e) => {
          // 有首帧回调时等它；已经在播却 2 秒都没回调，就当画面在出了（不让视频一直看不见）
          if (HAS_FRAME_CALLBACK) armFrameFallback(2000, true); else setReady(true);
          recoverCountRef.current = 0;
          reportSizeAndDuration(e.target as HTMLVideoElement);
          if (activity.isActive()) onPlaying?.();
        }}
        onSeeking={() => onWaiting?.()}
        onSeeked={() => {
          const v = videoRef.current;
          if (v && !v.paused && activity.isActive()) onPlaying?.();
        }}
        onEnded={() => {
          if (!nearEndFiredRef.current && activity.isActive()) {
            nearEndFiredRef.current = true;
            onEnded?.();
          }
        }}
      />
    </div>
  );
});

export default VideoSurface;

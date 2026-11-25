import { useEffect, useMemo, useRef, useState } from "react";
import { api, APP_VERSION, fmt, fmtTime, isMobile, platform } from "../api";
import type { Detail } from "../types";
import { useStore } from "../store";
import { Avatar, Empty, Img } from "../components/ui";
import { IChevR, IClock, IDownload, ILogout, ISettings, IStar, ITrash, IUser } from "../icons";
import { cacheEpisodes, interrupted, offlineCover, removeOffline, resumeOffline, useOffline, type OfflineEpisode } from "../offline";
import { offlineLabel } from "../components/Panels";
import { noteFavDetail, useFavUpdates } from "../favUpdates";

/** 收藏、历史每次加载 12 条，滑到底再加载下一批，避免一次向上游请求几十条详情 */
const PAGE = 12;

/** 一部剧现有几集：以选集列表为准，没有选集时用上游给的集数 */
const episodeCount = (d: Detail) => Math.max(d.episodes?.length || 0, d.episode_count || 0);

/* 我的：结构固定（资料卡 + 我的收藏 / 观看历史）。
   收藏与观看记录都存在本地，所以未登录也照常展示；未登录时资料卡本身就是登录入口。 */
export default function Profile({ wide }: { wide: boolean }) {
  const { user, setLoginOpen, logout, history, favs, clearHistory, push } = useStore();
  const [tab, setTab] = useState<"fav" | "history" | "cache">("fav");
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(0);
  const requested = useRef(new Set<number>());
  /** 已发出、还没回来的详情请求数（同步更新，见下面翻页的 effect） */
  const inflight = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const updates = useFavUpdates();
  /* 有更新的收藏排在最前面，点开看过后回到原位置 */
  const updatedFavs = favs.filter((id) => id in updates);
  const ids = tab === "fav" ? [...updatedFavs, ...favs.filter((id) => !(id in updates))] : tab === "history" ? history.map((h) => h.id) : [];
  const shown = ids.slice(0, limit);
  const cards = shown.map((id) => details[id]).filter((d): d is Detail => !!d);
  /** 观看记录里这条的进度（收藏页没有） */
  const progressOf = (id: number) => (tab === "history" ? history.find((h) => h.id === id) : undefined);

  useEffect(() => { setLimit(PAGE); }, [tab]);

  /* 只为当前要显示的这一批拉详情；拉过的按 id 复用，列表顺序变化（如观看进度更新）不会重复请求上游 */
  useEffect(() => {
    const need = shown.filter((id) => !details[id] && !requested.current.has(id));
    if (!need.length) return;
    need.forEach((id) => requested.current.add(id));
    inflight.current += need.length;
    setLoading((n) => n + need.length);
    const favSet = new Set(favs);
    need.forEach((id) => {
      api.video(id)
        .then((d) => {
          setDetails((m) => ({ ...m, [id]: d }));
          // 收藏的最新详情顺带比一下集数：有更新马上标「更新至 N 集」，不用等定时检查
          if (favSet.has(id)) noteFavDetail(id, d?.episode_count || d?.episodes?.length || 0);
        })
        .catch(() => { requested.current.delete(id); })
        .finally(() => { inflight.current -= 1; setLoading((n) => n - 1); });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.join(",")]);

  /* 滑到底、上一批加载完后再拉下一批。「加载中」看 inflight：上面的 effect 在同一次提交里先发出请求、
     同步记下数量；loading 状态要下一次渲染才更新，只看它会在新一批还没发出时又多翻一页（一打开就连拉好几批）。
     一批回来后按显示的条数重新挂上监听（请求很快时 loading 在同一次渲染里就回到 0，不会触发重跑） */
  useEffect(() => {
    const el = moreRef.current;
    if (!el || loading > 0 || inflight.current > 0 || limit >= ids.length) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((n) => n + PAGE);
    }, { root: scrollRef.current, rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, ids.length, loading, cards.length]);

  return (
    <div className="absolute inset-0 bg-bg flex flex-col">
      <div className="shrink-0 px-4 pb-2 flex items-center" style={{ paddingTop: "calc(var(--sat, 0px) + 14px)" }}>
        <div className="text-[24px] font-bold text-on leading-none">我的</div>
        {isMobile && (
          <button onClick={() => push({ kind: "settings" })} aria-label="设置"
            className="ml-auto w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <ISettings size={17} strokeWidth={1.7} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 scroll-y px-4 pt-2 pb-24">
        {/* 资料卡：已登录 / 未登录（点开登录抽屉） */}
        {user ? (
          <div className="rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 a-rise">
            <Avatar size={56} name={user.nickname} hue={280} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on truncate">{user.nickname}</div>
              <div className="text-[11px] text-mut mt-0.5">@{user.username} · ID {user.id}</div>
              <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                <span>点赞 <b className="text-on">{fmt(user.counts?.like)}</b></span>
                <span>收藏 <b className="text-on">{fmt(user.counts?.collect)}</b></span>
                <span>关注 <b className="text-on">{fmt(user.counts?.following)}</b></span>
              </div>
            </div>
            <button onClick={async () => { await logout(); }}
              className="w-9 h-9 rounded-full bg-s3 flex items-center justify-center text-mut pressable" aria-label="退出登录">
              <ILogout size={17} />
            </button>
          </div>
        ) : (
          <button onClick={() => setLoginOpen(true)}
            className="w-full text-left rounded-(--r-lg) bg-s1 p-4 elev-1 flex items-center gap-3.5 pressable a-rise">
            <Avatar size={56} icon={<IUser size={26} />} hue={220} ring />
            <div className="flex-1 min-w-0">
              <div className="text-[16px] font-bold text-on">未登录</div>
              <div className="text-[11px] text-mut mt-0.5">登录后可同步点赞、收藏与评论</div>
              <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                <span>收藏 <b className="text-on">{favs.length}</b></span>
                <span>观看 <b className="text-on">{history.length}</b></span>
              </div>
            </div>
            <span className="flex items-center gap-0.5 h-8 pl-3 pr-2 rounded-full bg-primary text-on-primary text-[11.5px] font-semibold">
              登录<IChevR size={13} />
            </span>
          </button>
        )}

        {/* 我的内容 */}
        <div className="flex bg-s3 rounded-(--r-ctl) p-1 mt-4">
          {([["fav", "我的收藏"], ["history", "观看历史"], ["cache", "离线缓存"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${tab === k ? "tonal text-on-sec" : "text-mut"}`}
              style={tab === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>
              {l}{k === "fav" && updatedFavs.length > 0 && <span className="ml-1 text-primary" aria-label={`${updatedFavs.length} 部有更新`}>· {updatedFavs.length}</span>}
            </button>
          ))}
        </div>

        <div className="mt-3">
          {tab === "cache" ? <OfflineList /> : loading > 0 && !cards.length ? (
            <div className="flex justify-center py-8"><div className="w-7 h-7 spinner" /></div>
          ) : cards.length ? (
            <div className="grid grid-cols-3 gap-2">
              {cards.map((c) => {
                const p = progressOf(c.id);
                return (
                <button key={c.id} onClick={() => push({
                  kind: "feed", videoIds: cards.map((x) => x.id), index: cards.findIndex((x) => x.id === c.id),
                  title: tab === "fav" ? "我的收藏" : "观看历史",
                  startEp: p?.ep, startTime: p?.t,
                })}
                  className="relative rounded-(--r-sm) overflow-hidden bg-s1 elev-1 pressable" style={{ paddingTop: "133%" }}>
                  <Img src={c.cover} />
                  {!!p && (
                    <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-full bg-black/65 text-[9.5px] text-white/90 leading-none">
                      第 {p.ep} 集{p.t > 3 ? ` · ${fmtTime(p.t)}` : ""}
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5 pt-4">
                    {/* 收藏：标题上方写这部剧有几集；有更新时同一处换成高亮的「更新至 N 集」，不重复写两遍 */}
                    {tab === "fav" && (c.id in updates ? (
                      <span className="inline-block mb-1 px-1.5 py-0.5 rounded-full bg-primary text-on-primary text-[9.5px] font-semibold leading-none">
                        更新至 {updates[c.id]} 集
                      </span>
                    ) : episodeCount(c) > 0 && (
                      <div className="mb-0.5 text-[10px] font-semibold text-white/85 tsh">共 {episodeCount(c)} 集</div>
                    ))}
                    <div className="text-[10.5px] text-white clamp-2 leading-tight">{c.title}</div>
                  </div>
                </button>
                );
              })}
            </div>
          ) : (
            <Empty icon={tab === "fav" ? <IStar size={24} /> : <IClock size={24} />}
              title={tab === "fav" ? "还没有收藏" : "还没有观看记录"}
              sub={tab === "fav" ? "在剧集页点收藏，之后就能在这里找到" : "看过的剧集会出现在这里"}
              action="去逛逛" onAction={() => push({ kind: "ranks" })} />
          )}
          {limit < ids.length && <div ref={moreRef} className="h-px" />}
          {loading > 0 && cards.length > 0 && (
            <div className="flex justify-center py-4"><div className="w-6 h-6 spinner" /></div>
          )}
          {cards.length > 0 && tab === "history" && (
            <button onClick={clearHistory} className="mt-3 w-full h-9 rounded-(--r-ctl) bg-s3 text-[12px] text-mut pressable">清空观看历史</button>
          )}
        </div>

        <div className="text-center text-[10px] text-dim mt-5">HGhub {APP_VERSION} · {platform === "android" ? "Android" : platform === "ios" ? "iOS" : platform === "macos" ? "macOS" : platform === "linux" ? "Linux" : "Windows"} 客户端</div>
      </div>
    </div>
  );
}
const fmtBytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${(n / (1 << 20)).toFixed(n >= 100 << 20 ? 0 : 1)} MB`);

/* 离线缓存：按剧分组；已缓存的集点开即播（不请求上游），失败的集点击重试，删除整部需再点一次确认 */
function OfflineList() {
  const { push, toast } = useStore();
  const { episodes, series } = useOffline();
  const [confirm, setConfirm] = useState<number | null>(null);
  const groups = useMemo(() => {
    const byVid = new Map<number, OfflineEpisode[]>();
    for (const e of Object.values(episodes)) byVid.set(e.vid, [...(byVid.get(e.vid) || []), e]);
    return [...byVid.entries()]
      .map(([vid, eps]) => ({ vid, eps: [...eps].sort((a, b) => a.ep - b.ep), latest: Math.max(...eps.map((e) => e.seq)) }))
      .sort((a, b) => b.latest - a.latest);
  }, [episodes]);

  if (!groups.length) {
    return <Empty icon={<IDownload size={24} />} title="还没有离线缓存" sub="在播放页点「缓存」，缓存后可离线观看" />;
  }
  const total = groups.reduce((n, g) => n + g.eps.reduce((m, e) => m + e.bytes, 0), 0);
  const open = (vid: number, e: OfflineEpisode) => {
    const title = series[vid]?.title || e.title;
    if (e.state === "done") push({ kind: "feed", videoIds: [vid], index: 0, title, startEp: e.ep });
    else if (e.state === "error") {
      const detail = series[vid];
      if (detail) cacheEpisodes(detail, [e.ep]).then(() => toast("已重新加入缓存队列", "ok")).catch(() => toast("加入缓存失败", "info"));
    } else if (interrupted(e)) {
      resumeOffline();
      toast(`第 ${e.ep} 集继续下载`, "ok");
    } else toast(`第 ${e.ep} 集${offlineLabel(e)}`, "info");
  };
  const remove = (vid: number) => {
    if (confirm !== vid) { setConfirm(vid); return; }
    setConfirm(null);
    removeOffline(vid).then(() => toast("已删除缓存", "ok")).catch(() => toast("删除失败", "info"));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10.5px] text-mut">共 {groups.length} 部 · {fmtBytes(total)}</div>
      {groups.map(({ vid, eps }) => {
        const done = eps.filter((e) => e.state === "done").length;
        const active = eps.find((e) => e.state === "downloading");
        const stalled = eps.find(interrupted);
        const failed = eps.filter((e) => e.state === "error");
        return (
          <div key={vid} className="rounded-(--r-md) bg-s1 p-2.5 flex gap-3 elev-1">
            <div className="relative w-[60px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
              <Img src={offlineCover(vid)} raw />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <div className="flex-1 text-[13px] font-semibold text-on truncate">{series[vid]?.title || eps[0].title}</div>
                <button onClick={() => remove(vid)} aria-label={confirm === vid ? "确认删除" : "删除缓存"}
                  className={`h-7 shrink-0 rounded-full flex items-center justify-center pressable ${confirm === vid ? "px-3 bg-primary text-on-primary text-[11px] font-semibold" : "w-7 bg-s3 text-mut"}`}>
                  {confirm === vid ? "确认删除" : <ITrash size={14} />}
                </button>
              </div>
              <div className="text-[10.5px] text-mut mt-0.5">
                已缓存 {done}/{eps.length} 集 · {fmtBytes(eps.reduce((n, e) => n + e.bytes, 0))}
                {active ? ` · 第 ${active.ep} 集${offlineLabel(active)}` : ""}
              </div>
              {/* 说清楚为什么没下完：网络中断会在回到应用或网络恢复时自动继续；失败的集点一下重试 */}
              {!active && stalled && (
                <div className="text-[10.5px] text-mut mt-0.5">第 {stalled.ep} 集网络中断（{stalled.error}），回到应用后自动继续</div>
              )}
              {failed.length > 0 && (
                <div className="text-[10.5px] text-red-400 mt-0.5">
                  第 {failed.map((e) => e.ep).join("、")} 集失败{failed[0].error ? `（${failed[0].error}）` : ""}，点集数重试
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {eps.map((e) => (
                  <button key={e.ep} onClick={() => open(vid, e)} aria-label={`第 ${e.ep} 集 ${offlineLabel(e)}`}
                    className={`h-7 min-w-[30px] px-2 rounded-(--r-sm) text-[11px] font-semibold pressable ${e.state === "done" ? "bg-s3 text-on" : e.state === "error" ? "bg-s3 text-red-400" : "bg-s3 text-mut"}`}>
                    {e.ep}{e.state === "done" ? "" : e.state === "error" ? " 失败" : e.state === "downloading" ? (e.total ? ` ${Math.floor((e.done / e.total) * 100)}%` : " 准备") : interrupted(e) ? " 中断" : " 等待"}
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

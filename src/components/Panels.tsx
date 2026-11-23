import { useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, cover as imageCover } from "../api";
import { handleArticleClick, sanitizeHtml } from "../html";
import type { Comment, CommentPage, Detail, Episode } from "../types";
import { useStore } from "../store";
import { cacheEpisodes, useOffline, type OfflineEpisode } from "../offline";
import { Avatar, Empty } from "./ui";
import { IClose, IHeart, ISendF } from "../icons";

/** 一集缓存状态的简短说明；没有缓存记录时返回空串 */
export function offlineLabel(e?: OfflineEpisode) {
  if (!e) return "";
  if (e.state === "done") return "已缓存";
  if (e.state === "error") return "失败，点此重试";
  if (e.state === "downloading") return e.total ? `下载中 ${Math.floor((e.done / e.total) * 100)}%` : "下载中";
  return "排队中";
}

/* ================= 离线缓存（播放页） ================= */
export function CachePanel({ detail, curEp, onClose }: { detail?: Detail; curEp: number; onClose: () => void }) {
  const { toast } = useStore();
  const { episodes: cached } = useOffline();
  if (!detail?.episodes?.length) {
    return <div className="px-4 pb-6 pt-2 text-[12px] text-mut">选集还没加载好，稍后再试</div>;
  }
  const stateOf = (ep: number) => cached[`${detail.id}:${ep}`];
  const current = stateOf(curEp);
  const rest = detail.episodes.map((e) => e.ep_num).filter((n) => n > curEp && (!stateOf(n) || stateOf(n)?.state === "error"));
  const add = async (eps: number[]) => {
    try {
      await cacheEpisodes(detail, eps);
      toast(eps.length > 1 ? `已加入 ${eps.length} 集` : "已加入缓存队列", "ok");
      onClose();
    } catch (e) {
      toast(typeof e === "string" ? e : (e as Error).message || "加入缓存失败", "info");
    }
  };
  const row = "w-full h-12 mt-2 px-4 rounded-(--r-ctl) bg-s3 flex items-center justify-between text-[13px] font-semibold text-on pressable disabled:opacity-50";
  return (
    <div className="px-4 pb-5">
      <div className="text-[14px] font-bold text-on">离线缓存</div>
      <div className="text-[11px] text-mut mt-1 leading-relaxed">缓存后可离线观看。一次只下载一个文件，在线播放时自动暂停；在「我的 → 离线缓存」查看和删除。</div>
      <button onClick={() => void add([curEp])} disabled={!!current && current.state !== "error"} className={row}>
        <span>缓存本集（第 {curEp} 集）</span>
        <span className="text-[11.5px] font-normal text-mut">{offlineLabel(current)}</span>
      </button>
      <button onClick={() => void add(rest)} disabled={!rest.length} className={row}>
        <span>{rest.length ? `缓存本剧剩余 ${rest.length} 集` : "后面的集都已在缓存中"}</span>
      </button>
    </div>
  );
}

/* ================= 选集 ================= */
export function EpisodesPanel({ videoId, episodes, current, onPick, onClose, bare = false }: {
  videoId: number; episodes: Episode[]; current: number; onPick: (ep: number) => void; onClose: () => void;
  /** 嵌在双栏抽屉里时，隐藏自带的标题栏与底注 */
  bare?: boolean;
}) {
  const [asc, setAsc] = useState(true);
  const list = asc ? episodes : [...episodes].reverse();
  return (
    <div className="flex flex-col h-full">
      {bare ? (
        <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
          <span className="text-[10.5px] text-mut">共 {episodes.length} 集</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto text-[11px] text-primary pressable">{asc ? "倒序" : "正序"}</button>
        </div>
      ) : (
        <div className="shrink-0 flex items-center gap-2 px-4 h-12">
          <span className="text-[13.5px] font-bold text-on">选集</span>
          <span className="text-[10.5px] text-mut">共 {episodes.length} 集</span>
          <button onClick={() => setAsc((v) => !v)} className="ml-auto text-[11px] text-primary pressable">{asc ? "倒序" : "正序"}</button>
          <button onClick={onClose} aria-label="关闭" className="w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
            <IClose size={13} />
          </button>
        </div>
      )}
      <div className="flex-1 scroll-y px-4 pb-4">
        <div className="grid grid-cols-4 gap-2">
          {list.map((e) => (
            <button key={e.ep_num} onClick={() => onPick(e.ep_num)}
              className={`h-10 rounded-(--r-sm) text-[12px] font-semibold pressable ${e.ep_num === current ? "bg-primary text-on-primary" : "bg-s3 text-on/80"}`}>
              {e.ep_num}
            </button>
          ))}
        </div>
        {!episodes.length && <div className="text-center text-[11.5px] text-dim py-8">暂无剧集</div>}
      </div>
      {!bare && <div className="shrink-0 px-4 py-2.5 text-[10.5px] text-dim bg-s2/60">剧集 ID {videoId} · 点选即切换播放</div>}
    </div>
  );
}

/* ================= 评论 ================= */
export function CommentsPanel({ videoId, ep, total, kind = "video", onClose }: {
  videoId: number; ep: number; total: number; kind?: "video" | "post"; onClose: () => void;
}) {
  const { user, setLoginOpen, toast } = useStore();
  const [items, setItems] = useState<Comment[]>([]);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (p: number) => {
    setLoading(true);
    try {
      const res: CommentPage | null = kind === "post"
        ? await api.postComments(videoId, p, 20)
        : await api.comments(videoId, ep, p, 20);
      setItems((prev) => {
        const base = p === 1 ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...(res?.items || []).filter((x) => !seen.has(x.id))];
      });
      setPage(p);
      setPages(res?.pagination?.pages || 1);
    } catch {
      if (p === 1) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(1); /* eslint-disable-next-line */ }, [videoId, ep, kind]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    if (!user) { setLoginOpen(true); return; }
    setSending(true);
    try {
      await api.commentSend(videoId, ep, t);
      setText("");
      toast("评论已提交，审核通过后展示", "ok");
      load(1);
    } catch (e) {
      toast((e as Error).message || "评论失败", "info");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">评论</span>
        <span className="text-[10.5px] text-mut">{fmt(total)} · 第 {ep} 集</span>
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>

      <div className="flex-1 scroll-y px-4">
        {items.length ? items.map((c) => (
          <div key={c.id} className="flex gap-2.5 py-3 border-b border-s3 last:border-0">
            <Avatar size={32} name={c.nickname} hue={(c.user_id * 37) % 360} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[11.5px] font-semibold text-on/90">{c.nickname}</span>
                <span className="text-[10px] text-dim">{c.time}</span>
              </div>
              <p className="text-[12.5px] text-on/80 mt-1 leading-relaxed whitespace-pre-wrap">{c.text}</p>
              <div className="flex items-center gap-3 mt-1.5 text-[10.5px] text-dim">
                <span className="flex items-center gap-1"><IHeart size={11} />{c.like_count || 0}</span>
                {c.reply_count > 0 && <span>{c.reply_count} 条回复</span>}
              </div>
            </div>
          </div>
        )) : loading ? (
          <div className="flex justify-center py-10"><div className="w-7 h-7 spinner" /></div>
        ) : (
          <Empty icon={<IHeart size={22} />} title="还没有评论" sub="来抢第一个沙发" />
        )}
        {items.length > 0 && (
          <div className="flex justify-center py-4">
            {loading ? <div className="w-5 h-5 spinner" />
              : page < pages ? (
                <button onClick={() => load(page + 1)} className="px-4 h-8 rounded-(--r-ctl) bg-s3 text-[11.5px] text-on/80 pressable">查看更多</button>
              ) : <span className="text-[10.5px] text-dim">— 到底啦 —</span>}
          </div>
        )}
      </div>

      <form className="shrink-0 flex items-center gap-2 px-3 py-2.5 bg-s2/70" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Avatar size={30} name={user?.nickname || "我"} hue={322} />
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)}
          onFocus={() => { if (!user) setLoginOpen(true); }}
          placeholder={user ? "说点什么…" : "登录后参与评论"}
          className="flex-1 min-w-0 h-9 rounded-(--r-ctl) bg-s4 px-3.5 text-[12.5px] text-on placeholder-dim outline-none focus:bg-s3" />
        <button type="submit" disabled={!text.trim() || sending}
          className={`w-9 h-9 rounded-full flex items-center justify-center pressable ${text.trim() ? "brand-grad glow-neon" : "bg-s3 text-dim"}`}>
          {sending ? <span className="w-4 h-4 spinner" /> : <ISendF size={16} />}
        </button>
      </form>
    </div>
  );
}
/* ================= 图文正文（吃瓜） ================= */
export function ArticlePanel({ title, html, cover, hot, onClose }: {
  title: string; html: string; cover?: string; hot?: number; onClose: () => void;
}) {
  const { toast, strictSecurity } = useStore();
  const safeHtml = useMemo(() => sanitizeHtml(html), [html, strictSecurity]);
  const openSafeLink = (url: string) => {
    api.openUrl(url).catch(() => {
      navigator.clipboard?.writeText(url).then(() => toast("链接已复制", "ok")).catch(() => {});
    });
  };
  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex items-center gap-2 px-4 h-12">
        <span className="text-[13.5px] font-bold text-on">图文详情</span>
        {hot ? <span className="text-[10.5px] text-mut">{fmt(hot)} 热度</span> : null}
        <button onClick={onClose} aria-label="关闭" className="ml-auto w-7 h-7 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
          <IClose size={13} />
        </button>
      </div>
      <div className="flex-1 scroll-y px-4 pb-6">
        {cover && <img src={imageCover(cover)} alt="" className="w-full rounded-(--r-md) mb-3 object-cover" />}
        <h2 className="text-[16px] font-bold text-on leading-snug">{title}</h2>
        <div className="article-body mt-3" onClick={(e) => handleArticleClick(e, openSafeLink)} dangerouslySetInnerHTML={{ __html: safeHtml }} />
        {!safeHtml && <p className="text-[12px] text-dim mt-4">这篇内容没有正文，可能只有图片或视频。</p>}
      </div>
    </div>
  );
}

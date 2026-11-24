import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Feed from "../components/Feed";
import { api } from "../api";
import type { VideoCard } from "../types";
import { useStore } from "../store";
import { ISearch } from "../icons";
import { Empty } from "../components/ui";
import { useTagFilter, visibleByTags } from "../contentFilter";

/* 上游推荐接口（/api/videos）的顺序是固定的，每次打开首页都从同样几部开始。
   这里按页随机：在记下的总页数里随机挑还没取过的页，页内顺序也打乱；
   第一次使用还不知道总页数时先取第 1 页。请求量和原来一样，每次滑到底取一页。 */
const PAGES_KEY = "hghub_feed_pages";
const SIZE = 10;
const readPages = () => { try { return Math.max(0, Math.floor(Number(localStorage.getItem(PAGES_KEY)) || 0)); } catch { return 0; } };
const shuffle = <T,>(list: T[]) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export default function Home({ active, bottomInset }: { active: boolean; bottomInset: number }) {
  const { toast } = useStore();
  const filterOn = useTagFilter();
  const [items, setItems] = useState<VideoCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const loadingRef = useRef(false);
  const pagesRef = useRef(readPages());
  const fetched = useRef(new Set<number>());

  const load = useCallback(async () => {
    if (loadingRef.current || done) return;
    // 下一页：总页数未知时取第 1 页，否则在还没取过的页里随机挑
    const total = pagesRef.current;
    const left = Array.from({ length: total }, (_, i) => i + 1).filter((p) => !fetched.current.has(p));
    const p = total ? left[Math.floor(Math.random() * left.length)] : fetched.current.has(1) ? 0 : 1;
    if (!p) { setDone(true); return; }
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const res = await api.feed(p, SIZE);
      fetched.current.add(p);
      const pages = res?.pagination?.pages || 0;
      if (pages !== pagesRef.current) {
        pagesRef.current = pages;
        try { localStorage.setItem(PAGES_KEY, String(pages)); } catch { /* 下次仍从第 1 页开始 */ }
      }
      const list = shuffle(res?.items || []);
      setItems((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...list.filter((x) => !seen.has(x.id))];
      });
      if (!pages || [...fetched.current].filter((n) => n <= pages).length >= pages) setDone(true);
    } catch (e) {
      const message = (e as Error).message || "加载失败";
      setError(message);
      toast(message, "info");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [done, toast]);

  useEffect(() => { if (!items.length) void load(); /* eslint-disable-next-line */ }, []);

  // Feed 的详情预取依赖 videoIds；保持引用稳定，播放进度等无关的 store 更新就不会重复请求。
  const ids = useMemo(() => visibleByTags(items, filterOn).map((v) => v.id), [items, filterOn]);

  /* 一页可能被内容过滤整页去掉（或那一页已经没有内容）：能看的不够时接着取下一页 */
  useEffect(() => {
    if (!loading && !done && !error && fetched.current.size > 0 && ids.length < 3) void load();
  }, [loading, done, error, ids.length, load]);

  return (
    <div className="absolute inset-0 bg-black">
      {ids.length ? (
        <Feed videoIds={ids} mode="home" active={active} bottomInset={bottomInset}
          onNearEnd={() => { if (!loading && !done) void load(); }} />
      ) : !loading && error ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Empty icon={<ISearch size={26} />} title="首页加载失败" sub={error} action="重试" onAction={() => void load()} />
        </div>
      ) : !loading && done ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg"><Empty icon={<ISearch size={26} />} title="暂无视频" /></div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>
      )}
    </div>
  );
}

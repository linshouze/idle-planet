import { Link, useSearchParams } from 'react-router-dom';
import { Button, Select } from 'antd';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Category, ItemList } from '../api/types';
import { Hero } from '../components/Hero';
import { ItemCardView } from '../components/ItemCardView';
import { XingAvatar, XingBadge } from '../components/Xing';
import { LeaderboardStrip } from './Leaderboard';

const PAGE = 20;
const TABS = [
  { key: '', label: '最新发布' },
  { key: 'free', label: '免费专区' },
  { key: 'fixed', label: '一口价' },
] as const;

/** 关键词无结果时的 AI 语义匹配展示：理解一句话 + 匹配商品及理由。 */
function AiFallback({ ai }: { ai: NonNullable<ItemList['ai']> }) {
  return (
    <div className="ai-search">
      <div className="ai-head">
        <XingAvatar />
        <XingBadge label="小星语义搜索" />
        没有匹配关键词的结果，小星理解为：<b>{ai.understanding}</b>
      </div>
      <div className="grid" style={{ textAlign: 'left' }}>
        {ai.results.map(({ item, reason }) => (
          <div key={item.id} className="ai-hit">
            <ItemCardView item={item} />
            <div className="ai-reason">{reason}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Market() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const tradeType = params.get('type') ?? '';
  const kind = params.get('kind') ?? '';
  const sort = params.get('sort') ?? 'latest';

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/api/categories') });

  const list = useInfiniteQuery({
    queryKey: ['items', q, category, tradeType, kind, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const sp = new URLSearchParams({ limit: String(PAGE), offset: String(pageParam), sort });
      if (q) sp.set('q', q);
      if (category) sp.set('category', category);
      if (tradeType) sp.set('tradeType', tradeType);
      if (kind) sp.set('kind', kind);
      return api<ItemList>(`/api/items?${sp}`);
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(q || category || tradeType || kind);

  return (
    <>
      {!q && <Hero />}
      {q && (
        <div className="breadcrumb">
          搜索「{q}」，共 {total} 件
          <button className="tab" style={{ marginLeft: 12, padding: 0 }} onClick={() => set('q', '')}>
            清除搜索
          </button>
        </div>
      )}

      <div className="pills" role="group" aria-label="商品分类">
        <button className={`pill${!category ? ' on' : ''}`} onClick={() => set('category', '')}>
          全部
        </button>
        {categories.data?.categories.map((c) => (
          <button key={c.id} className={`pill${category === String(c.id) ? ' on' : ''}`} onClick={() => set('category', String(c.id))}>
            {c.name}
          </button>
        ))}
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tradeType === t.key} className={`tab${tradeType === t.key ? ' on' : ''}`} onClick={() => set('type', t.key)}>
            {t.label}
          </button>
        ))}
        <Select
          className="tab-right"
          value={sort}
          onChange={(v) => set('sort', v === 'latest' ? '' : v)}
          variant="borderless"
          style={{ width: 118 }}
          options={[
            { value: 'latest', label: '按发布时间' },
            { value: 'expiring', label: '即将过期' },
            { value: 'price_asc', label: '价格从低到高' },
            { value: 'price_desc', label: '价格从高到低' },
          ]}
        />
      </div>

      {list.isLoading ? (
        <div className="grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skel-card">
              <div className="cover" />
              <div className="b"><div className="xing-skel w85" /><div className="xing-skel w60" /></div>
            </div>
          ))}
        </div>
      ) : list.isError ? (
        <div className="empty">
          <b>商品加载失败</b>
          {list.error.message}
          <div>
            <Button onClick={() => list.refetch()}>重新加载</Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="empty">
          <b>{filtered ? '没有找到符合条件的商品' : '还没有人发布闲置物品'}</b>
          {list.data?.pages[0]?.ai && list.data.pages[0].ai.results.length > 0 ? (
            <AiFallback ai={list.data.pages[0].ai} />
          ) : (
            <>
              {filtered ? '换个关键词或分类试试。' : '成为第一个发布的人。'}
              <div>
                <Link to="/publish">
                  <Button type="primary">发布闲置物品</Button>
                </Link>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="grid">
            {items.map((it, idx) => (
              <div key={it.id} className="card-enter" style={{ animationDelay: idx < 12 ? `${idx * 40}ms` : undefined }}>
                <ItemCardView item={it} />
              </div>
            ))}
          </div>
          <div className="load-more">
            {list.hasNextPage ? (
              <Button loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                加载更多（已显示 {items.length} / {total}）
              </Button>
            ) : (
              <>已显示全部 {total} 件</>
            )}
          </div>
        </>
      )}
      <LeaderboardStrip />
    </>
  );
}

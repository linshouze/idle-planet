import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Segmented, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { BoardRow, LeaderboardData } from '../api/types';

const WINDOW_LABEL: Record<LeaderboardData['window'], string> = {
  season: '本赛季',
  month: '本月',
  all: '全部',
};

function RankNo({ n }: { n: number }) {
  return <span className={`lb-rank${n <= 3 ? ` top${n}` : ''}`}>{n}</span>;
}

function BoardList({ title, rows, kind }: { title: string; rows: BoardRow[]; kind: 'sell' | 'buy' }) {
  return (
    <div className="lb-card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="muted" style={{ padding: '18px 0' }}>还没有人上榜</div>
      ) : (
        rows.map((r) => (
          <div className="lb-row" key={r.userId}>
            <RankNo n={r.rank} />
            <div className="lb-who">
              <b>{r.name}</b>
              {r.badge && <span className="lb-badge">{r.badge}</span>}
              <span className="muted"> {r.department}</span>
            </div>
            <div className="lb-nums">
              <b>{r.count}</b> 件
              {kind === 'sell' && r.freeCount > 0 && <span className="muted">（免费送 {r.freeCount}）</span>}
              {r.saved > 0 && <span className="muted"> · 省 ¥{r.saved}</span>}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** 集市首页底部的英雄榜区块：两小榜前 3 + 我的排名。 */
export function LeaderboardStrip() {
  const q = useQuery({ queryKey: ['leaderboard', 'season'], queryFn: () => api<LeaderboardData>('/api/leaderboard?window=season'), staleTime: 60_000 });
  const d = q.data;
  if (!d || (d.sellers.length === 0 && d.buyers.length === 0)) return null;

  const best = Math.min(
    ...[d.me.sellerRank, d.me.buyerRank].filter((x): x is number => x !== null).concat([Infinity]),
  );
  const totalCount = d.me.sellerCount + d.me.buyerCount;

  return (
    <section className="lb-strip">
      <div className="lb-strip-head">
        <h2>闲置英雄榜</h2>
        <Link to="/leaderboard" className="lb-more">
          查看全部 ›
        </Link>
      </div>
      <div className="lb-cols">
        <BoardList title="出闲置 TOP 3" rows={d.sellers.slice(0, 3)} kind="sell" />
        <BoardList title="收闲置 TOP 3" rows={d.buyers.slice(0, 3)} kind="buy" />
      </div>
      <div className="lb-me">
        {Number.isFinite(best) ? `我的排名：第 ${best} · 成交 ${totalCount} 件` : '还没有成交，第一笔就是你的名字'}
      </div>
    </section>
  );
}

export function Leaderboard() {
  const [win, setWin] = useState<'season' | 'month' | 'all'>('season');
  const q = useQuery({ queryKey: ['leaderboard', win], queryFn: () => api<LeaderboardData>(`/api/leaderboard?window=${win}`) });
  const d = q.data;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 className="page-title" style={{ margin: '2px 0 16px' }}>闲置英雄榜</h1>
        <Segmented
          style={{ marginBottom: 12 }}
          value={win}
          onChange={(v) => setWin(v as typeof win)}
          options={[
            { value: 'season', label: `赛季（${d?.seasonStart ?? '11-04'} 起）` },
            { value: 'month', label: '本月' },
            { value: 'all', label: '全部' },
          ]}
        />
      </div>

      {q.isLoading || !d ? (
        <div className="empty"><Spin /></div>
      ) : d.sellers.length === 0 && d.buyers.length === 0 ? (
        <div className="empty">
          <b>还没有英雄</b>
          第一笔成交，就是你。
          <div>
            <Link to="/"><Button type="primary">去逛逛</Button></Link>
            <Link to="/publish"><Button style={{ marginLeft: 10 }}>发布闲置</Button></Link>
          </div>
        </div>
      ) : (
        <>
          {d.star && (
            <div className="lb-star">
              <span className="xing-badge">★ {WINDOW_LABEL[d.window]}之星</span>
              <b>{d.star.name}</b>
              <span className="muted"> {d.star.department ?? ''}</span>
              <span>流转 {d.star.count} 件{d.star.saved > 0 ? ` · 省 ¥${d.star.saved}` : ''}</span>
            </div>
          )}
          <div className="lb-cols">
            <BoardList title="出闲置榜" rows={d.sellers} kind="sell" />
            <BoardList title="收闲置榜" rows={d.buyers} kind="buy" />
            <div className="lb-card">
              <h3>部门流转榜</h3>
              {d.departments.length === 0 ? (
                <div className="muted" style={{ padding: '18px 0' }}>暂无数据</div>
              ) : (
                d.departments.map((r) => (
                  <div className="lb-row" key={r.department}>
                    <RankNo n={r.rank} />
                    <div className="lb-who">
                      <b>{r.department}</b>
                    </div>
                    <div className="lb-nums">
                      <b>{r.count}</b> 件{r.saved > 0 ? <span className="muted"> · 省 ¥{r.saved}</span> : ''}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          {(d.me.sellerRank !== null || d.me.buyerRank !== null) && (
            <div className="lb-me">
              我的排名：出闲置 {d.me.sellerRank ? `第 ${d.me.sellerRank}（${d.me.sellerCount} 件）` : '未上榜'} · 收闲置{' '}
              {d.me.buyerRank ? `第 ${d.me.buyerRank}（${d.me.buyerCount} 件）` : '未上榜'}
            </div>
          )}
          <div className="footnote">
            仅统计平台内完成的交易（{WINDOW_LABEL[d.window]}口径，不含演示数据），不含群聊线下成交。免费互刷不设防，快乐第一。
          </div>
        </>
      )}
    </>
  );
}

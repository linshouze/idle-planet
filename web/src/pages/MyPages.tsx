import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../api/client';
import type { MyItem, MyRequest } from '../api/types';
import { useCompleteDeal, useConfirm } from '../auth';
import { Contact } from '../components/Contact';
import { ITEM_STATUS, REQUEST_STATUS, formatDateTime, priceText, timeAgo } from '../format';

function Thumb({ src, title }: { src: string | null; title: string }) {
  return <div className="row-thumb">{src && <img src={src} alt={title} />}</div>;
}

function Empty({ title, hint, to, cta }: { title: string; hint: string; to: string; cta: string }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {hint}
      <div>
        <Link to={to}>
          <Button type="primary">{cta}</Button>
        </Link>
      </div>
    </div>
  );
}

/** 需要卖家处理的排前面：有待处理申请、等待交付。 */
const urgency = (i: MyItem): number => (i.pendingCount > 0 ? 0 : i.status === 'locked' ? 1 : i.status === 'handed_over' ? 2 : i.status === 'published' ? 3 : 4);

/** F16：过期自动下架的券显示「已过期」。 */
const statusChip = (it: MyItem): { label: string; tone: string } =>
  it.status === 'withdrawn' && it.withdrawReason === 'expired' ? { label: '已过期', tone: 'orange' } : ITEM_STATUS[it.status];

/** 单件（或展开后的同组成员）卡片行。 */
function ItemRow({ it }: { it: MyItem }) {
  const confirm = useConfirm();
  const st = statusChip(it);
  const online = it.kind === 'voucher' && it.handoffMode === 'online';
  return (
    <div className="row-card">
      <Thumb src={it.cover} title={it.title} />
      <div className="row-main">
        <div className="row-title">
          <Link to={`/items/${it.id}`}>{it.title}</Link>
          <span className={`chip ${st.tone}`}>{st.label}</span>
          {it.wishCount > 0 && <span className="xing-chip">✦ {it.wishCount} 人在找</span>}
          {it.negotiationFloor != null && (
            <span className="xing-chip" title="只有小星知道，不会展示给任何人">✦ 可代谈 · 底价 ¥{it.negotiationFloor}</span>
          )}
        </div>
        <div className="row-sub">
          {priceText(it.tradeType, it.price)} · 发布于 {timeAgo(it.publishedAt)}
        </div>
        {it.status === 'published' && (
          <div className="row-sub" style={{ color: it.pendingCount > 0 ? 'var(--price)' : undefined, fontWeight: it.pendingCount > 0 ? 600 : undefined }}>
            {it.pendingCount > 0 ? `${it.pendingCount} 位同事在等你确认` : '暂时没有人申请'}
          </div>
        )}
        {it.deal && (
          <div className="row-sub">
            交易对象：{it.deal.buyerName}
            {it.deal.price != null && it.deal.price !== it.price ? ` · 成交价 ¥${it.deal.price}（挂牌价 ¥${it.price}）` : ''}
            {it.deal.handedOverAt ? `，已于 ${formatDateTime(it.deal.handedOverAt)} 标记${online ? '转赠' : '交付'}，等待对方确认收到` : '，请联系对方约时间交接'}
            <Contact label="买家联系方式" value={it.deal.buyerContact} />
          </div>
        )}
      </div>
      <div className="row-acts">
        {it.status === 'published' && (
          <Link to={`/items/${it.id}`}>
            <Button type={it.pendingCount > 0 ? 'primary' : 'default'}>{it.pendingCount > 0 ? '去处理' : '查看'}</Button>
          </Link>
        )}
        {it.status === 'locked' && it.deal && (
          <Button
            type="primary"
            onClick={() =>
              confirm(
                online ? '确认已把券转赠给买家？' : '确认已把物品交给买家？',
                '标记后由买家确认收到，交易才算完成。',
                online ? '已转赠' : '已交付',
                () => post(`/api/requests/${it.deal!.requestId}/handover`),
                online ? '已标记转赠' : '已标记交付',
              )
            }
          >
            {online ? '已转赠' : '已交付'}
          </Button>
        )}
        {(it.status === 'locked' || it.status === 'handed_over') && (
          <Link to={`/items/${it.id}`}>
            <Button>查看</Button>
          </Link>
        )}
      </div>
    </div>
  );
}

interface GroupEntry {
  key: string;
  title: string;
  cover: string | null;
  members: MyItem[];
  completed: number;
  published: number;
  expired: number;
}

export function MyItems() {
  const q = useQuery({ queryKey: ['my-items'], queryFn: () => api<{ items: MyItem[] }>('/api/me/items') });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (q.isLoading) return <div className="empty"><Spin /></div>;
  if (q.isError) return <div className="empty"><b>加载失败</b>{q.error.message}<div><Button onClick={() => q.refetch()}>重新加载</Button></div></div>;

  // F16：同一 listing_group 的券按组折叠，展开后可见每一件的状态与操作
  const rows = q.data!.items;
  const singles: MyItem[] = [];
  const groups = new Map<string, GroupEntry>();
  for (const it of rows) {
    if (!it.listingGroup) {
      singles.push(it);
      continue;
    }
    let g = groups.get(it.listingGroup);
    if (!g) {
      g = { key: it.listingGroup, title: it.title, cover: it.cover, members: [], completed: 0, published: 0, expired: 0 };
      groups.set(it.listingGroup, g);
    }
    g.members.push(it);
    if (it.status === 'completed') g.completed += 1;
    if (it.status === 'published') g.published += 1;
    if (it.status === 'withdrawn' && it.withdrawReason === 'expired') g.expired += 1;
  }
  const entries: { key: string; sort: number; single?: MyItem; group?: GroupEntry }[] = [
    ...singles.map((it) => ({ key: `i${it.id}`, sort: urgency(it), single: it })),
    ...[...groups.values()].map((g) => ({
      key: `g${g.key}`,
      sort: Math.min(...g.members.map(urgency)),
      group: g,
    })),
  ].sort((a, b) => a.sort - b.sort);

  return (
    <>
      <h1 className="page-title">我的发布</h1>
      {entries.length === 0 ? (
        <Empty title="你还没有发布过物品" hint="把用不上的东西发布出来，让同事接手。" to="/publish" cta="发布闲置物品" />
      ) : (
        entries.map((e) => {
          if (e.single) return <ItemRow key={e.key} it={e.single} />;
          const g = e.group!;
          const open = expanded[e.key] ?? false;
          const stats = [
            g.completed > 0 ? `已成交 ${g.completed}` : null,
            g.published > 0 ? `在售 ${g.published}` : null,
            g.expired > 0 ? `已过期 ${g.expired}` : null,
          ]
            .filter(Boolean)
            .join('、');
          return (
            <div className="group-block" key={e.key}>
              <div className="row-card group-card">
                <Thumb src={g.cover} title={g.title} />
                <div className="row-main">
                  <div className="row-title">
                    <span>{g.title}</span>
                    <span className="chip">×{g.members.length}</span>
                    {stats && <span className="muted">（{stats}）</span>}
                  </div>
                  <div className="row-sub">{priceText(g.members[0].tradeType, g.members[0].price)} · 同一次发布拆成的多件券，每件独立走申请和选人流程</div>
                </div>
                <div className="row-acts">
                  <Button onClick={() => setExpanded((s) => ({ ...s, [e.key]: !open }))}>{open ? '收起' : '展开'}</Button>
                </div>
              </div>
              {open && (
                <div className="group-members">
                  {g.members.map((m) => (
                    <ItemRow key={m.id} it={m} />
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

export function MyRequests() {
  const confirm = useConfirm();
  const complete = useCompleteDeal();
  const q = useQuery({ queryKey: ['my-requests'], queryFn: () => api<{ requests: MyRequest[] }>('/api/me/requests') });
  if (q.isLoading) return <div className="empty"><Spin /></div>;
  if (q.isError) return <div className="empty"><b>加载失败</b>{q.error.message}<div><Button onClick={() => q.refetch()}>重新加载</Button></div></div>;
  const rank = (r: MyRequest): number => (r.status === 'accepted' ? (r.handedOverAt ? 0 : 1) : r.status === 'pending' ? 2 : 3);
  const list = [...q.data!.requests].sort((a, b) => rank(a) - rank(b));

  return (
    <>
      <h1 className="page-title">我的申请</h1>
      {list.length === 0 ? (
        <Empty title="你还没有申请过物品" hint="去集市看看有没有用得上的。" to="/" cta="逛逛集市" />
      ) : (
        list.map((r) => {
          const st = REQUEST_STATUS[r.status];
          const handed = r.status === 'accepted' && Boolean(r.handedOverAt);
          return (
            <div className="row-card" key={r.id}>
              <Thumb src={r.item.cover} title={r.item.title} />
              <div className="row-main">
                <div className="row-title">
                  <Link to={`/items/${r.item.id}`}>{r.item.title}</Link>
                  <span className={`chip ${handed ? 'orange' : st.tone}`}>{handed ? '待你确认收货' : st.label}</span>
                  {r.negotiationId && r.agreedPrice != null && <span className="xing-chip">✦ 小星谈成 ¥{r.dealPrice}</span>}
                </div>
                <div className="row-sub">
                  卖家 {r.sellerName} · 申请于 {timeAgo(r.createdAt)}
                  {r.negotiationId && r.agreedPrice != null ? ` · 成交价 ¥${r.dealPrice}（挂牌价 ¥${r.item.price}）` : ''}
                  {r.message ? ` · 留言：${r.message}` : ''}
                </div>
                {r.status === 'accepted' && (
                  <div className="row-sub">
                    {handed ? '卖家已标记交付，收到物品后请确认。' : '卖家选择了你，请联系卖家约时间交接。'}
                    <Contact label="卖家联系方式" value={r.sellerContact} />
                  </div>
                )}
              </div>
              <div className="row-acts">
                {handed && (
                  <Button
                    type="primary"
                    onClick={() => confirm('确认已收到物品？', '确认后交易完成，此操作不能撤销。', '确认收到', () => complete(r.id))}
                  >
                    确认收到
                  </Button>
                )}
                {r.status === 'pending' && (
                  <Button
                    onClick={() => confirm('撤回申请？', '撤回后可以重新申请。', '撤回', () => post(`/api/requests/${r.id}/withdraw`), '申请已撤回')}
                  >
                    撤回申请
                  </Button>
                )}
                <Link to={`/items/${r.item.id}`}>
                  <Button>查看商品</Button>
                </Link>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

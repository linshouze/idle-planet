import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Checkbox, Input, InputNumber, Modal, Radio, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../api/client';
import type { WishMine, WishPublic, WishStats } from '../api/types';
import { useAct, useAuth, useConfirm } from '../auth';
import { XingBadge } from '../components/Xing';
import { fireConfetti } from '../components/Confetti';
import { ITEM_STATUS, priceText, timeAgo } from '../format';

const STATE_LABEL: Record<WishMine['state'], { label: string; tone: 'green' | 'orange' | 'blue' | 'gray' }> = {
  active: { label: '进行中', tone: 'green' },
  expired: { label: '已过期', tone: 'gray' },
  closed: { label: '已关闭', tone: 'gray' },
  fulfilled: { label: '已实现', tone: 'blue' },
};

function PublishWishModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const act = useAct();
  const { aiEnabled } = useAuth();
  const { message } = AntApp.useApp();
  const [content, setContent] = useState('');
  const [budgetMode, setBudgetMode] = useState<'any' | 'free' | 'max'>('any');
  const [max, setMax] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [xingText, setXingText] = useState('');
  const [xingLoading, setXingLoading] = useState(false);
  const [xingReason, setXingReason] = useState<string | null>(null);

  const runXing = async () => {
    const input = xingText.trim();
    if (!input) {
      message.warning('先用口语说一句你想要什么');
      return;
    }
    setXingLoading(true);
    try {
      const r = await api<{ available: boolean; draft?: { content: string; budget: number | null; freeOk: boolean; budgetReason: string | null } }>(
        '/api/ai/wish-draft',
        { method: 'POST', json: { text: input } },
      );
      if (!r.available || !r.draft) {
        message.warning('小星暂时不在，请手动写');
        return;
      }
      setContent(r.draft.content);
      if (r.draft.budget != null) {
        setBudgetMode('max');
        setMax(r.draft.budget);
      } else if (r.draft.freeOk) {
        setBudgetMode('free');
      }
      setXingReason(r.draft.budgetReason);
      message.success('小星帮你写好了，可以修改后发布');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '小星暂时不在，请手动写');
    } finally {
      setXingLoading(false);
    }
  };

  const submit = async () => {
    const text = content.trim();
    if (!text) return;
    setBusy(true);
    const ok = await act(
      () =>
        post('/api/wishes', {
          content: text,
          budget: budgetMode === 'max' ? max : null,
          freeOk: budgetMode !== 'max' ? budgetMode === 'free' : true,
        }),
      '心愿已发布，小星开始帮你找',
    );
    setBusy(false);
    if (ok) {
      setContent('');
      onClose();
    }
  };

  return (
    <Modal title="发布心愿" open={open} onCancel={onClose} okText="发布" cancelText="取消" confirmLoading={busy} onOk={submit} destroyOnHidden>
      {aiEnabled && (
        <div style={{ marginBottom: 12 }}>
          <div className="ai-row">
            <Input
              value={xingText}
              onChange={(e) => setXingText(e.target.value)}
              maxLength={200}
              placeholder="口语说一句：比如工位脖子疼，想找个东西垫一下"
              onPressEnter={runXing}
              disabled={xingLoading}
            />
            <Button loading={xingLoading} onClick={runXing}>
              <XingBadge /> 帮我写
            </Button>
          </div>
          {xingReason && <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>预算理由：{xingReason}</div>}
        </div>
      )}
      <Input.TextArea
        rows={3}
        maxLength={100}
        showCount
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="比如：想要个显示器支架，100 以内"
      />
      <div style={{ marginTop: 14 }}>
        <Radio.Group
          value={budgetMode}
          onChange={(e) => setBudgetMode(e.target.value)}
          optionType="button"
          options={[
            { value: 'any', label: '不限' },
            { value: 'free', label: '免费赠送' },
            { value: 'max', label: '设上限' },
          ]}
        />
        {budgetMode === 'max' && (
          <InputNumber min={1} max={1000000} precision={0} value={max ?? undefined} onChange={(v) => setMax(v)} suffix="元" style={{ marginLeft: 10, width: 140 }} placeholder="预算上限" />
        )}
      </div>
      <div className="muted" style={{ marginTop: 12, fontSize: 12.5 }}>
        心愿公开显示你的姓名和部门，同事可以「我有这个」直接响应；小星也会在后台帮你匹配在售商品。进行中的心愿最多 5 个，14 天未实现自动过期，可续期。
      </div>
    </Modal>
  );
}

interface WishListData {
  stats: WishStats;
  wishes: WishPublic[] | WishMine[];
}

export function Wishes() {
  const { aiEnabled } = useAuth();
  const act = useAct();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | 'mine'>('all');
  const [publishOpen, setPublishOpen] = useState(false);

  const q = useQuery<WishListData>({
    queryKey: ['wishes', tab],
    queryFn: async (): Promise<WishListData> =>
      tab === 'all' ? await api<{ stats: WishStats; wishes: WishPublic[] }>('/api/wishes?tab=all') : await api<{ stats: WishStats; wishes: WishMine[] }>('/api/wishes?tab=mine'),
    refetchInterval: tab === 'mine' ? 15_000 : false,
  });

  const stats = q.data?.stats;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 className="page-title" style={{ margin: '2px 0 16px' }}>心愿墙</h1>
        {stats && (
          <span className="muted" style={{ marginBottom: 12 }}>
            进行中 {stats.active} 个心愿 · 已实现 {stats.fulfilled} 个心愿
          </span>
        )}
        <Button type="primary" style={{ marginLeft: 'auto', marginBottom: 12 }} onClick={() => setPublishOpen(true)}>
          发布心愿
        </Button>
      </div>
      <div className="tabs" role="tablist">
        {(['all', 'mine'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
            {t === 'all' ? '全部心愿' : '我的心愿'}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="empty"><Spin /></div>
      ) : q.isError ? (
        <div className="empty"><b>加载失败</b>{q.error.message}<div><Button onClick={() => q.refetch()}>重新加载</Button></div></div>
      ) : tab === 'all' ? (
        (q.data as { wishes: WishPublic[] }).wishes.length === 0 ? (
          <div className="empty">
            <b>还没有人发布心愿</b>
            想要什么先说出来，同事看到可以直接响应，小星也会帮你盯着新上架的商品。
            <div><Button type="primary" onClick={() => setPublishOpen(true)}>发布心愿</Button></div>
          </div>
        ) : (
          <div className="wish-wall">
            {(q.data as { wishes: WishPublic[] }).wishes.map((w) => (
              <div className={`wish-note c${w.id % 6}`} key={w.id}>
                <span className="wish-star" aria-hidden="true">✦</span>
                <div className="wish-head">
                  <span className="ava">{w.ownerName.slice(0, 1)}</span>
                  <div>
                    <b>{w.ownerName}</b>
                    <span className="muted"> {w.ownerDepartment ?? ''} · {timeAgo(w.createdAt)}</span>
                  </div>
                  {w.matchCount > 0 && aiEnabled && (
                    <span className="chip" style={{ marginLeft: 'auto' }}>
                      小星已匹配 {w.matchCount} 件
                    </span>
                  )}
                </div>
                <div className="wish-content">{w.content}</div>
                <div className="wish-foot">
                  <span className="chip green">{w.budgetText}</span>
                  {!w.isMine && (
                    <Button size="small" type="primary" ghost style={{ marginLeft: 'auto' }} onClick={() => navigate(`/publish?wish=${w.id}`)}>
                      我有这个
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (q.data as { wishes: WishMine[] }).wishes.length === 0 ? (
        <div className="empty">
          <b>你还没有心愿</b>
          发布一条，小星会在后台帮你匹配在售商品，有同事响应也会通知你。
          <div><Button type="primary" onClick={() => setPublishOpen(true)}>发布心愿</Button></div>
        </div>
      ) : (
        (q.data as { wishes: WishMine[] }).wishes.map((w) => {
          const st = STATE_LABEL[w.state];
          return (
            <div className="wish-card" key={w.id}>
              <div className="wish-head">
                <div className="wish-content" style={{ margin: 0 }}>{w.content}</div>
                <span className={`chip ${st.tone}`}>{st.label}</span>
              </div>
              <div className="muted" style={{ fontSize: 12.5, margin: '6px 0 10px' }}>
                {w.budgetText} · 发布于 {timeAgo(w.createdAt)}
                {w.renewedAt ? ` · 续期于 ${timeAgo(w.renewedAt)}` : ''}
              </div>
              {w.state === 'active' && w.matches.length === 0 && aiEnabled && <div className="muted">小星正在帮你找，有匹配会出现在这里。</div>}
              {w.matches.length > 0 && (
                <div style={{ display: 'grid', gap: 10, marginTop: 4 }}>
                  {w.matches.map((m) => (
                    <div className="wish-match" key={m.matchId}>
                      <Link className="wish-item" to={`/items/${m.item.id}?from=${m.invitedBy ? 'invite' : 'wish_match'}${m.budget ? `&budget=${m.budget}` : ''}`}>
                        <div className="row-thumb">{m.item.cover && <img src={m.item.cover} alt={m.item.title} />}</div>
                        <div style={{ minWidth: 0 }}>
                          <div className="row-title">
                            {m.item.title}
                            {m.item.status !== 'published' && <span className="chip gray">{ITEM_STATUS[m.item.status].label}</span>}
                            {m.isNew && m.item.status === 'published' && <span className="chip orange">新</span>}
                          </div>
                          <div className={`row-sub price${m.item.tradeType === 'free' ? ' free' : ''}`}>{priceText(m.item.tradeType, m.item.price)}</div>
                        </div>
                      </Link>
                      <div className="ai-reason">
                        {aiEnabled && <XingBadge />}
                        {m.invitedBy ? <b> {m.invitedBy} 邀请你看看 ·</b> : null} {m.origin === 'direct' ? '同事响应心愿直接发布' : m.reason}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="btn-row" style={{ marginTop: 12 }}>
                {w.state === 'active' && (
                  <Button size="small" onClick={() => confirm('关闭这条心愿？', '关闭后不再参与匹配，也不能恢复。', '关闭', () => post(`/api/wishes/${w.id}/close`), '心愿已关闭')}>
                    关闭心愿
                  </Button>
                )}
                {w.state === 'expired' && (
                  <Button size="small" onClick={() => act(() => post(`/api/wishes/${w.id}/renew`), '已续期 14 天')}>续期 14 天</Button>
                )}
                {(w.state === 'active' || w.state === 'expired') && (
                  <Button size="small" type="primary" ghost onClick={() => confirm('标记为已实现？', '这条心愿将结束并计入「已实现」。', '已实现', async () => { await post(`/api/wishes/${w.id}/fulfill`); fireConfetti(); }, '恭喜，心愿已实现')}>
                    标记已实现
                  </Button>
                )}
              </div>
            </div>
          );
        })
      )}
      <PublishWishModal open={publishOpen} onClose={() => setPublishOpen(false)} />
    </>
  );
}

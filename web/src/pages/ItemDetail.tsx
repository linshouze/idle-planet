import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { App as AntApp, Button, Input, InputNumber, Modal, Spin } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../api/client';
import type { AskResponse, BuyerDetail, ItemDetail as Detail, NegoTurn, NegotiationView, SellerDetail, SellerRequest } from '../api/types';
import { useAct, useAuth, useCompleteDeal, useConfirm } from '../auth';
import { Contact } from '../components/Contact';
import { PlantArt } from '../components/Art';
import { XingBadge, XingPanel } from '../components/Xing';
import { CLOSE_REASON, CONDITION_LABEL, ITEM_STATUS, REQUEST_STATUS, expiryView, faceValueText, formatDateTime, timeAgo, voucherDue } from '../format';

/** 成交价口径：卖家降价到低于谈成价时按新挂牌价。 */
const dealPriceOf = (agreed: number | null, listPrice: number): number | null => (agreed == null ? null : Math.min(agreed, listPrice));

function Gallery({ images, title, voucher }: { images: Detail['images']; title: string; voucher: boolean }) {
  const [idx, setIdx] = useState(0);
  const cur = images[Math.min(idx, images.length - 1)];
  return (
    <div>
      <div className="gallery-main">
        {cur ? (
          <img src={cur.url} alt={title} />
        ) : (
          voucher && (
            <div className="voucher-ph" aria-hidden="true">
              <span className="voucher-ph-icon">🎟</span>
              <span className="voucher-ph-text">券·权益</span>
            </div>
          )
        )}
        {images.length > 1 && (
          <span className="counter">
            {idx + 1} / {images.length}
          </span>
        )}
      </div>
      {images.length > 1 && (
        <div className="thumbs">
          {images.map((im, i) => (
            <button key={im.id} className={`thumb${i === idx ? ' on' : ''}`} onClick={() => setIdx(i)} aria-label={`查看第 ${i + 1} 张图片`}>
              <img src={im.url} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ApplyButton({ item, prefill }: { item: BuyerDetail; prefill?: { text: string; n: number } | null }) {
  const { user } = useAuth();
  const act = useAct();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const label = item.tradeType === 'free' ? '申请领取' : '我想要';

  const start = () => {
    if (!user.contact) {
      message.warning('请先在右上角头像菜单里填写联系方式');
      return;
    }
    setOpen(true);
  };
  // F12「把这个问题写进申请留言」：外部预填留言并打开弹窗（每次 n 变化触发一次）
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    start();
  }, [prefill]);
  const submit = async () => {
    setBusy(true);
    const ok = await act(() => post(`/api/items/${item.id}/requests`, { message: text.trim() || undefined }), '申请已提交，等待卖家确认');
    setBusy(false);
    if (ok) {
      setOpen(false);
      setText('');
    }
  };

  return (
    <>
      <Button type="primary" size="large" block onClick={start}>
        {label}
      </Button>
      <div className="hint">卖家选择交易对象后，双方才能看到彼此的联系方式，再线下约时间交接。</div>
      <Modal title={label} open={open} onCancel={() => setOpen(false)} okText="提交申请" cancelText="取消" confirmLoading={busy} onOk={submit} destroyOnHidden>
        <p className="muted" style={{ marginTop: 0 }}>
          给卖家留一句话，例如你方便交接的时间。可以不填。
        </p>
        <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} maxLength={200} showCount rows={3} placeholder="今天 17:30 可以在一楼大厅交接" />
      </Modal>
    </>
  );
}

// ---- 小星代谈（F9） ----

/** 谈判气泡：左买方小星，右卖方小星，附出价标签。 */
function NegoBubbles({ turns }: { turns: NegoTurn[] }) {
  return (
    <div className="nego-chat">
      {turns.map((t, i) => (
        <div key={i} className={`nego-row ${t.role}`}>
          <div className="nego-bubble">
            <div className="say">{t.say}</div>
            <span className={`nego-offer${t.accept ? ' ok' : ''}`}>{t.accept ? '成交' : '出价'} ¥{t.offer}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 卖家申请人列表里可展开的谈判记录（不含买家心理价与附言）。 */
function NegoTranscript({ negotiationId, listPrice }: { negotiationId: number; listPrice: number }) {
  const q = useQuery({ queryKey: ['negotiation', negotiationId, 'seller'], queryFn: () => api<NegotiationView>(`/api/negotiations/${negotiationId}`) });
  if (q.isLoading) return <div className="muted nego-transcript">谈判记录加载中…</div>;
  if (q.isError) return <div className="muted nego-transcript">谈判记录暂时看不了：{q.error.message}</div>;
  const v = q.data!;
  return (
    <div className="nego-transcript">
      <NegoBubbles turns={v.turns} />
      {v.agreedPrice != null && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          小星谈成 ¥{dealPriceOf(v.agreedPrice, listPrice)}（挂牌价 ¥{listPrice}）
        </div>
      )}
    </div>
  );
}

/** 买家发起代谈：填心理价 → 1.5s 轮询看小星谈判 → 谈成后确认提交申请。 */
function NegotiateModal({ item, prefillMax, open, onClose }: { item: BuyerDetail; prefillMax?: number; open: boolean; onClose: () => void }) {
  const act = useAct();
  const { message } = AntApp.useApp();
  const [phase, setPhase] = useState<'form' | 'chat'>('form');
  const [max, setMax] = useState<number | undefined>(prefillMax);
  const [note, setNote] = useState('');
  const [negoId, setNegoId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const nego = useQuery({
    queryKey: ['negotiation', negoId],
    enabled: open && negoId != null,
    queryFn: () => api<NegotiationView>(`/api/negotiations/${negoId}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });
  const v = nego.data;
  const dealt = v?.status === 'deal' && v.agreedPrice != null;

  useEffect(() => {
    if (dealt && !msg && v?.agreedPrice != null) setMsg(`小星代谈达成 ¥${dealPriceOf(v.agreedPrice, v.listPrice)}`);
  }, [dealt, msg, v]);

  const start = async () => {
    if (!max || max < 1) {
      message.warning('请填写你的心理价');
      return;
    }
    if (max >= item.price) {
      message.warning('心理价不低于挂牌价，直接按原价申请即可');
      return;
    }
    setBusy(true);
    const ok = await act(async () => {
      const r = await post<{ id: number }>(`/api/items/${item.id}/negotiations`, { buyerMax: max, note: note.trim() || undefined });
      setNegoId(r.id);
    }, '小星开始帮你谈了，稍等片刻看结果');
    setBusy(false);
    if (ok) setPhase('chat');
  };

  const submitDeal = async () => {
    setBusy(true);
    const ok = await act(
      () => post(`/api/items/${item.id}/requests`, { message: msg.trim() || undefined, negotiationId: negoId }),
      '申请已提交，等待卖家确认',
    );
    setBusy(false);
    if (ok) onClose();
  };

  const applyAtListPrice = async () => {
    setBusy(true);
    const ok = await act(() => post(`/api/items/${item.id}/requests`, {}), '申请已提交，等待卖家确认');
    setBusy(false);
    if (ok) onClose();
  };

  const retry = () => {
    setNegoId(null);
    setMsg('');
    setPhase('form');
  };

  return (
    <Modal
      title={
        <span>
          <XingBadge /> 让小星帮我谈
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={460}
      destroyOnHidden
    >
      {phase === 'form' ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            小星只知道你的心理价，不会告诉卖家；卖家的底价，小星也不会告诉你。谈成后由你决定是否按谈成价提交申请。
          </p>
          <div className="field">
            <div className="field-label">你最多愿意出多少？</div>
            <InputNumber
              min={1}
              max={item.price - 1}
              precision={0}
              style={{ width: 200 }}
              suffix="元"
              placeholder="整数"
              value={max}
              onChange={(x) => setMax(x ?? undefined)}
            />
            {max != null && max >= item.price && <div className="nego-warn">心理价不低于挂牌价，直接按原价申请即可</div>}
          </div>
          <div className="field">
            <div className="field-label">想让小星帮你说的话（选填）</div>
            <Input.TextArea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={60}
              showCount
              rows={2}
              placeholder="例如：下周搬家急用，希望这周内能交接"
            />
          </div>
          <div className="btn-row">
            <Button type="primary" loading={busy} onClick={start}>
              开始谈判
            </Button>
            <Button onClick={onClose}>算了</Button>
          </div>
        </>
      ) : (
        <>
          <div className="nego-status">
            {v === undefined || v.status === 'running' ? (
              <div className="notice" style={{ marginBottom: 10 }}>
                <XingBadge /> 买方小星和卖方小星正在谈判…
              </div>
            ) : dealt ? (
              <div className="notice green" style={{ marginBottom: 10 }}>
                <b>
                  小星谈成了：¥{dealPriceOf(v.agreedPrice, v.listPrice)}（原价 ¥{v.listPrice}，省 ¥{v.listPrice - dealPriceOf(v.agreedPrice, v.listPrice)!}）
                </b>
              </div>
            ) : v.status === 'no_deal' ? (
              <div className="notice orange" style={{ marginBottom: 10 }}>
                <b>这次没谈拢，差距有点大</b>
                <div className="muted">小星不会透露卖家的底价。你可以按原价申请，或换个心理价再谈一次。</div>
              </div>
            ) : v.status === 'ai_failed' ? (
              <div className="notice orange" style={{ marginBottom: 10 }}>
                <b>小星暂时不在，请直接申请</b>
              </div>
            ) : (
              <div className="notice gray" style={{ marginBottom: 10 }}>
                <b>{v.status === 'used' ? '已按谈成价提交申请' : '谈成的价格已过期，需要重新谈'}</b>
              </div>
            )}
          </div>
          <NegoBubbles turns={v?.turns ?? []} />
          {dealt && (
            <>
              <div className="field" style={{ marginTop: 12 }}>
                <div className="field-label">给卖家留句话（可修改）</div>
                <Input.TextArea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={200} rows={2} />
              </div>
              <div className="btn-row">
                <Button type="primary" loading={busy} onClick={submitDeal}>
                  按 ¥{dealPriceOf(v!.agreedPrice, v!.listPrice)} 提交申请
                </Button>
                <Button onClick={onClose}>算了</Button>
              </div>
            </>
          )}
          {v?.status === 'no_deal' && (
            <div className="btn-row">
              <Button type="primary" loading={busy} onClick={applyAtListPrice}>
                按原价申请
              </Button>
              {(v.remaining ?? 0) > 0 && (
                <Button onClick={retry}>换个价再谈（还剩 {v.remaining} 次）</Button>
              )}
            </div>
          )}
          {v?.status === 'ai_failed' && (
            <div className="btn-row">
              <Button type="primary" loading={busy} onClick={applyAtListPrice}>
                按原价申请
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function NegotiateButton({ item, prefillMax }: { item: BuyerDetail; prefillMax?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button block size="large" className="nego-entry" onClick={() => setOpen(true)}>
        <span className="xing-badge">✦ 小星</span> 让小星帮我谈
      </Button>
      <div className="hint">不好意思当面还价？让小星替你去谈，谈成后你再决定要不要申请。</div>
      <NegotiateModal item={item} prefillMax={prefillMax} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// ---- 问问小星（F12） ----

const QUICK_QUESTIONS = ['配件齐全吗', '有什么瑕疵', '适合什么场景'];

/**
 * 买家向小星提问商品细节：回答只给提问者本人看（原则 2），下方固定免责小字；
 * known=false 时可一键把问题写进申请留言（onWriteToRequest 由页面传入，仅在还能申请时提供）。
 */
function AskXingPanel({ item, onWriteToRequest }: { item: BuyerDetail; onWriteToRequest?: (question: string) => void }) {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);
  const exhausted = item.canAsk <= 0;

  const ask = async (raw: string) => {
    const question = raw.trim();
    if (!question || working || exhausted) return;
    setWorking(true);
    try {
      const r = await post<AskResponse>(`/api/items/${item.id}/ask`, { question });
      if (r.available) {
        setText('');
      } else {
        message.warning('小星暂时不在，请稍后再试');
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '提问失败，请稍后再试');
    } finally {
      setWorking(false);
      await qc.invalidateQueries({ queryKey: ['item'] });
    }
  };

  if (working)
    return (
      <XingPanel working>
        <div className="head">
          <XingBadge /> 小星正在回答…
        </div>
      </XingPanel>
    );

  return (
    <XingPanel>
      <div className="head">
        <XingBadge /> 对这件东西有疑问？问问小星
      </div>
      {item.myQuestions.map((q, i) => (
        <div className="ask-item" key={`${q.createdAt}-${i}`}>
          <div className="ask-q">问：{q.question}</div>
          <div className="ask-a">
            <XingBadge label="" />
            <span>{q.answer}</span>
          </div>
          <div className="ask-meta">
            <span className="ask-note">小星根据商品信息回答，不代表卖家承诺</span>
            {!q.known && onWriteToRequest && (
              <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => onWriteToRequest(q.question)}>
                把这个问题写进申请留言
              </Button>
            )}
          </div>
        </div>
      ))}
      <div className="ask-input">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={60}
          showCount
          disabled={exhausted}
          placeholder="问问这件东西的细节，小星只依据商品信息回答"
          onPressEnter={() => ask(text)}
        />
        <Button type="primary" disabled={exhausted || !text.trim()} onClick={() => ask(text)}>
          提问
        </Button>
      </div>
      <div className="ask-quick">
        {QUICK_QUESTIONS.map((q) => (
          <Button key={q} size="small" disabled={exhausted} onClick={() => ask(q)}>
            {q}
          </Button>
        ))}
      </div>
      {exhausted && <div className="ask-limit">每件商品最多问 5 次</div>}
    </XingPanel>
  );
}

/** 卖家视图「同事问过小星」：匿名列表，known=false 标橙并提示补充描述；无问题时整块不显示。 */
function SellerQuestions({ item }: { item: SellerDetail }) {
  const { aiEnabled } = useAuth();
  if (!aiEnabled || item.questions.length === 0) return null;
  return (
    <section className="section">
      <XingPanel>
        <div className="head">
          <XingBadge /> 同事问过小星（{item.questions.length}）
          <span className="muted">匿名显示</span>
        </div>
        {item.questions.map((q, i) => (
          <div className={`ask-item${q.known ? '' : ' ask-unknown'}`} key={`${q.createdAt}-${i}`}>
            <div className="ask-q">
              问：{q.question} <span className="muted">· {timeAgo(q.createdAt)}</span>
            </div>
            {!q.known && <div className="ask-tip">小星答不上来，补充到描述里，能减少同事来问</div>}
          </div>
        ))}
      </XingPanel>
    </section>
  );
}

function BuyerPanel({ item, prefillMax, applyPrefill }: { item: BuyerDetail; prefillMax?: number; applyPrefill?: { text: string; n: number } | null }) {
  const mine = item.myRequest;
  const confirm = useConfirm();
  const complete = useCompleteDeal();
  const { aiEnabled } = useAuth();
  const isVoucher = item.kind === 'voucher';
  const online = isVoucher && item.handoffMode === 'online';

  if (mine?.status === 'accepted') {
    const handed = item.status === 'handed_over';
    const agreed = dealPriceOf(mine.agreedPrice, item.price);
    return (
      <div className={`notice ${handed ? 'orange' : 'green'}`}>
        <b>
          {handed
            ? online
              ? '卖家已标记转赠，收到券后请确认'
              : '卖家已标记交付，请确认是否已收到物品'
            : online
              ? '卖家选择了你，请联系卖家完成转赠'
              : '卖家选择了你，请联系卖家约时间交接'}
        </b>
        <Contact label="卖家联系方式" value={mine.sellerContact} />
        {!online && (
          <div style={{ marginTop: 8 }}>
            交接地点：{item.handoffLocation}
            {item.handoffTime ? `，${item.handoffTime}` : ''}
          </div>
        )}
        {agreed != null && (
          <div style={{ marginTop: 8 }}>
            <span className="xing-chip">✦ 小星谈成 ¥{agreed}</span> <span className="muted">成交价 ¥{agreed}（挂牌价 ¥{item.price}）</span>
          </div>
        )}
        {handed && (
          <div className="btn-row">
            <Button
              type="primary"
              size="large"
              onClick={() =>
                confirm(
                  online ? '确认已收到券？' : '确认已收到物品？',
                  online ? '收到券后请确认，确认后交易完成，此操作不能撤销。' : '确认后交易完成，商品会从集市下架，此操作不能撤销。',
                  '确认收到',
                  () => complete(mine.id),
                )
              }
            >
              确认收到
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (item.status === 'published') {
    if (!mine || mine.status === 'withdrawn')
      return (
        <>
          <ApplyButton item={item} prefill={applyPrefill} />
          {/* F16：券类价格高度统一，不支持小星代谈 */}
          {aiEnabled && item.negotiation.canStart && !isVoucher && <NegotiateButton item={item} prefillMax={prefillMax} />}
        </>
      );
    if (mine.status === 'pending') {
      return (
        <div className="notice">
          <b>已申请，等待卖家确认</b>
          {mine.message && <div className="muted">你的留言：{mine.message}</div>}
          <div className="btn-row">
            <Button onClick={() => confirm('撤回申请？', '撤回后可以重新申请。', '撤回', () => post(`/api/requests/${mine.id}/withdraw`), '申请已撤回')}>撤回申请</Button>
          </div>
        </div>
      );
    }
    return (
      <div className="notice gray">
        <b>{REQUEST_STATUS[mine.status].label}</b>
        这件商品你不能再申请了，去看看其他物品吧。
      </div>
    );
  }

  const reasons: Record<string, string> = {
    locked: '卖家已选定交易对象，暂时不能申请。如果交易取消，商品会重新开放。',
    handed_over: '卖家已选定交易对象，暂时不能申请。',
    completed: '这件商品已经转让完成。',
    withdrawn: '卖家已下架这件商品。',
    hidden: '这件商品已被管理员隐藏。',
  };
  return <div className="notice gray">{reasons[item.status]}</div>;
}

function RequestRow({ r, canPick, listPrice, online }: { r: SellerRequest; canPick: boolean; listPrice: number; online: boolean }) {
  const st = REQUEST_STATUS[r.status];
  const handed = Boolean(r.handedOverAt);
  const confirm = useConfirm();
  const [showNego, setShowNego] = useState(false);
  const agreed = dealPriceOf(r.agreedPrice, listPrice);

  return (
    <div className="request-item">
      <span className="ava">{r.buyerName.slice(0, 1)}</span>
      <div className="body">
        <div>
          <span className="nm">{r.buyerName}</span>
          <span className="muted"> {r.buyerDepartment ?? ''} · {timeAgo(r.createdAt)}</span> <span className={`chip ${st.tone}`}>{st.label}</span>
          {r.status === 'closed' && r.closeReason && <span className="muted"> {CLOSE_REASON[r.closeReason] ?? ''}</span>}
        </div>
        {r.message && <div className="msg">「{r.message}」</div>}
        {r.negotiationId && agreed != null && (
          <div className="nego-tag-row">
            <span className="xing-chip">✦ 小星谈成 ¥{agreed}</span>
            <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={() => setShowNego((s) => !s)}>
              {showNego ? '收起谈判记录' : '谈判记录'}
            </Button>
          </div>
        )}
        {showNego && r.negotiationId && <NegoTranscript negotiationId={r.negotiationId} listPrice={listPrice} />}
        {r.status === 'accepted' && (
          <>
            <Contact label="买家联系方式" value={r.contact} />
            <div className="muted" style={{ marginTop: 4 }}>
              {handed ? `已于 ${formatDateTime(r.handedOverAt)} 标记交付，等待买家确认收到` : `选中于 ${formatDateTime(r.acceptedAt)}，请联系买家约时间交接`}
              {agreed != null && `。成交价 ¥${agreed}（挂牌价 ¥${listPrice}）`}
            </div>
          </>
        )}
      </div>
      <div className="acts">
        {r.status === 'pending' && canPick && (
          <>
            <Button onClick={() => confirm('拒绝这位申请人？', `拒绝后 ${r.buyerName} 将不能再申请这件商品。`, '拒绝', () => post(`/api/requests/${r.id}/reject`), '已拒绝')}>拒绝</Button>
            <Button
              type="primary"
              onClick={() =>
                confirm(
                  `选择 ${r.buyerName} 作为交易对象？`,
                  agreed != null
                    ? `${r.buyerName} 是通过小星代谈申请的，谈成价 ¥${agreed}（挂牌价 ¥${listPrice}），按谈成价线下交接。选定后商品进入交易中。`
                    : '选定后商品进入交易中，其他申请会被暂时关闭。交易取消后会自动恢复。',
                  '选定',
                  () => post(`/api/requests/${r.id}/accept`),
                  '已选定，双方可以看到彼此的联系方式',
                )
              }
            >
              选定
            </Button>
          </>
        )}
        {r.status === 'accepted' && !handed && (
          <>
            <Button onClick={() => confirm('取消这笔交易？', `商品会重新开放，其他申请人会回到待处理。`, '取消交易', () => post(`/api/requests/${r.id}/cancel`), '交易已取消，商品重新开放')}>取消交易</Button>
            {online ? (
              <Button type="primary" onClick={() => confirm('确认已把券转赠给买家？', '标记后由买家确认收到，交易才算完成。', '已转赠', () => post(`/api/requests/${r.id}/handover`), '已标记转赠')}>
                已转赠
              </Button>
            ) : (
              <Button type="primary" onClick={() => confirm('确认已把物品交给买家？', '标记后由买家确认收到，交易才算完成。', '已交付', () => post(`/api/requests/${r.id}/handover`), '已标记交付')}>
                已交付
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function WishMatchPanel({ item }: { item: SellerDetail }) {
  const { aiEnabled } = useAuth();
  const act = useAct();
  const panel = item.wishPanel;
  if (!aiEnabled || !panel) return null;
  const readOnly = item.status !== 'published';
  if (panel.matching) {
    return (
      <XingPanel working>
        <div className="head"><XingBadge /> 小星正在匹配心愿…</div>
      </XingPanel>
    );
  }
  if (panel.matches.length === 0) return null;
  return (
    <XingPanel>
      <div className="head">
        <XingBadge /> 小星发现 <b>{panel.matches.length}</b> 位同事在找类似物品
      </div>
      {panel.matches.map((m) => (
        <div className="wish-match-row" key={m.matchId}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <b>{m.userName}</b>
            <span className="muted"> {m.userDepartment ?? ''}</span>
            <div className="muted">「{m.content}」 · {m.budgetText}</div>
            <div className="ai-reason" style={{ display: 'inline-block', marginTop: 4 }}>{m.reason}</div>
          </div>
          {!readOnly &&
            (m.invited ? (
              <Button size="small" disabled>已邀请</Button>
            ) : (
              <Button size="small" onClick={() => act(() => post(`/api/wish-matches/${m.matchId}/invite`), '已邀请，对方会在心愿墙看到红点')}>
                邀请 TA 来看看
              </Button>
            ))}
        </div>
      ))}
      {readOnly && <div className="muted" style={{ marginTop: 6 }}>商品已不在发布中，不能再邀请。</div>}
    </XingPanel>
  );
}

function SellerPanel({ item }: { item: SellerDetail }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const canPick = item.status === 'published';
  const pending = item.requests.filter((r) => r.status === 'pending').length;

  return (
    <>
      <WishMatchPanel item={item} />
      <div className={`notice ${canPick ? '' : 'orange'}`}>
        <b>这是你发布的商品</b>
        {canPick ? (pending > 0 ? `有 ${pending} 位同事在等你确认。` : '还没有人申请。') : `当前状态：${ITEM_STATUS[item.status].label}。`}
      </div>
      {canPick && (
        <div className="btn-row">
          <Button onClick={() => navigate(`/items/${item.id}/edit`)}>编辑</Button>
          <Button
            danger
            onClick={() =>
              confirm('下架这件商品？', '下架后待处理的申请会被关闭，且不能恢复，需要重新发布。', '下架', () => post(`/api/items/${item.id}/withdraw`), '商品已下架', true)
            }
          >
            下架
          </Button>
        </div>
      )}
    </>
  );
}

export function ItemDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { aiEnabled } = useAuth();
  // F12：问问小星 known=false 时「把这个问题写进申请留言」→ 预填并打开申请弹窗（n 递增保证重复点击也触发）
  const [applyPrefill, setApplyPrefill] = useState<{ text: string; n: number } | null>(null);
  // F9：从心愿墙匹配卡片进入时预填心理价 min(预算, 挂牌价 − 1)
  const budget = Number(params.get('budget'));
  const prefillMax = params.get('from') === 'wish_match' && Number.isFinite(budget) && budget > 0 ? budget : undefined;
  const q = useQuery({
    queryKey: ['item', id],
    queryFn: () => api<Detail>(`/api/items/${id}`),
    // 卖家视图匹配中时每 3 秒轮询，匹配完成（wish_matched_at 写入）后停止
    refetchInterval: (query) => {
      const d = query.state.data as Detail | undefined;
      return d && d.viewer === 'seller' && d.wishPanel.matching ? 3000 : false;
    },
  });

  if (q.isLoading) return <div className="empty"><Spin /></div>;
  if (q.isError)
    return (
      <div className="empty">
        <b>{q.error.message}</b>
        <Link to="/"><Button type="primary">回到首页</Button></Link>
      </div>
    );
  const item = q.data!;
  const st = ITEM_STATUS[item.status];
  const isVoucher = item.kind === 'voucher';
  const online = isVoucher && item.handoffMode === 'online';
  const expiry = isVoucher ? expiryView(item.expiresOn) : null;
  // F16：locked/handed_over 的券已到期或今天到期时不自动下架，红字催促尽快完成转赠
  const dueInProgress = isVoucher && (item.status === 'locked' || item.status === 'handed_over') && voucherDue(item.expiresOn);

  return (
    <>
      <div className="breadcrumb">
        <Link to="/">首页</Link>
        <span className="sep">&gt;</span>商品详情
      </div>
      {dueInProgress && <div className="notice red" style={{ marginBottom: 12 }}><b>券已到期或今天到期，请尽快完成转赠</b></div>}
      <div className="detail-top">
        <Gallery images={item.images} title={item.title} voucher={isVoucher} />
        <div>
          <h1 className="info-title">{item.title}</h1>
          <div className={`info-price price${item.tradeType === 'free' ? ' free' : ''}`}>
            {item.tradeType === 'free' ? '免费赠送' : <><small>¥</small>{item.price}</>}
          </div>
          {item.originalPrice != null &&
            (isVoucher ? (
              <div className="orig-line">{faceValueText(item.originalPrice, item.tradeType, item.price)}</div>
            ) : (
              <div className="orig-line">
                {item.tradeType === 'free' ? `全新约 ¥${item.originalPrice} · 免费领` : item.originalPrice > item.price ? `全新约 ¥${item.originalPrice} · 为同事省 ¥${item.originalPrice - item.price}` : `全新约 ¥${item.originalPrice}`}
              </div>
            ))}
          {item.group && (
            <div className="orig-line">
              共 {item.group.total} 张，剩 {item.group.remaining} 张
            </div>
          )}
          <div className="tags">
            <span className={`chip ${item.tradeType === 'free' ? 'green' : ''}`}>{item.tradeType === 'free' ? '免费赠送' : '一口价'}</span>
            {!isVoucher && <span className="chip">{CONDITION_LABEL[item.condition]}</span>}
            <span className="chip">{item.categoryName}</span>
            {isVoucher && (
              <span className={`chip ${expiry?.tone === 'red' ? 'orange' : ''}`}>有效期：{expiry ? expiry.label : '长期有效'}</span>
            )}
            {isVoucher && <span className="chip">{online ? '线上转赠' : '线下当面'}</span>}
            <span className={`chip ${st.tone}`}>{st.label}</span>
          </div>
          <div className="seller-row">
            <span className="ava lg">{item.sellerName.slice(0, 1)}</span>
            <div>
              <div className="nm">{item.sellerName}</div>
              <div className="sub">
                {item.sellerDepartment ? `${item.sellerDepartment} · ` : ''}发布于 {timeAgo(item.publishedAt)}
              </div>
            </div>
          </div>
          <div className="action-box">{item.viewer === 'seller' ? <SellerPanel item={item} /> : <BuyerPanel item={item} prefillMax={prefillMax} applyPrefill={applyPrefill} />}</div>
        </div>
      </div>

      {item.description && (
        <section className="section">
          <h2 className="section-title"><i />商品描述</h2>
          <p className="desc">{item.description}</p>
        </section>
      )}

      {/* F12 问问小星：买家视图、仅发布中显示；aiEnabled=false 整块隐藏（降级原则） */}
      {item.viewer === 'buyer' && aiEnabled && item.status === 'published' && (
        <section className="section">
          <AskXingPanel
            item={item}
            onWriteToRequest={
              !item.myRequest || item.myRequest.status === 'withdrawn'
                ? (question) => setApplyPrefill((p) => ({ text: question, n: (p?.n ?? 0) + 1 }))
                : undefined
            }
          />
        </section>
      )}

      {/* F12 同事问过小星：卖家视图，匿名 */}
      {item.viewer === 'seller' && <SellerQuestions item={item} />}

      {isVoucher && (
        <div className="notice orange" style={{ marginTop: 16 }}>
          券和会员权益能否转让，以发放方的规则为准。平台不做担保，请双方确认后再交易。
        </div>
      )}

      <section className="section">
        <h2 className="section-title"><i />交接信息</h2>
        <dl className="kv">
          {isVoucher && (
            <>
              <dt>交接方式</dt>
              <dd>{online ? '线上转赠（双方线上完成券的转赠）' : '线下当面'}</dd>
            </>
          )}
          {isVoucher && (
            <>
              <dt>有效期</dt>
              <dd className={expiry?.tone === 'red' ? 'expiry-red' : ''}>{expiry ? `${expiry.label}（${item.expiresOn}）` : '长期有效'}</dd>
            </>
          )}
          {!online && (
            <>
              <dt>交接地点</dt>
              <dd>{item.handoffLocation}</dd>
            </>
          )}
          <dt>可交接时间</dt>
          <dd>{item.handoffTime || '双方协商'}</dd>
          <dt>交易方式</dt>
          <dd>
            平台不收款、不配送，{online ? '券通过线上转赠完成' : '双方线下当面交接'}
            {item.tradeType === 'fixed' ? '并自行付款' : ''}
          </dd>
        </dl>
      </section>

      {item.viewer === 'seller' && (
        <section className="section">
          <h2 className="section-title"><i />申请人（{item.requests.length}）</h2>
          {item.requests.length === 0 ? (
            <div className="muted" style={{ marginLeft: 31 }}>还没有人申请。</div>
          ) : (
            item.requests.map((r) => (
              <RequestRow key={r.id} r={r} canPick={item.status === 'published'} listPrice={item.price} online={item.kind === 'voucher' && item.handoffMode === 'online'} />
            ))
          )}
        </section>
      )}

      <div className="tips">
        <div>
          <b>温馨提示</b>
          请遵守公司闲置交易规范，文明交易，友好沟通。不要交易公司资产、违禁品和含个人信息的物品。
        </div>
        <PlantArt />
      </div>
    </>
  );
}

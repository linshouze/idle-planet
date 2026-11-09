/**
 * F1 清仓模式：多图一键批量发布。
 * 拖入照片（一次最多 10 张）→ 每张上传成功后立即调 /api/ai/draft 纯图识别（并发上限 3）→
 * 生成可编辑草稿卡片网格 → 「全部发布」走 POST /api/items/batch（非原子，逐件结果）。
 * 风控 warn 的卡片发布前必须逐张确认（复用单件发布的「小星注意到」交互）；
 * AI 未启用时不自动识别，卡片留白手填，其余流程照常。
 */
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp, Button, Checkbox, Input, InputNumber, Modal, Radio, Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AiDraft, AiDraftResponse, BatchItemResult, Category, Condition, Risk, TradeType } from '../api/types';
import { useAuth } from '../auth';
import { CONDITION_LABEL, RISK_TYPE_LABEL, compressImage } from '../format';
import { XingBadge, XingPanel } from '../components/Xing';
import { PublishModeSwitch } from './Publish';

interface Img {
  id: number;
  url: string;
}

type CardPhase = 'uploading' | 'recognizing' | 'ready';

interface BatchCard {
  key: number;
  phase: CardPhase;
  images: Img[];
  title: string;
  categoryId?: number;
  condition?: Condition;
  tradeType: TradeType;
  price?: number | null;
  originalPrice?: number | null;
  description: string;
  suggestion: AiDraft['priceSuggestion'];
  /** 小星拿不准的字段（白名单内、卡片上存在的），标黄提示核对。 */
  uncertain: string[];
  risk: Risk | null;
  riskCheckId: number | null;
  riskAcked: boolean;
  /** 识别失败：「小星暂时不在，请手动填写」。 */
  xingFailed: boolean;
  /** 点「全部发布」时缺必填 → 标红留在页面。 */
  invalid: boolean;
  /** 发布失败原因（留在页面，可重试）。 */
  publishError: string | null;
}

const MAX_CARDS = 10; // 一次最多 10 张（一张照片对应一件商品）
const MAX_CARD_IMAGES = 5; // 每张卡片照片总数上限
const DRAFT_CONCURRENCY = 3; // 小星识别并发上限
/** draft uncertain 白名单里会出现在卡片上的字段（expiresOn/quantity 属于券类，清仓卡片不涉及）。 */
const CARD_UNCERTAIN = ['title', 'categoryId', 'condition', 'price', 'newPriceEstimate'];

/** 并发池：最多 limit 个任务同时跑，跑完一个补一个。 */
async function runPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const t = tasks[next++];
      if (t) await t();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
}

/** 卡片缺的必填项（null = 就绪），口径与服务端 itemInputSchema 一致。 */
function missingField(c: BatchCard): string | null {
  if (c.images.length === 0) return '至少一张照片';
  if (!c.title.trim()) return '标题';
  if (!c.categoryId) return '分类';
  if (!c.condition) return '成色';
  if (c.tradeType === 'fixed' && !(c.price != null && c.price >= 1)) return '价格';
  return null;
}

/** 卡片内追加照片（首图即识别图，总数 ≤5），走与单件发布相同的压缩上传链路。 */
function CardImages({ card, onPatch }: { card: BatchCard; onPatch: (p: Partial<BatchCard>) => void }) {
  const { message } = AntApp.useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const room = MAX_CARD_IMAGES - card.images.length;
    if (room <= 0) {
      message.warning(`每张卡片最多 ${MAX_CARD_IMAGES} 张照片`);
      return;
    }
    if (list.length > room) message.warning(`最多再传 ${room} 张，已忽略多余的 ${list.length - room} 张`);
    setBusy(true);
    try {
      const next = [...card.images];
      for (const f of list.slice(0, room)) {
        const small = await compressImage(f);
        const form = new FormData();
        form.set('file', small);
        next.push(await api<Img>('/api/uploads', { method: 'POST', form }));
      }
      onPatch({ images: next });
    } catch (e) {
      message.error(e instanceof Error ? e.message : '追加照片失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="batch-thumbs">
      {card.images.map((im, i) => (
        <div key={im.id} className="row-thumb">
          <img src={im.url} alt={`第 ${i + 1} 张照片`} />
          {i === 0 && <span className="corner fixed" style={{ left: 4, top: 4, padding: '0 6px', fontSize: 11 }}>封面</span>}
          <Button
            size="small"
            shape="circle"
            aria-label={`删除第 ${i + 1} 张照片`}
            style={{ position: 'absolute', right: 2, top: 2, width: 22, height: 22, minWidth: 22 }}
            onClick={() => onPatch({ images: card.images.filter((x) => x.id !== im.id) })}
          >
            ×
          </Button>
        </div>
      ))}
      {card.images.length < MAX_CARD_IMAGES && (
        <button type="button" className="batch-add-img" disabled={busy} aria-label="追加照片" onClick={() => input.current?.click()}>
          {busy ? '…' : '＋'}
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void add(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/** warn 卡片未逐张确认被跳过时留在页面上的原因（不提供重试按钮，走「全部发布」重新确认）。 */
const SKIP_REASON = '未确认小星提醒，本次未发布';

/** 识别完成的草稿卡片：全部字段可编辑，uncertain 标黄，warn 带风控角标，可删除、可重试发布。 */
function BatchCardView({ card, categories, onPatch, onRemove, onRetry, retrying }: {
  card: BatchCard;
  categories: Category[];
  onPatch: (p: Partial<BatchCard>) => void;
  onRemove: () => void;
  onRetry: () => void;
  retrying: boolean;
}) {
  const cls = (field: string): string => (card.uncertain.includes(field) ? 'batch-field uncertain' : 'batch-field');
  const missing = missingField(card);
  return (
    <div className={`batch-card${card.invalid ? ' invalid' : ''}`}>
      <Button size="small" type="text" danger className="batch-card-del" onClick={onRemove}>删除</Button>
      <CardImages card={card} onPatch={onPatch} />
      {card.xingFailed && <div className="ai-missing">✦ 小星暂时不在，请手动填写</div>}
      {card.risk?.level === 'warn' && (
        <div className="batch-risk">
          <XingBadge label={`小星注意到 · ${RISK_TYPE_LABEL[card.risk.type]}`} />
          <span>{card.risk.reason}{card.riskAcked ? '（已确认是个人物品）' : ''}</span>
        </div>
      )}
      <div className={cls('title')}>
        <span>标题</span>
        <Input value={card.title} maxLength={60} placeholder="品牌 + 型号 + 关键特征" onChange={(e) => onPatch({ title: e.target.value })} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className={cls('categoryId')}>
          <span>分类</span>
          <Select
            value={card.categoryId}
            placeholder="选择分类"
            style={{ width: '100%' }}
            options={categories.map((x) => ({ value: x.id, label: x.name }))}
            onChange={(v) => onPatch({ categoryId: v })}
          />
        </div>
        <div className={cls('condition')}>
          <span>成色</span>
          <Select
            value={card.condition}
            placeholder="选择成色"
            style={{ width: '100%' }}
            options={Object.entries(CONDITION_LABEL).map(([value, label]) => ({ value, label }))}
            onChange={(v) => onPatch({ condition: v as Condition })}
          />
        </div>
      </div>
      <div className="batch-field">
        <span>交易方式（默认取批次设置，可单独改）</span>
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          size="small"
          value={card.tradeType}
          options={[
            { value: 'fixed', label: '一口价转让' },
            { value: 'free', label: '免费赠送' },
          ]}
          onChange={(e) => onPatch({ tradeType: e.target.value as TradeType, price: e.target.value === 'free' ? undefined : card.price })}
        />
      </div>
      {card.tradeType === 'fixed' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className={cls('price')}>
            <span>价格</span>
            <InputNumber value={card.price} min={1} max={1000000} precision={0} suffix="元" style={{ width: '100%' }} placeholder="整数" onChange={(v) => onPatch({ price: v })} />
          </div>
          <div className={cls('newPriceEstimate')}>
            <span>全新参考价</span>
            <InputNumber value={card.originalPrice} min={1} max={1000000} precision={0} suffix="元" style={{ width: '100%' }} placeholder="选填" onChange={(v) => onPatch({ originalPrice: v })} />
          </div>
        </div>
      )}
      {card.tradeType === 'fixed' && card.suggestion?.min && card.suggestion?.max ? (
        <div className="ai-price" style={{ marginTop: -4, fontSize: 12.5 }}>
          ✦ 小星参考价 <b>¥{card.suggestion.min}-{card.suggestion.max}</b>
          {card.suggestion.reason ? <span className="muted">（{card.suggestion.reason}）</span> : null}，仅供参考
          <Button size="small" type="link" onClick={() => onPatch({ price: Math.round((card.suggestion!.min! + card.suggestion!.max!) / 2) })}>
            采用中间价
          </Button>
        </div>
      ) : null}
      <div className="batch-field">
        <span>描述（选填）</span>
        <Input.TextArea value={card.description} rows={2} maxLength={2000} placeholder="使用时长、瑕疵、配件是否齐全等" onChange={(e) => onPatch({ description: e.target.value })} />
      </div>
      {card.uncertain.length > 0 && <div className="batch-unc-hint">✦ 标黄的字段小星拿不准，发布前请核对一下</div>}
      {card.invalid && missing && <div className="batch-invalid-note">还差必填项：{missing}，补齐后才能发布</div>}
      {card.publishError && (
        <div className="notice red" style={{ padding: '8px 12px', fontSize: 13 }}>
          {card.publishError}
          {card.publishError !== SKIP_REASON && (
            <Button size="small" style={{ marginLeft: 10 }} loading={retrying} onClick={onRetry}>重试</Button>
          )}
        </div>
      )}
    </div>
  );
}

export function PublishBatch() {
  const { user, aiEnabled } = useAuth();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [common, setCommon] = useState({ location: '', time: '', tradeType: 'fixed' as TradeType });
  const [cards, setCards] = useState<BatchCard[]>([]);
  const [summaryCount, setSummaryCount] = useState(0);
  const [publishing, setPublishing] = useState(false);
  const [retryKey, setRetryKey] = useState<number | null>(null);
  // 「小星注意到」逐张确认队列（F2）：warn 的卡发布前必须逐张过弹窗
  const [ackQueue, setAckQueue] = useState<number[]>([]);
  const [ackIndex, setAckIndex] = useState(0);
  const [ackChecked, setAckChecked] = useState(false);
  const [over, setOver] = useState(false);
  const keySeq = useRef(0);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const flowKeys = useRef<number[]>([]); // 本次发布流程的候选卡片（过了必填校验的）
  const ackedNow = useRef(new Set<number>()); // 弹窗流程里刚确认、state 还没刷新的 key
  const fileInput = useRef<HTMLInputElement>(null);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/api/categories') });

  const patch = (key: number, p: Partial<BatchCard>) => setCards((cs) => cs.map((c) => (c.key === key ? { ...c, ...p } : c)));

  const blankCard = (tradeType: TradeType): BatchCard => ({
    key: ++keySeq.current,
    phase: 'uploading',
    images: [],
    title: '',
    categoryId: undefined,
    condition: undefined,
    tradeType,
    price: undefined,
    originalPrice: null,
    description: '',
    suggestion: null,
    uncertain: [],
    risk: null,
    riskCheckId: null,
    riskAcked: false,
    xingFailed: false,
    invalid: false,
    publishError: null,
  });

  /** 识别结果填进卡片：一口价时预填价格（小星转述价 > 参考区间中间价），uncertain 只留卡片上有的字段。 */
  const applyDraft = (key: number, d: AiDraft, riskCheckId: number | null) => {
    setCards((cs) =>
      cs.map((c) => {
        if (c.key !== key) return c;
        const suggestion = d.priceSuggestion ?? null;
        let price = c.price;
        if (c.tradeType === 'fixed' && price == null) {
          if (typeof d.price === 'number' && d.price >= 1) price = d.price;
          else if (suggestion?.min && suggestion?.max) price = Math.round((suggestion.min + suggestion.max) / 2);
        }
        return {
          ...c,
          phase: 'ready' as const,
          title: d.title?.trim() || c.title,
          categoryId: d.categoryId ?? c.categoryId,
          condition: (d.condition as Condition | undefined) ?? c.condition,
          description: d.description?.trim() || c.description,
          originalPrice: typeof d.newPriceEstimate === 'number' ? d.newPriceEstimate : c.originalPrice,
          price,
          suggestion,
          uncertain: (d.uncertain ?? []).filter((f) => CARD_UNCERTAIN.includes(f)),
          risk: d.risk ?? null,
          riskCheckId,
        };
      }),
    );
  };

  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) return;
    const room = MAX_CARDS - cardsRef.current.length;
    if (room <= 0) {
      message.warning(`一次最多 ${MAX_CARDS} 张，请先发布或删掉一些卡片`);
      return;
    }
    if (list.length > room) message.warning(`一次最多 ${MAX_CARDS} 张，已忽略多余的 ${list.length - room} 张`);
    const accepted = list.slice(0, room);
    const created = accepted.map(() => blankCard(common.tradeType));
    setCards((cs) => [...cs, ...created]);
    // 上传 + 小星识别共用一个并发池（上限 3）：识别完一张填一张，单张失败不影响其他卡片
    await runPool(
      accepted.map((f, i) => async () => {
        const card = created[i];
        let img: Img;
        try {
          const small = await compressImage(f);
          const form = new FormData();
          form.set('file', small);
          img = await api<Img>('/api/uploads', { method: 'POST', form });
        } catch (e) {
          setCards((cs) => cs.filter((c) => c.key !== card.key));
          message.error(`${f.name}：${e instanceof Error ? e.message : '上传失败'}`);
          return;
        }
        patch(card.key, { images: [img], phase: 'recognizing' });
        if (!aiEnabled) {
          patch(card.key, { phase: 'ready' }); // AI 未启用：不自动识别，卡片留白手填
          return;
        }
        try {
          const r = await api<AiDraftResponse>('/api/ai/draft', { method: 'POST', json: { imageId: img.id } });
          if (r.available && r.draft) applyDraft(card.key, r.draft, r.riskCheckId ?? null);
          else patch(card.key, { phase: 'ready', xingFailed: true });
        } catch {
          patch(card.key, { phase: 'ready', xingFailed: true }); // 小星暂时不在：该卡手动填写
        }
      }),
      DRAFT_CONCURRENCY,
    );
  };

  const buildItem = (c: BatchCard, ackedSet: Set<number>) => ({
    title: c.title.trim(),
    categoryId: c.categoryId,
    description: c.description.trim(),
    condition: c.condition,
    tradeType: c.tradeType,
    price: c.tradeType === 'free' ? 0 : c.price ?? 0,
    originalPrice: c.originalPrice ?? null,
    negotiationFloor: null,
    kind: 'goods' as const, // 清仓卡片按实物处理；券·权益请走单件发布，或发布后在编辑页修改
    handoffMode: 'offline' as const,
    imageIds: c.images.map((im) => im.id),
    ...(c.riskCheckId ? { riskCheckId: c.riskCheckId } : {}),
    ...(c.risk?.level === 'warn' && (c.riskAcked || ackedSet.has(c.key)) ? { riskAck: true } : {}),
  });

  /** 调 batch 接口发布指定卡片；逐件结果回填（成功的离开页面，失败的留页显示原因可重试）。 */
  const doPublish = async (keys: number[], ackedSet: Set<number>) => {
    const current = cardsRef.current;
    // warn 且没完成逐张确认的卡跳过不发布，留在页面
    const targets = keys
      .map((k) => current.find((c) => c.key === k))
      .filter((c): c is BatchCard => c !== undefined && !(c.risk?.level === 'warn' && !c.riskAcked && !ackedSet.has(c.key)));
    keys.forEach((k) => {
      if (!targets.some((t) => t.key === k)) patch(k, { publishError: SKIP_REASON });
    });
    if (targets.length === 0) return;
    setPublishing(true);
    try {
      const results = await api<BatchItemResult[]>('/api/items/batch', {
        method: 'POST',
        json: {
          common: {
            handoffLocation: common.location.trim(),
            ...(common.time.trim() ? { handoffTime: common.time.trim() } : {}),
          },
          items: targets.map((c) => buildItem(c, ackedSet)),
        },
      });
      const okKeys = new Set<number>();
      const fails = new Map<number, string>();
      targets.forEach((c, i) => {
        const r = results[i];
        if (!r) return;
        if (r.ok) okKeys.add(c.key);
        else fails.set(c.key, r.error?.message || '发布失败，请重试');
      });
      setCards((cs) =>
        cs.map((c) => (fails.has(c.key) ? { ...c, publishError: fails.get(c.key)!, invalid: false } : c)).filter((c) => !okKeys.has(c.key)),
      );
      if (okKeys.size > 0) setSummaryCount((n) => n + okKeys.size);
      if (fails.size > 0) message.warning(`${fails.size} 件没有发布成功，原因已标在卡片上，可以重试`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '发布失败，请重试';
      setCards((cs) => cs.map((c) => (keys.includes(c.key) ? { ...c, publishError: msg } : c)));
      message.error(msg);
    } finally {
      setPublishing(false);
    }
  };

  const publishAll = () => {
    if (!common.location.trim()) {
      message.warning('请先填写批次交接地点');
      return;
    }
    const current = cardsRef.current;
    if (current.length === 0) {
      message.warning('先把照片拖进来，让小星逐张识别成草稿');
      return;
    }
    if (current.some((c) => c.phase !== 'ready')) {
      message.warning('还有照片在识别中，等小星填完再发布');
      return;
    }
    // 缺必填的卡标红不发布，其余照常
    setCards((cs) => cs.map((c) => ({ ...c, invalid: missingField(c) !== null, publishError: null })));
    const eligible = current.filter((c) => missingField(c) === null);
    if (eligible.length === 0) {
      message.warning('没有可发布的卡片：请先补齐标红的必填项');
      return;
    }
    flowKeys.current = eligible.map((c) => c.key);
    ackedNow.current = new Set();
    const needAck = eligible.filter((c) => c.risk?.level === 'warn' && !c.riskAcked);
    if (needAck.length > 0) {
      // 有风控预警的卡片必须逐张完成确认，否则跳过不发布
      setAckQueue(needAck.map((c) => c.key));
      setAckIndex(0);
      setAckChecked(false);
      return;
    }
    void doPublish(flowKeys.current, ackedNow.current);
  };

  const ackCard = ackIndex < ackQueue.length ? cards.find((c) => c.key === ackQueue[ackIndex]) ?? null : null;
  const ackReason = ackCard && ackCard.risk && ackCard.risk.level === 'warn' ? ackCard.risk.reason : '';

  /** 确认弹窗过完一张：确认 → 标记 acked；跳过 → 该卡不发布。队列走完开始发布。 */
  const advanceAck = (acked: boolean) => {
    const key = ackQueue[ackIndex];
    if (key !== undefined && acked) {
      patch(key, { riskAcked: true, publishError: null });
      ackedNow.current.add(key);
    }
    setAckChecked(false);
    const next = ackIndex + 1;
    if (next < ackQueue.length) {
      setAckIndex(next);
      return;
    }
    setAckQueue([]);
    setAckIndex(0);
    void doPublish(flowKeys.current, ackedNow.current);
  };

  const readyCount = cards.filter((c) => c.phase === 'ready' && missingField(c) === null).length;
  const recognizing = cards.filter((c) => c.phase !== 'ready').length;

  return (
    <>
      <h1 className="page-title">批量发布（清仓模式）</h1>
      <PublishModeSwitch mode="batch" />
      {!user.contact && (
        <div className="notice orange" style={{ marginBottom: 18 }}>
          <b>还没有填写联系方式</b>
          发布前请先点右上角头像，填写联系方式。卖家选定交易对象后，双方才能看到彼此的联系方式。
        </div>
      )}

      <div className="notice" style={{ marginBottom: 16 }}>
        <b>批次共用信息（只填一次）</b>
        <div className="batch-common">
          <div className="batch-field">
            <span>交接地点（必填）</span>
            <Input value={common.location} maxLength={100} placeholder="例如：一楼大厅、3 楼前台" onChange={(e) => setCommon({ ...common, location: e.target.value })} />
          </div>
          <div className="batch-field">
            <span>可交接时间（选填）</span>
            <Input value={common.time} maxLength={100} placeholder="例如：工作日 12:00-13:00" onChange={(e) => setCommon({ ...common, time: e.target.value })} />
          </div>
          <div className="batch-field">
            <span>默认交易方式</span>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              value={common.tradeType}
              options={[
                { value: 'fixed', label: '一口价转让' },
                { value: 'free', label: '免费赠送' },
              ]}
              onChange={(e) => setCommon({ ...common, tradeType: e.target.value as TradeType })}
            />
          </div>
        </div>
      </div>

      <div
        className={`batch-drop${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        <b>✦ 把照片拖进来，小星逐张识别成草稿</b>
        <div className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>
          一张照片对应一件商品，一次最多 {MAX_CARDS} 张
          {aiEnabled ? '；识别完一张填好一张，拿不准的字段会标黄请你核对' : '；当前 AI 未启用，卡片内容请手动填写'}
          。上传前请遮挡快递面单、身份证号等隐私信息。
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {summaryCount > 0 && (
        <div className="notice green" style={{ margin: '16px 0' }}>
          <b>✦ 已发布 {summaryCount} 件{aiEnabled ? '，小星正在为它们匹配心愿' : ''}</b>
          <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
            <Button type="primary" onClick={() => navigate('/my/items')}>查看我的发布</Button>
            <Button onClick={() => navigate('/')}>去集市看看</Button>
          </div>
        </div>
      )}

      {cards.length > 0 && (
        <div className="batch-grid">
          {cards.map((c) => {
            if (c.phase === 'uploading')
              return (
                <div className="skel-card" key={c.key}>
                  <div className="cover" />
                  <div className="b">
                    <div className="xing-skel w85" />
                    <div className="xing-skel w60" />
                    <div className="muted" style={{ fontSize: 12 }}>正在上传照片…</div>
                  </div>
                </div>
              );
            if (c.phase === 'recognizing')
              return (
                <div className="batch-card" key={c.key}>
                  <div className="batch-thumbs">
                    {c.images.map((im) => (
                      <div key={im.id} className="row-thumb">
                        <img src={im.url} alt="识别中的照片" />
                      </div>
                    ))}
                  </div>
                  <XingPanel working>
                    <div className="muted" style={{ fontSize: 13 }}>✦ 小星正在识别…</div>
                  </XingPanel>
                </div>
              );
            return (
              <BatchCardView
                key={c.key}
                card={c}
                categories={categories.data?.categories ?? []}
                onPatch={(p) => patch(c.key, p)}
                onRemove={() => setCards((cs) => cs.filter((x) => x.key !== c.key))}
                onRetry={() => {
                  setRetryKey(c.key);
                  void doPublish([c.key], ackedNow.current).finally(() => setRetryKey(null));
                }}
                retrying={retryKey === c.key && publishing}
              />
            );
          })}
        </div>
      )}

      <div className="btn-row" style={{ alignItems: 'center' }}>
        <Button type="primary" size="large" loading={publishing} disabled={cards.length === 0} onClick={publishAll}>
          全部发布{readyCount > 0 ? `（${readyCount} 件就绪）` : ''}
        </Button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {recognizing > 0 ? `✦ 小星还在识别 ${recognizing} 张…` : '缺必填项的卡片会标红留在页面；有小星提醒的卡片发布前需逐张确认'}
        </span>
      </div>

      <Modal
        title={<XingBadge label="小星注意到" />}
        open={ackCard !== null}
        maskClosable={false}
        footer={[
          <Button key="skip" onClick={() => advanceAck(false)}>跳过这张（不发布）</Button>,
          <Button key="ok" type="primary" disabled={!ackChecked} onClick={() => advanceAck(true)}>确认这是个人物品，继续</Button>,
        ]}
        onCancel={() => advanceAck(false)}
      >
        <p style={{ marginTop: 0 }}>
          小星在「{ackCard?.title?.trim() || '这张卡片'}」上注意到：<b>{ackReason}</b>
        </p>
        <p className="muted">
          公司资产不得私自转让。如确为个人物品可以继续发布，管理员会复核。
          {ackQueue.length > 1 && `（需逐张确认：第 ${ackIndex + 1} / ${ackQueue.length} 张）`}
        </p>
        <Checkbox checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)}>我确认这是个人物品，可以转让</Checkbox>
      </Modal>
    </>
  );
}

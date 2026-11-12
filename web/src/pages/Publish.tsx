import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { App as AntApp, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Spin, Switch, type FormInstance } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { api, patch, post } from '../api/client';
import type { AiDraft, AiDraftResponse, Category, ItemDetail, Risk, RiskCheckResponse } from '../api/types';
import { useAct, useAuth } from '../auth';
import { CONDITION_LABEL, beijingToday, compressImage } from '../format';
import { XingAvatar, XingBadge, XingPanel } from '../components/Xing';

interface Img {
  id: number;
  url: string;
}

/** 发布时回传给服务端的风控字段（F2）。 */
interface RiskMeta {
  riskCheckId?: number;
  riskAck?: boolean;
}

interface FormValues {
  kind: 'goods' | 'voucher';
  title: string;
  categoryId: number;
  condition: string;
  tradeType: 'fixed' | 'free';
  price?: number;
  originalPrice?: number | null;
  negotiationFloor?: number | null;
  negoEnabled?: boolean;
  description?: string;
  handoffMode: 'offline' | 'online';
  handoffLocation: string;
  handoffTime?: string;
  expiresOnDay?: Dayjs | null;
  expiresForever?: boolean;
  quantity?: number;
}

const MAX_IMAGES = 5;

/** F1：发布方式切换（单件 / 清仓模式），两个发布页顶部互跳。 */
export function PublishModeSwitch({ mode }: { mode: 'single' | 'batch' }) {
  return (
    <nav className="publish-switch" aria-label="发布方式切换">
      <NavLink to="/publish" end className={mode === 'single' ? 'active' : ''}>单件发布</NavLink>
      <NavLink to="/publish/batch" className={mode === 'batch' ? 'active' : ''}>批量发布</NavLink>
    </nav>
  );
}

function ImagePicker({ value, onChange }: { value: Img[]; onChange: (v: Img[]) => void }) {
  const { message } = AntApp.useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [over, setOver] = useState(false);

  const add = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const room = MAX_IMAGES - value.length;
    if (list.length > room) message.warning(`最多上传 ${MAX_IMAGES} 张图片，已忽略多余的 ${list.length - room} 张`);
    let next = value;
    for (const f of list.slice(0, Math.max(room, 0))) {
      setBusy((n) => n + 1);
      try {
        const small = await compressImage(f);
        const form = new FormData();
        form.set('file', small);
        const saved = await api<Img>('/api/uploads', { method: 'POST', form });
        next = [...next, saved];
        onChange(next);
      } catch (e) {
        message.error(`${f.name}：${e instanceof Error ? e.message : '上传失败'}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {value.map((im, i) => (
          <div key={im.id} className="row-thumb" style={{ width: 104, height: 104, position: 'relative' }}>
            <img src={im.url} alt={`商品图片 ${i + 1}`} />
            {i === 0 && <span className="corner fixed" style={{ left: 6, top: 6, padding: '1px 8px' }}>封面</span>}
            <Button
              size="small"
              shape="circle"
              aria-label={`删除第 ${i + 1} 张图片`}
              style={{ position: 'absolute', right: 4, top: 4 }}
              onClick={() => onChange(value.filter((x) => x.id !== im.id))}
            >
              ×
            </Button>
          </div>
        ))}
        {value.length < MAX_IMAGES && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void add(e.dataTransfer.files);
            }}
            style={{
              width: 104,
              height: 104,
              borderRadius: 10,
              border: `1.5px dashed ${over ? 'var(--pri)' : '#c6cedf'}`,
              background: over ? 'var(--blue-soft)' : '#f8faff',
              color: 'var(--sub)',
              cursor: 'pointer',
            }}
          >
            {busy > 0 ? <Spin size="small" /> : <>＋<br />添加图片</>}
          </button>
        )}
      </div>
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
      <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
        第一张作为封面，最多 {MAX_IMAGES} 张，支持 JPG、PNG、WebP。上传前请遮挡快递面单、身份证号、家庭地址等隐私信息。
      </div>
    </div>
  );
}

/** AI 一句话发布：输入一句话（可结合第一张已上传图片），生成标题/描述/分类/成色/参考价，填入表单，用户确认后提交。顺带回传小星的风控判定（F2）。识别出券类时自动切换类型并预填有效期/数量（F16）。 */
function AiAssistant({ form, images, initialText, onNewPrice, onRisk, onVoucherCategory }: {
  form: FormInstance<FormValues>;
  images: Img[];
  initialText?: string;
  onNewPrice: (n: number | null) => void;
  onRisk: (r: { risk: Risk | null; riskCheckId: number | null } | null) => void;
  onVoucherCategory: () => void;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [loading, setLoading] = useState(false);
  const [suggest, setSuggest] = useState<AiDraft['priceSuggestion']>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [expUncertain, setExpUncertain] = useState(false);
  const { message } = AntApp.useApp();
  const tradeType = Form.useWatch('tradeType', form);

  const run = async () => {
    const input = text.trim();
    if (!input && images.length === 0) {
      message.warning('先上传一张商品图片，或用一句话描述这件物品');
      return;
    }
    setLoading(true);
    try {
      const r = await api<AiDraftResponse>('/api/ai/draft', { method: 'POST', json: { text: input || undefined, imageId: images[0]?.id } });
      if (!r.available || !r.draft) {
        onRisk(null);
        message.warning('小星暂时不在，请手动填写');
        return;
      }
      const d = r.draft;
      if (d.title) form.setFieldValue('title', d.title);
      if (d.description) form.setFieldValue('description', d.description);
      if (d.condition) form.setFieldValue('condition', d.condition);
      if (typeof d.newPriceEstimate === 'number') form.setFieldValue('originalPrice', d.newPriceEstimate);
      onNewPrice(typeof d.newPriceEstimate === 'number' ? d.newPriceEstimate : null);
      // F16：用户在原话里说了卖多少钱（如「25 出」），直接预填挂牌价
      if (typeof d.price === 'number' && d.price >= 1) {
        form.setFieldValue('tradeType', 'fixed');
        form.setFieldValue('price', d.price);
      }
      // F16：识别出券·权益时自动切换类型并预填有效期/数量；拿不准的有效期标黄由用户补填
      if (d.kind === 'voucher') {
        form.setFieldValue('kind', 'voucher');
        form.setFieldValue('handoffMode', 'online');
        form.setFieldValue('expiresForever', d.expiresOn == null);
        form.setFieldValue('expiresOnDay', d.expiresOn ? dayjs(d.expiresOn) : null);
        form.setFieldValue('quantity', d.quantity && d.quantity > 1 ? d.quantity : 1);
        onVoucherCategory(); // 分类固定为「券·权益」，不采用模型给的 categoryId
        setExpUncertain((d.uncertain ?? []).includes('expiresOn'));
      } else {
        setExpUncertain(false);
        if (d.categoryId) form.setFieldValue('categoryId', d.categoryId);
      }
      setSuggest(d.priceSuggestion ?? null);
      setMissing((d.missing ?? []).slice(0, 3));
      // F2：草稿顺带的风控判定，发布时回传 riskCheckId
      onRisk({ risk: d.risk ?? null, riskCheckId: r.riskCheckId ?? null });
      message.success('小星帮你填好了，请检查后发布');
    } catch (e) {
      onRisk(null);
      message.error(e instanceof Error ? e.message : '小星暂时不在，请手动填写');
    } finally {
      setLoading(false);
    }
  };

  return (
    <XingPanel working={loading}>
      <div className="ai-head">
        <XingAvatar talking={loading} />
        <XingBadge />
        <span className="muted">上传图片即可识别，自动生成标题、描述、分类和参考价；也可以再补一句话（选填），小星会结合两者识别。生成内容需你确认。</span>
      </div>
      <div className="ai-row">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={300}
          placeholder="选填：补充说明，例如「用了两年，功能正常」"
          onPressEnter={run}
          disabled={loading}
        />
        <Button type="primary" loading={loading} onClick={run}>
          {loading ? '小星正在识别…' : '生成'}
        </Button>
      </div>
      {suggest && tradeType === 'fixed' && suggest.min && suggest.max ? (
        <div className="ai-price">
          小星参考价 <b>¥{suggest.min}-{suggest.max}</b>
          {suggest.reason ? <span className="muted">（{suggest.reason}）</span> : null}，仅供参考
          <Button
            size="small"
            type="link"
            onClick={() => form.setFieldValue('price', Math.round((suggest.min! + suggest.max!) / 2))}
          >
            采用中间价 ¥{Math.round((suggest.min + suggest.max) / 2)}
          </Button>
        </div>
      ) : null}
      {missing.length > 0 && <div className="ai-missing">建议补充：{missing.join('；')}</div>}
      {expUncertain && <div className="ai-missing warn">有效期小星拿不准，请在下方手动选择「有效期」或勾选「长期有效」</div>}
    </XingPanel>
  );
}

export function Publish() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [params] = useSearchParams();
  const wishParam = params.get('wish');
  const wishId = wishParam && /^\d+$/.test(wishParam) ? Number(wishParam) : undefined;
  const { user, aiEnabled, preferredHandoff } = useAuth();
  const navigate = useNavigate();
  const act = useAct();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [images, setImages] = useState<Img[]>([]);
  const [saving, setSaving] = useState(false);
  const [origByXing, setOrigByXing] = useState(false);
  const [loaded, setLoaded] = useState(!editing);
  // F2 风控：小星草稿顺带的判定结果；发布/编辑时按规则补检，warn 弹「小星注意到」确认弹窗
  const [draftRisk, setDraftRisk] = useState<{ risk: Risk | null; riskCheckId: number | null } | null>(null);
  const [warnOpen, setWarnOpen] = useState(false);
  const [acked, setAcked] = useState(false);
  const [pending, setPending] = useState<{ values: FormValues; meta: RiskMeta; reason: string } | null>(null);
  const origRef = useRef<{ title: string; description: string; imageIds: string } | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // 弹窗打开时默认聚焦「返回修改」，避免误触确认发布
  useEffect(() => {
    if (warnOpen) backRef.current?.focus();
  }, [warnOpen]);

  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api<{ categories: Category[] }>('/api/categories') });
  // F16：「券·权益」分类 id（服务端迁移时保证存在）。券类发布固定用它，不让用户选。
  const voucherCatId = categories.data?.categories.find((c) => c.name === '券·权益')?.id;
  // 「我有这个」进入时，把心愿内容预填进小星输入框
  const wishForPrefill = useQuery({
    queryKey: ['wishes', 'prefill', wishId],
    enabled: wishId !== undefined && !editing,
    queryFn: async () => {
      const list = await api<{ wishes: { id: number; content: string }[] }>('/api/wishes?tab=all');
      return list.wishes.find((w) => w.id === wishId)?.content ?? null;
    },
  });
  const existing = useQuery({
    queryKey: ['item', id, 'edit'],
    enabled: editing,
    queryFn: async () => {
      const d = await api<ItemDetail>(`/api/items/${id}`);
      return d;
    },
  });

  if (editing && existing.data && !loaded) {
    const d = existing.data;
    form.setFieldsValue({
      kind: d.kind === 'voucher' ? 'voucher' : 'goods',
      title: d.title,
      categoryId: d.categoryId,
      condition: d.condition,
      tradeType: d.tradeType,
      price: d.price,
      originalPrice: d.originalPrice,
      negoEnabled: d.viewer === 'seller' && d.negotiationFloor != null,
      negotiationFloor: d.viewer === 'seller' ? d.negotiationFloor ?? undefined : undefined,
      description: d.description,
      handoffMode: d.handoffMode === 'online' ? 'online' : 'offline',
      handoffLocation: d.handoffLocation,
      handoffTime: d.handoffTime ?? undefined,
      expiresOnDay: d.expiresOn ? dayjs(d.expiresOn) : null,
      expiresForever: d.kind === 'voucher' && !d.expiresOn,
    });
    setImages(d.images);
    // F2：记住进入编辑时的内容，发布时判断图片/标题/描述是否变动（变了要重新补检）
    origRef.current = { title: d.title, description: d.description, imageIds: d.images.map((i) => i.id).join(',') };
    setLoaded(true);
  }

  if (editing && existing.isError)
    return (
      <div className="empty">
        <b>{existing.error.message}</b>
        <Link to="/"><Button type="primary">回到首页</Button></Link>
      </div>
    );
  if (!loaded) return <div className="empty"><Spin /></div>;
  if (editing && existing.data && (existing.data.viewer !== 'seller' || existing.data.status !== 'published'))
    return (
      <div className="empty">
        <b>这件商品现在不能编辑</b>
        只有发布中的商品可以编辑。
        <div><Link to={`/items/${id}`}><Button type="primary">返回商品</Button></Link></div>
      </div>
    );

  const finishPublish = async (v: FormValues, meta: RiskMeta): Promise<boolean> => {
    const isVoucher = v.kind === 'voucher';
    const body = {
      title: v.title,
      categoryId: isVoucher && voucherCatId ? voucherCatId : v.categoryId,
      description: v.description?.trim() ?? '',
      condition: isVoucher ? 'new' : v.condition, // 券类无成色，库存 new
      tradeType: v.tradeType,
      price: v.tradeType === 'free' ? 0 : v.price ?? 0,
      originalPrice: v.originalPrice ?? null,
      negotiationFloor: !isVoucher && v.tradeType === 'fixed' && v.negoEnabled ? v.negotiationFloor ?? null : null, // 券类不支持代谈
      kind: v.kind,
      handoffMode: isVoucher ? v.handoffMode : 'offline',
      handoffLocation: isVoucher && v.handoffMode === 'online' ? '' : v.handoffLocation, // 线上转赠库存空串
      handoffTime: v.handoffTime?.trim() || undefined,
      expiresOn: isVoucher && !v.expiresForever ? v.expiresOnDay?.format('YYYY-MM-DD') ?? null : null,
      quantity: !editing && isVoucher ? v.quantity ?? 1 : undefined, // 数量只在新建时拆分
      imageIds: images.map((i) => i.id),
      ...(wishId && !editing ? { wishId } : {}),
      ...meta,
    };
    let newId: number | undefined;
    const ok = await act(async () => {
      if (editing) await patch(`/api/items/${id}`, body);
      else newId = (await post<{ id: number; ids: number[] }>('/api/items', body)).id;
    }, editing ? '已保存' : '发布成功');
    if (ok) navigate(`/items/${editing ? id : newId}`);
    return ok;
  };

  /**
   * F2 风控预检：发布/编辑前确定要回传的 riskCheckId 和预警状态。
   * - 新发布且用过小星草稿：直接用草稿顺带的判定，不重复调 AI；
   * - 编辑且图片/标题/描述没变：保留服务端已有预警记录；
   * - 其余（手动发布、编辑后内容变动）：AI 开启时先补检（6 秒超时），失败按「未检」放行。
   */
  const resolveRisk = async (v: FormValues): Promise<{ meta: RiskMeta; warnReason: string | null }> => {
    if (!editing && draftRisk?.riskCheckId) {
      return { meta: { riskCheckId: draftRisk.riskCheckId }, warnReason: draftRisk.risk?.level === 'warn' ? draftRisk.risk.reason : null };
    }
    const orig = origRef.current;
    const unchanged = Boolean(
      editing && orig && v.title === orig.title && (v.description?.trim() ?? '') === orig.description && images.map((i) => i.id).join(',') === orig.imageIds,
    );
    if (unchanged || !aiEnabled) return { meta: {}, warnReason: null };
    try {
      const r = await api<RiskCheckResponse>('/api/ai/check', {
        method: 'POST',
        json: { title: v.title, description: v.description?.trim() ?? '', imageIds: images.slice(0, 2).map((i) => i.id) },
      });
      if (r.available && r.riskCheckId) {
        return { meta: { riskCheckId: r.riskCheckId }, warnReason: r.risk?.level === 'warn' ? r.risk.reason : null };
      }
    } catch {
      // 补检失败或超时：未检放行，不阻塞发布
    }
    return { meta: {}, warnReason: null };
  };

  const submit = async (v: FormValues) => {
    // F16：实物仍要求至少一张图片；券类图片可选（无图用券类占位样式）
    if (v.kind !== 'voucher' && images.length === 0) {
      message.warning('请至少上传一张图片');
      return;
    }
    setSaving(true);
    try {
      const { meta, warnReason } = await resolveRisk(v);
      if (warnReason) {
        setPending({ values: v, meta, reason: warnReason });
        setAcked(false);
        setWarnOpen(true); // 「小星注意到」确认弹窗：强提醒，不拦截
        return;
      }
      await finishPublish(v, meta);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1 className="page-title">{editing ? '编辑商品' : '发布闲置物品'}</h1>
      {!editing && <PublishModeSwitch mode="single" />}
      {!user.contact && (
        <div className="notice orange" style={{ marginBottom: 18 }}>
          <b>还没有填写联系方式</b>
          发布前请先点右上角头像，填写联系方式。卖家选定交易对象后，双方才能看到彼此的联系方式。
        </div>
      )}
      <div className="form-wrap">
        {aiEnabled && (
          <AiAssistant
            form={form}
            images={images}
            initialText={wishForPrefill.data ?? undefined}
            onNewPrice={(n) => setOrigByXing(n !== null)}
            onRisk={setDraftRisk}
            onVoucherCategory={() => {
              if (voucherCatId) form.setFieldValue('categoryId', voucherCatId);
            }}
          />
        )}
        <Form
          form={form}
          layout="vertical"
          requiredMark="optional"
          onFinish={submit}
          initialValues={{ kind: 'goods', tradeType: 'fixed', condition: 'good', handoffMode: 'online', quantity: 1, expiresForever: false, handoffLocation: preferredHandoff ?? undefined }}
        >
          <Form.Item name="kind" label="商品类型" required>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { value: 'goods', label: '实物' },
                { value: 'voucher', label: '券·权益' },
              ]}
              onChange={(e) => {
                if (e.target.value === 'voucher') {
                  // 切到券类：分类固定、默认线上转赠、成色固定 new
                  if (voucherCatId) form.setFieldValue('categoryId', voucherCatId);
                  form.setFieldValue('condition', 'new');
                  if (!form.getFieldValue('handoffMode')) form.setFieldValue('handoffMode', 'online');
                } else {
                  form.setFieldValue('handoffMode', 'offline');
                  form.setFieldValue('expiresOnDay', null);
                  form.setFieldValue('expiresForever', false);
                }
              }}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind}>
            {() =>
              form.getFieldValue('kind') === 'voucher' ? (
                <div className="notice" style={{ marginBottom: 16 }}>
                  券和会员权益能否转让，以发放方的规则为准。平台不做担保，请双方确认后再交易。
                </div>
              ) : null
            }
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind}>
            {() => {
              const isVoucher = form.getFieldValue('kind') === 'voucher';
              return (
                <>
                  <Form.Item
                    label="商品图片"
                    required={!isVoucher}
                    extra={isVoucher ? '券类可以不传图片，集市会用券类占位样式展示（选填，最多 5 张）' : undefined}
                  >
                    <ImagePicker value={images} onChange={setImages} />
                  </Form.Item>
                  <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '请填写标题' }]}>
                    <Input maxLength={60} showCount placeholder={isVoucher ? '例如：京东洗鞋券（任洗 2 件）' : '品牌 + 型号 + 关键特征，例如：戴尔 U2720Q 4K 显示器'} />
                  </Form.Item>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    <Form.Item name="categoryId" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
                      <Select
                        placeholder={isVoucher ? '券·权益' : '选择分类'}
                        disabled={isVoucher}
                        options={categories.data?.categories.map((c) => ({ value: c.id, label: c.name }))}
                        loading={categories.isLoading}
                      />
                    </Form.Item>
                    {!isVoucher && (
                      <Form.Item name="condition" label="新旧程度" rules={[{ required: true }]}>
                        <Select options={Object.entries(CONDITION_LABEL).map(([value, label]) => ({ value, label }))} />
                      </Form.Item>
                    )}
                  </div>
                </>
              );
            }}
          </Form.Item>
          <Form.Item name="tradeType" label="交易方式" required>
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { value: 'fixed', label: '一口价转让' },
                { value: 'free', label: '免费赠送' },
              ]}
              onChange={(e) => form.setFieldValue('price', e.target.value === 'free' ? 0 : undefined)}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.tradeType !== b.tradeType}>
            {() =>
              form.getFieldValue('tradeType') === 'fixed' && (
                <Form.Item name="price" label="价格" rules={[{ required: true, message: '请填写价格' }, { type: 'number', min: 1, message: '价格至少 1 元' }]}>
                  <InputNumber min={1} max={1000000} precision={0} style={{ width: 200 }} suffix="元" placeholder="整数" />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item
            name="originalPrice"
            label="面值（即全新参考价）"
            extra={origByXing ? '✦ 小星估算，可修改' : '券的票面金额（选填），例如京东卡 500'}
          >
            <InputNumber min={1} max={1000000} precision={0} style={{ width: 200 }} suffix="元" placeholder="整数" />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind || a.expiresForever !== b.expiresForever}>
            {() =>
              form.getFieldValue('kind') === 'voucher' && (
                <>
                  <Form.Item
                    name="expiresOnDay"
                    label="有效期"
                    rules={[
                      {
                        validator: (_r, v: Dayjs | null | undefined) => {
                          if (form.getFieldValue('expiresForever')) return Promise.resolve();
                          if (!v) return Promise.reject(new Error('请选择有效期，或勾选「长期有效」'));
                          if (v.format('YYYY-MM-DD') < beijingToday()) return Promise.reject(new Error('有效期不能早于今天'));
                          return Promise.resolve();
                        },
                      },
                    ]}
                    extra="按北京时间计算；到期后在售的券会自动下架"
                  >
                    <DatePicker
                      style={{ width: 200 }}
                      disabledDate={(current: Dayjs) => current.format('YYYY-MM-DD') < beijingToday()}
                      placeholder="选择日期"
                    />
                  </Form.Item>
                  <Form.Item name="expiresForever" valuePropName="checked">
                    <Checkbox>长期有效</Checkbox>
                  </Form.Item>
                </>
              )
            }
          </Form.Item>
          {aiEnabled && (
            <Form.Item noStyle shouldUpdate={(a, b) => a.tradeType !== b.tradeType || a.kind !== b.kind}>
              {() =>
                form.getFieldValue('tradeType') === 'fixed' &&
                form.getFieldValue('kind') !== 'voucher' && ( // F16：券类不支持小星代谈
                  <div className="nego-setting">
                    <Form.Item name="negoEnabled" label="允许小星代谈" valuePropName="checked" extra="买家可以请小星和你谈价，谈成价不会低于你设置的底价">
                      <Switch onChange={(on) => { if (!on) form.setFieldValue('negotiationFloor', undefined); }} />
                    </Form.Item>
                    <Form.Item noStyle shouldUpdate={(a, b) => a.negoEnabled !== b.negoEnabled}>
                      {() =>
                        form.getFieldValue('negoEnabled') && (
                          <Form.Item
                            name="negotiationFloor"
                            label="最低可接受价"
                            rules={[
                              { required: true, message: '开启代谈后必须填写最低可接受价' },
                              {
                                validator: (_r, v: number | undefined) => {
                                  if (v == null) return Promise.resolve();
                                  if (v < 1) return Promise.reject(new Error('最低可接受价至少 1 元'));
                                  const price = form.getFieldValue('price');
                                  if (price != null && v > price) return Promise.reject(new Error('最低可接受价不能高于挂牌价'));
                                  return Promise.resolve();
                                },
                              },
                            ]}
                            extra="只有小星知道，不会展示给任何人"
                          >
                            <InputNumber min={1} max={1000000} precision={0} style={{ width: 200 }} suffix="元" placeholder="整数" />
                          </Form.Item>
                        )
                      }
                    </Form.Item>
                  </div>
                )
              }
            </Form.Item>
          )}
          <Form.Item name="description" label="商品描述">
            <Input.TextArea
              rows={5}
              maxLength={2000}
              showCount
              placeholder={form.getFieldValue('kind') === 'voucher' ? '使用限制，例如「11 月 12 日后才能预约」（选填）' : '使用时长、成色、瑕疵、配件是否齐全、购买渠道等（选填）'}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind || a.handoffMode !== b.handoffMode}>
            {() => {
              const isVoucher = form.getFieldValue('kind') === 'voucher';
              const online = isVoucher && form.getFieldValue('handoffMode') === 'online';
              return (
                <>
                  {isVoucher && (
                    <Form.Item name="handoffMode" label="交接方式" required>
                      <Radio.Group
                        optionType="button"
                        buttonStyle="solid"
                        options={[
                          { value: 'online', label: '线上转赠' },
                          { value: 'offline', label: '线下当面' },
                        ]}
                      />
                    </Form.Item>
                  )}
                  {!online && (
                    <Form.Item
                      name="handoffLocation"
                      label="交接地点"
                      rules={[{ required: !online, whitespace: true, message: '请填写交接地点' }]}
                    >
                      <Input maxLength={100} placeholder="例如：一楼大厅、3 楼前台" />
                    </Form.Item>
                  )}
                </>
              );
            }}
          </Form.Item>
          {!editing && (
            <Form.Item noStyle shouldUpdate={(a, b) => a.kind !== b.kind}>
              {() =>
                form.getFieldValue('kind') === 'voucher' && (
                  <Form.Item
                    name="quantity"
                    label="数量"
                    rules={[{ required: true, message: '请填写数量' }]}
                    extra="有几张就填几，例如 4 张。发布后会拆成 4 件相同的商品分别走申请流程，集市里折叠成一张卡片"
                  >
                    <InputNumber min={1} max={10} precision={0} style={{ width: 200 }} suffix="张" placeholder="1-10" />
                  </Form.Item>
                )
              }
            </Form.Item>
          )}
          <Form.Item name="handoffTime" label="可交接时间">
            <Input maxLength={100} placeholder="例如：工作日 12:00-13:00（选填）" />
          </Form.Item>
          <div className="btn-row">
            <Button type="primary" size="large" htmlType="submit" loading={saving}>
              {editing ? '保存修改' : '发布'}
            </Button>
            <Button size="large" onClick={() => navigate(-1)}>取消</Button>
          </div>
        </Form>
      </div>
      <Modal
        title={<XingBadge label="小星注意到" />}
        open={warnOpen}
        footer={[
          <Button key="cancel" ref={backRef} onClick={() => setWarnOpen(false)}>返回修改</Button>,
          <Button key="ok" type="primary" loading={saving} disabled={!acked} onClick={async () => {
            if (!pending) return;
            setSaving(true);
            const ok = await finishPublish(pending.values, { ...pending.meta, riskAck: true });
            setSaving(false);
            if (ok) setWarnOpen(false);
          }}>确认并发布</Button>,
        ]}
        onCancel={() => setWarnOpen(false)}
      >
        <p style={{ marginTop: 0 }}>
          小星在这件商品上注意到：<b>{pending?.reason}</b>
        </p>
        <p className="muted">公司资产不得私自转让。如确为个人物品可以继续发布，管理员会复核。</p>
        <Checkbox checked={acked} onChange={(e) => setAcked(e.target.checked)}>
          我确认这是个人物品，可以转让
        </Checkbox>
      </Modal>
    </>
  );
}

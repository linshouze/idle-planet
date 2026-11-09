import { useState } from 'react';
import { App as AntApp, Button, DatePicker, Input, Modal, Segmented, Select, Spin, Switch, Table, Tag, Upload } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, patch, post } from '../api/client';
import type { AdminCategory, AdminItem, AdminUser, Dashboard, StaleDeal } from '../api/types';
import { useAct, useAuth, useConfirm } from '../auth';
import { XingPanel } from '../components/Xing';
import { ITEM_STATUS, RISK_TYPE_LABEL, formatDateTime, priceText } from '../format';

/** 看板上的 AI 价值报告：把上方真实统计数据交给 AI 生成一段可念的运营总结。 */
function AiReport({ from, to, includeDemo }: { from: string; to?: string; includeDemo: boolean }) {
  const { aiEnabled } = useAuth();
  const { message } = AntApp.useApp();
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (!aiEnabled) return null;

  const run = async () => {
    setLoading(true);
    try {
      const r = await api<{ available: boolean; report?: string }>(`/api/ai/report?from=${from}${to ? `&to=${to}` : ''}${includeDemo ? '&includeDemo=1' : ''}`, { method: 'POST', json: {} });
      if (!r.available || !r.report) {
        message.warning('小星暂时不在，请稍后再试');
        return;
      }
      setReport(r.report);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '生成失败，请稍后再试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ai-report">
      <Button type="primary" loading={loading} onClick={run}>
        {loading ? '小星正在写…' : '✦ 小星生成价值报告'}
      </Button>
      {report && (
        <XingPanel className="ai-report-body">
          {report}
          <div className="footnote">以上报告由小星基于本页真实统计数据生成，数字与看板一致。</div>
        </XingPanel>
      )}
    </div>
  );
}

const DEFAULT_FROM = dayjs('2026-11-04');

const pct = (v: number | null): string => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`);
const duration = (h: number | null): { v: string; u: string } => {
  if (h === null) return { v: '-', u: '' };
  if (h < 1) return { v: String(Math.max(1, Math.round(h * 60))), u: '分钟' };
  if (h < 48) return { v: (Math.round(h * 10) / 10).toString(), u: '小时' };
  return { v: (Math.round((h / 24) * 10) / 10).toString(), u: '天' };
};

function DashboardTab() {
  const [range, setRange] = useState<[Dayjs, Dayjs | null]>([DEFAULT_FROM, null]);
  const [includeDemo, setIncludeDemo] = useState(false);
  const from = range[0].format('YYYY-MM-DD');
  const to = range[1]?.format('YYYY-MM-DD');
  const q = useQuery({
    queryKey: ['dashboard', from, to, includeDemo],
    queryFn: () => api<Dashboard>(`/api/admin/dashboard?from=${from}${to ? `&to=${to}` : ''}${includeDemo ? '&includeDemo=1' : ''}`),
  });
  const d = q.data;
  const cycle = duration(d?.avgCycleHours ?? null);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <span className="muted">统计范围</span>
        <DatePicker.RangePicker
          allowEmpty={[false, true]}
          value={range}
          onChange={(v) => setRange(v && v[0] ? [v[0], v[1]] : [DEFAULT_FROM, null])}
          placeholder={['开始日期', '至今']}
          disabledDate={(c) => c.isAfter(dayjs())}
        />
        <Button onClick={() => setRange([DEFAULT_FROM, null])}>重置为赛期起点</Button>
        <span style={{ marginLeft: 'auto' }}>
          <Switch checked={includeDemo} onChange={setIncludeDemo} checkedChildren="含演示数据" unCheckedChildren="仅真实员工" />
        </span>
      </div>
      {q.isLoading || !d ? (
        <div className="empty"><Spin /></div>
      ) : (
        <>
          <div className="metrics">
            <div className="metric main-metric">
              <div className="v">{d.completed}<small>笔</small></div>
              <div className="l">完成交易数</div>
              <div className="l muted">实物 {d.split.completed.goods} · 券·权益 {d.split.completed.voucher}</div>
            </div>
            <div className="metric main-metric"><div className="v">¥{d.saved}</div><div className="l">为同事节省（{d.savedCoverage.covered}/{d.savedCoverage.total} 笔有参考价）</div></div>
            <div className="metric">
              <div className="v">{d.published}<small>件</small></div>
              <div className="l">发布数</div>
              <div className="l muted">实物 {d.split.published.goods} · 券·权益 {d.split.published.voucher}</div>
            </div>
            <div className="metric"><div className="v">{d.requests}<small>个</small></div><div className="l">申请数</div></div>
            <div className="metric"><div className="v">{d.activeUsers}<small>人</small></div><div className="l">活跃员工数</div></div>
            <div className="metric"><div className="v">{d.wishes.active}<small>个</small></div><div className="l">进行中心愿</div></div>
            <div className="metric"><div className="v">{d.wishes.fulfilled}<small>个</small></div><div className="l">已实现心愿</div></div>
            <div className="metric"><div className="v">{pct(d.matchRate)}</div><div className="l">供需匹配率（至少收到一个申请）</div></div>
            <div className="metric"><div className="v">{pct(d.completionRate)}</div><div className="l">交易完成率</div></div>
            <div className="metric"><div className="v">{cycle.v}<small>{cycle.u}</small></div><div className="l">平均交易周期（发布到完成）</div></div>
            <div className="metric">
              <div className="v">¥{d.flow.amount}<small>+ {d.flow.freeCount} 件免费</small></div>
              <div className="l">流转物品价值</div>
              <div className="l muted">实物 ¥{d.split.flow.goods.amount} · 券·权益 ¥{d.split.flow.voucher.amount}</div>
            </div>
            <div className="metric">
              <div className="v">{d.split.expiredVouchers}<small>件</small></div>
              <div className="l">过期未出件数（券到期作废）</div>
            </div>
            <div className="metric xing-metric">
              <div className="v">
                <span className="xing-chip">✦ 小星代谈</span> {d.negotiation.started}<small>次</small>
              </div>
              <div className="l">
                成功率 {pct(d.negotiation.successRate)}
                {d.negotiation.avgDiscount != null ? ` · 平均让价 ${Math.round(d.negotiation.avgDiscount * 1000) / 10}%` : ''}
              </div>
            </div>
          </div>

          <AiReport from={from} to={to ?? undefined} includeDemo={includeDemo} />

          <div className="charts">
            <div className="chart-box">
              <h3>每日发布与完成</h3>
              {d.daily.length === 0 ? (
                <div className="empty" style={{ padding: 40 }}>这个范围内还没有数据</div>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={d.daily} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                    <CartesianGrid stroke="#e5eaf5" vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(s: string) => s.slice(5)} fontSize={12} />
                    <YAxis allowDecimals={false} fontSize={12} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="published" name="发布" stroke="#3b82f6" strokeWidth={2.5} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="completed" name="完成" stroke="#22c55e" strokeWidth={2.5} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="chart-box">
              <h3>交易漏斗（范围内发布的商品）</h3>
              {[
                ['发布', d.funnel.published],
                ['有人申请', d.funnel.requested],
                ['被选中', d.funnel.accepted],
                ['已完成', d.funnel.completed],
              ].map(([label, n]) => (
                <div className="funnel-row" key={label as string}>
                  <span>{label}</span>
                  <div className="funnel-bar"><i style={{ width: `${d.funnel.published ? ((n as number) / d.funnel.published) * 100 : 0}%` }} /></div>
                  <b>{n}</b>
                </div>
              ))}
              <h3 style={{ marginTop: 18 }}>各分类发布与完成</h3>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={d.byCategory} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                  <CartesianGrid stroke="#e5eaf5" vertical={false} />
                  <XAxis dataKey="name" fontSize={11} interval={0} />
                  <YAxis allowDecimals={false} fontSize={12} />
                  <Tooltip />
                  <Bar dataKey="published" name="发布" fill="#a5bef3" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="completed" name="完成" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="footnote">
            当前口径：{includeDemo ? '包含演示数据' : '仅统计真实员工数据（部门为「演示账号」的不计入）'}。数据范围：{from} 至 {to ?? '今天'}（北京时间）。
            所有数字由数据库记录实时聚合，没有人工填报。发布数按发布时间、申请数按申请时间、完成交易数按完成时间计入；
            完成率和匹配率以范围内发布的商品为分母；活跃员工数为范围内至少登录访问过一天的员工。
            为同事节省 = 全新参考价 − 成交价（免费件按参考价计，参考价由小星估算、发布者确认，差值为负按 0 计）；
            券·权益的参考价即面值，节省 = 面值 − 成交价。同一次发布拆分的多件券按件计数（4 张卖出 3 张计 3 笔）。
            过期未出件数 = 因有效期已过被自动下架（未成交）的券，按自动下架时间计入范围。
          </div>
        </>
      )}
    </>
  );
}

function ItemsTab() {
  const act = useAct();
  const [status, setStatus] = useState('');
  const [kw, setKw] = useState('');
  const [aiFlag, setAiFlag] = useState(false);
  const [kind, setKind] = useState('');
  const [reasonFor, setReasonFor] = useState<AdminItem | null>(null);
  const [reason, setReason] = useState('');
  const q = useQuery({
    queryKey: ['admin-items', status, kw, aiFlag, kind],
    queryFn: () =>
      api<{ items: AdminItem[] }>(
        `/api/admin/items?${new URLSearchParams({ ...(status && { status }), ...(kw && { q: kw }), ...(aiFlag && { aiFlag: '1' }), ...(kind && { kind }) })}`,
      ),
  });
  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <Input.Search allowClear placeholder="按标题搜索" style={{ width: 240 }} onSearch={setKw} />
        <Select
          value={status}
          onChange={setStatus}
          style={{ width: 140 }}
          options={[{ value: '', label: '全部状态' }, ...Object.entries(ITEM_STATUS).map(([value, v]) => ({ value, label: v.label }))]}
        />
        <Select
          value={kind}
          onChange={setKind}
          style={{ width: 120 }}
          options={[
            { value: '', label: '全部类型' },
            { value: 'goods', label: '实物' },
            { value: 'voucher', label: '券·权益' },
          ]}
        />
        <Segmented
          value={aiFlag ? 'risk' : 'all'}
          onChange={(v) => setAiFlag(v === 'risk')}
          options={[{ value: 'all', label: '全部商品' }, { value: 'risk', label: '✦ 小星预警' }]}
        />
      </div>
      <Table<AdminItem>
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data?.items}
        pagination={{ pageSize: 15, showSizeChanger: false }}
        locale={{ emptyText: '没有符合条件的商品' }}
        rowClassName={(r) => (r.aiRiskType && !r.aiRiskReviewed ? 'risk-row' : '')}
        columns={[
          {
            title: '首图',
            width: 72,
            render: (_, r) =>
              r.cover ? <img src={r.cover} alt={`「${r.title}」首图`} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 8 }} /> : <span className="muted">-</span>,
          },
          { title: '商品', dataIndex: 'title', render: (t, r) => <a href={`/items/${r.id}`} target="_blank" rel="noreferrer">{t}</a> },
          { title: '发布者', render: (_, r) => `${r.sellerName}（${r.sellerEmployeeNo}）` },
          { title: '类型', width: 90, render: (_, r) => <Tag>{r.kind === 'voucher' ? '券·权益' : '实物'}</Tag> },
          { title: '价格', render: (_, r) => priceText(r.tradeType, r.price), width: 90 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 110,
            render: (s: AdminItem['status'], r) =>
              s === 'withdrawn' && r.withdrawReason === 'expired' ? <Tag color="orange">已过期</Tag> : <Tag>{ITEM_STATUS[s].label}</Tag>,
          },
          {
            title: '小星预警',
            width: 230,
            render: (_, r) =>
              r.aiRiskType ? (
                <div>
                  <Tag color={r.aiRiskType === 'prohibited' ? 'red' : 'orange'}>{RISK_TYPE_LABEL[r.aiRiskType]}{r.aiRiskChecked ? '' : '（未检发布）'}</Tag>
                  <div className="muted" style={{ fontSize: 12, whiteSpace: 'normal' }}>{r.aiRiskReason}</div>
                </div>
              ) : (
                <span className="muted">-</span>
              ),
          },
          { title: '确认', width: 80, render: (_, r) => (r.aiRiskType ? (r.aiRiskAck ? <Tag color="green">已确认</Tag> : <Tag>未确认</Tag>) : '-') },
          { title: '复核', width: 80, render: (_, r) => (r.aiRiskType ? (r.aiRiskReviewed ? <Tag color="green">已复核</Tag> : <Tag color="orange">待复核</Tag>) : '-') },
          { title: '发布时间', dataIndex: 'publishedAt', width: 130, render: formatDateTime },
          {
            title: '操作',
            width: 160,
            render: (_, r) => (
              <>
                {r.aiRiskType && !r.aiRiskReviewed && (
                  <Button size="small" type="primary" onClick={() => act(() => post(`/api/admin/items/${r.id}/risk-reviewed`), '已标记复核')} style={{ marginRight: 8 }}>
                    标记已复核
                  </Button>
                )}
                {r.status === 'hidden' ? (
                  <Button size="small" onClick={() => act(() => post(`/api/admin/items/${r.id}/restore`), '已恢复')}>恢复</Button>
                ) : ['published', 'locked', 'handed_over'].includes(r.status) ? (
                  <Button size="small" danger onClick={() => { setReason(''); setReasonFor(r); }}>隐藏</Button>
                ) : null}
              </>
            ),
          },
        ]}
      />
      <Modal
        title={`隐藏「${reasonFor?.title ?? ''}」`}
        open={Boolean(reasonFor)}
        okText="隐藏"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onCancel={() => setReasonFor(null)}
        onOk={async () => {
          if (await act(() => post(`/api/admin/items/${reasonFor!.id}/hide`, { reason: reason.trim() || undefined }), '已隐藏')) setReasonFor(null);
        }}
      >
        <p className="muted" style={{ marginTop: 0 }}>隐藏后员工在集市里看不到，进行中的申请和交易会被关闭，恢复时会重新打开。</p>
        <Input.TextArea rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="隐藏原因（选填）" />
      </Modal>
    </>
  );
}

function DealsTab() {
  const confirm = useConfirm();
  const [days, setDays] = useState('3');
  const q = useQuery({ queryKey: ['stale', days], queryFn: () => api<{ deals: StaleDeal[] }>(`/api/admin/deals/stale?days=${days}`) });
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span className="muted">卖家已标记交付，买家超过</span>
        <Segmented value={days} onChange={setDays} options={[{ value: '3', label: '3 天' }, { value: '1', label: '1 天' }, { value: '0', label: '全部' }]} />
        <span className="muted">未确认收货的交易</span>
      </div>
      <Table<StaleDeal>
        rowKey="requestId"
        loading={q.isLoading}
        dataSource={q.data?.deals}
        pagination={false}
        locale={{ emptyText: '没有卡住的交易' }}
        columns={[
          { title: '商品', dataIndex: 'title' },
          { title: '卖家', dataIndex: 'sellerName', width: 100 },
          { title: '买家', width: 200, render: (_, r) => `${r.buyerName}${r.buyerContact ? `（${r.buyerContact}）` : ''}` },
          { title: '交付时间', dataIndex: 'handedOverAt', width: 130, render: formatDateTime },
          {
            title: '操作',
            width: 120,
            render: (_, r) => (
              <Button
                size="small"
                type="primary"
                onClick={() =>
                  confirm('强制完成这笔交易？', '请先联系买家确认已经收到物品。强制完成后不能撤销。', '强制完成', () => post(`/api/admin/requests/${r.requestId}/force-complete`), '交易已完成')
                }
              >
                强制完成
              </Button>
            ),
          },
        ]}
      />
    </>
  );
}

function UsersTab() {
  const act = useAct();
  const { message, modal } = AntApp.useApp();
  const { user: me } = useAuth();
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ employeeNo: '', name: '', department: '', role: 'employee' });
  const q = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: AdminUser[] }>('/api/admin/users') });

  const importCsv = async (file: File) => {
    const csv = await file.text();
    try {
      const r = await api<{ created: number; updated: number; errors: { line: number; message: string }[] }>('/api/admin/users/import', { method: 'POST', json: { csv } });
      modal.info({
        title: '导入完成',
        okText: '知道了',
        content: (
          <div>
            新增 {r.created} 人，更新 {r.updated} 人{r.errors.length ? `，${r.errors.length} 行有问题：` : '。'}
            {r.errors.map((e) => (
              <div key={e.line}>第 {e.line} 行：{e.message}</div>
            ))}
          </div>
        ),
      });
      await act(async () => undefined);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导入失败');
    }
    return false;
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'center' }}>
        <Button type="primary" onClick={() => setAddOpen(true)}>添加员工</Button>
        <Upload accept=".csv,.txt" showUploadList={false} beforeUpload={importCsv}>
          <Button>导入 CSV</Button>
        </Upload>
        <span className="muted">CSV 每行：工号,姓名,部门,角色（部门和角色可省略，角色填 admin 为管理员）。工号已存在则更新。</span>
      </div>
      <Table<AdminUser>
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data?.users}
        pagination={{ pageSize: 15, showSizeChanger: false }}
        columns={[
          { title: '工号', dataIndex: 'employeeNo', width: 110 },
          { title: '姓名', dataIndex: 'name', width: 110 },
          { title: '部门', dataIndex: 'department', render: (v) => v ?? '-' },
          { title: '角色', dataIndex: 'role', width: 90, render: (v) => (v === 'admin' ? <Tag color="blue">管理员</Tag> : '员工') },
          { title: '最近登录', dataIndex: 'lastLoginAt', width: 130, render: (v) => (v ? formatDateTime(v) : '从未登录') },
          {
            title: '账号状态',
            width: 100,
            render: (_, r) => (
              <Switch
                checked={r.status === 'active'}
                disabled={r.id === me.id}
                checkedChildren="启用"
                unCheckedChildren="停用"
                onChange={(on) => act(() => patch(`/api/admin/users/${r.id}`, { status: on ? 'active' : 'disabled' }), on ? '已启用' : '已停用，对方已被强制退出')}
              />
            ),
          },
        ]}
      />
      <Modal
        title="添加员工"
        open={addOpen}
        okText="添加"
        cancelText="取消"
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          if (!draft.employeeNo.trim() || !draft.name.trim()) return message.warning('请填写工号和姓名');
          if (await act(() => post('/api/admin/users', { ...draft, department: draft.department || undefined }), '已添加')) {
            setAddOpen(false);
            setDraft({ employeeNo: '', name: '', department: '', role: 'employee' });
          }
        }}
      >
        <div style={{ display: 'grid', gap: 12 }}>
          <Input placeholder="工号" value={draft.employeeNo} onChange={(e) => setDraft({ ...draft, employeeNo: e.target.value })} />
          <Input placeholder="姓名" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <Input placeholder="部门（选填）" value={draft.department} onChange={(e) => setDraft({ ...draft, department: e.target.value })} />
          <Select value={draft.role} onChange={(role) => setDraft({ ...draft, role })} options={[{ value: 'employee', label: '员工' }, { value: 'admin', label: '管理员' }]} />
        </div>
      </Modal>
    </>
  );
}

function CategoriesTab() {
  const act = useAct();
  const [name, setName] = useState('');
  const q = useQuery({ queryKey: ['admin-categories'], queryFn: () => api<{ categories: AdminCategory[] }>('/api/admin/categories') });
  const [editing, setEditing] = useState<Record<number, string>>({});
  return (
    <>
      <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="新分类名称" maxLength={20} style={{ width: 220 }} onPressEnter={() => document.getElementById('add-cat')?.click()} />
        <Button
          id="add-cat"
          type="primary"
          disabled={!name.trim()}
          onClick={async () => {
            if (await act(() => post('/api/admin/categories', { name, sort: (q.data?.categories.length ?? 0) + 1 }), '已添加')) setName('');
          }}
        >
          添加分类
        </Button>
      </div>
      <Table<AdminCategory>
        rowKey="id"
        loading={q.isLoading}
        dataSource={q.data?.categories}
        pagination={false}
        columns={[
          {
            title: '名称',
            render: (_, r) => (
              <Input
                value={editing[r.id] ?? r.name}
                maxLength={20}
                style={{ width: 200 }}
                onChange={(e) => setEditing({ ...editing, [r.id]: e.target.value })}
                onBlur={async () => {
                  const v = editing[r.id]?.trim();
                  if (v && v !== r.name) await act(() => patch(`/api/admin/categories/${r.id}`, { name: v }), '已改名');
                  setEditing(({ [r.id]: _drop, ...rest }) => rest);
                }}
              />
            ),
          },
          {
            title: '排序',
            width: 120,
            render: (_, r) => (
              <>
                <Button size="small" onClick={() => act(() => patch(`/api/admin/categories/${r.id}`, { sort: r.sort - 1 }))}>上移</Button>{' '}
                <Button size="small" onClick={() => act(() => patch(`/api/admin/categories/${r.id}`, { sort: r.sort + 1 }))}>下移</Button>
              </>
            ),
          },
          {
            title: '启用',
            width: 100,
            render: (_, r) => <Switch checked={Boolean(r.enabled)} onChange={(on) => act(() => patch(`/api/admin/categories/${r.id}`, { enabled: on }))} />,
          },
        ]}
      />
      <div className="footnote">停用的分类不会出现在集市和发布页，已有商品不受影响。</div>
    </>
  );
}

/** 小星风控规则（F2 只读页签）：展示判定清单与处理原则，用于答辩展示。与 prompts/risk.txt 的判定规则保持一致。 */
function RiskRulesTab() {
  const rows: [string, string, string][] = [
    ['company_asset', '公司资产', '固定资产标签或资产编号贴纸；公司配发的电脑和显示器（带公司标识或资产标签）；工牌、门禁卡'],
    ['prohibited', '违规品', '药品、管制刀具、烟草酒类；公司内部资料；外币兑换（如「收港币」）；账号密码出借或出售'],
    ['allow', '不列入（不提醒）', '食品、零食；公司发放的福利券、礼品卡、节日礼品、周年庆奖品；会员权益共享（如 88VIP 附带的视频年卡、山姆副卡）'],
  ];
  return (
    <div style={{ maxWidth: 860 }}>
      <p className="muted" style={{ marginTop: 0 }}>
        小星在发布识别和发布补检时按下面的清单判断商品是否涉及公司资产或违规品。2026-11-07 依据真实闲置群数据调整：放行福利券和会员权益，新增外币兑换、账号密码出借两项违规，只判定出售主体。
      </p>
      <Table<[string, string, string]>
        rowKey={(r) => r[0]}
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '类型', width: 160, render: (_, r) => (r[0] === 'allow' ? <Tag color="green">{r[1]}</Tag> : <Tag color={r[0] === 'prohibited' ? 'red' : 'orange'}>{r[1]}</Tag>) },
          { title: '判定内容', render: (_, r) => <span style={{ whiteSpace: 'normal' }}>{r[2]}</span> },
        ]}
      />
      <div className="notice orange" style={{ marginTop: 18 }}>
        <b>处理原则：强提醒 + 发布者确认 + 管理员复核，不自动拦截</b>
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          <li>只判定被出售的主体物品，照片背景里出现的公司设备不算。</li>
          <li>看到明确证据才提醒，宁可漏报，不可误报；提醒时必须指出具体证据。</li>
          <li>命中提醒的商品由发布者勾选确认「这是个人物品」后照常上架，集市和详情页不向普通用户展示预警。</li>
          <li>预警记录保留在服务端，管理员在商品管理中复核；AI 超时或失败时按「未检」放行，不阻塞发布。</li>
        </ul>
      </div>
    </div>
  );
}

export function Admin() {
  const [tab, setTab] = useState('dashboard');
  return (
    <>
      <h1 className="page-title">管理后台</h1>
      <div className="tabs" role="tablist">
        {[
          ['dashboard', '价值看板'],
          ['items', '商品管理'],
          ['deals', '未确认交易'],
          ['users', '员工白名单'],
          ['categories', '分类管理'],
          ['riskrules', '小星风控规则'],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => setTab(k!)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'items' && <ItemsTab />}
      {tab === 'deals' && <DealsTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'riskrules' && <RiskRulesTab />}
    </>
  );
}

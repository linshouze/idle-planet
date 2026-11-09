import { z } from 'zod';

export const CONDITIONS = ['new', 'like_new', 'good', 'fair'] as const;
export const TRADE_TYPES = ['fixed', 'free'] as const;
/** F16 商品类型：goods 实物 | voucher 券·权益 */
export const ITEM_KINDS = ['goods', 'voucher'] as const;
/** F16 交接方式：offline 线下当面 | online 线上转赠（仅券类可选，线上时交接地点为空串） */
export const HANDOFF_MODES = ['offline', 'online'] as const;

/** 北京时间（UTC+8）的今天，YYYY-MM-DD。有效期比较与过期判定都用它。 */
export const beijingToday = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export const loginSchema = z.object({
  employeeNo: z.string().trim().min(1).max(50),
});

export const feishuBindSchema = z.object({
  employeeNo: z.string().trim().min(1).max(50),
});

export const contactSchema = z.object({
  contact: z.string().trim().min(1, '请填写联系方式').max(100),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const itemInputSchema = z
  .object({
    title: z.string().trim().min(1, '请填写标题').max(60),
    categoryId: z.number().int().positive(),
    description: z.string().trim().max(2000).default(''),
    condition: z.enum(CONDITIONS),
    tradeType: z.enum(TRADE_TYPES),
    price: z.number().int().min(0).max(1_000_000),
    originalPrice: z.number().int().min(1, '全新参考价至少 1 元').max(1_000_000).nullable().optional(),
    negotiationFloor: z.number().int().min(1, '最低可接受价至少 1 元').max(1_000_000).nullable().optional(), // F9，null = 关闭代谈；券类强制关闭
    handoffLocation: z.string().trim().max(100).default(''),
    handoffTime: z.string().trim().max(100).optional(),
    imageIds: z.array(z.number().int().positive()).max(5),
    // F16 券·权益
    kind: z.enum(ITEM_KINDS).default('goods').optional(),
    handoffMode: z.enum(HANDOFF_MODES).default('offline').optional(),
    /** 有效期 YYYY-MM-DD（北京时间）；null = 长期有效；实物恒为 null */
    expiresOn: z.string().regex(DATE_RE, '有效期格式应为 YYYY-MM-DD').nullable().optional(),
    /** 数量 1-10：券类 >1 时拆成多件共用 listing_group */
    quantity: z.number().int().min(1, '数量至少 1').max(10, '数量最多 10').optional(),
  })
  .refine((v) => (v.tradeType === 'free' ? v.price === 0 : v.price >= 1), {
    message: '一口价商品价格必须大于 0，免费赠送价格必须为 0',
    path: ['price'],
  })
  .refine((v) => (v.tradeType === 'fixed' ? v.negotiationFloor == null || v.negotiationFloor <= v.price : true), {
    message: '最低可接受价不能高于挂牌价',
    path: ['negotiationFloor'],
  })
  // 实物仍要求至少一张图片；券类 0-5 张可选
  .refine((v) => (v.kind === 'voucher' ? true : v.imageIds.length >= 1), {
    message: '请至少上传一张图片',
    path: ['imageIds'],
  })
  // 实物必须有交接地点；券类线上转赠允许空串（存库存空串）
  .refine((v) => (v.kind === 'voucher' && v.handoffMode === 'online' ? true : v.handoffLocation.length >= 1), {
    message: '请填写交接地点',
    path: ['handoffLocation'],
  })
  // 券类有效期必填（长期有效则为 null），且不能早于北京时间今天
  .refine((v) => (v.kind === 'voucher' && v.expiresOn != null ? v.expiresOn >= beijingToday() : true), {
    message: '有效期不能早于今天',
    path: ['expiresOn'],
  });
export type ItemInput = z.infer<typeof itemInputSchema>;

export const requestInputSchema = z.object({
  message: z.string().trim().max(200).optional(),
  negotiationId: z.number().int().positive().optional(), // F9：带上即按代谈价提交，source 记为 negotiation
});

export const listQuerySchema = z.object({
  q: z.string().trim().max(50).optional(),
  category: z.coerce.number().int().positive().optional(),
  tradeType: z.enum(TRADE_TYPES).optional(),
  kind: z.enum(ITEM_KINDS).optional(), // F16 类型筛选
  sort: z.enum(['latest', 'price_asc', 'price_desc', 'expiring']).default('latest'), // expiring：F16 即将过期（仅券类生效）
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const dateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const userInputSchema = z.object({
  employeeNo: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(50),
  department: z.string().trim().max(50).optional(),
  role: z.enum(['employee', 'admin']).default('employee'),
});

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(20),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

/**
 * GLM 连通性冒烟测试。用法：
 *   AI_API_KEY=你的key node test/ai-smoke.ts
 * 可选环境变量：AI_BASE_URL（默认 Coding Plan 端点）、AI_MODEL（默认 glm-5.3-flash）
 */
import { aiConfig, chat, extractJson } from '../src/services/ai.ts';

const cfg = aiConfig();
if (!cfg) {
  console.error('未设置 AI_API_KEY');
  process.exit(1);
}
console.log(`端点: ${cfg.baseUrl}\n模型: ${cfg.model}\n`);

const clock = () => Date.now();
const show = (name: string, ms: number, ok: boolean, detail: string) =>
  console.log(`${ok ? '✔' : '✖'} ${name}（${ms}ms） ${detail}`);

// 1. 连通性：普通对话（思考已关闭）
let t = clock();
let text = await chat(cfg, { user: '只回答两个字：收到', maxTokens: 128 });
show('连通性', clock() - t, text !== null, text === null ? '调用失败，看下面的警告输出' : `返回「${text}」`);

// 2. JSON 结构化输出：发布助手真实 prompt
t = clock();
const draftRaw = await chat(cfg, {
  system: `你是公司内部闲置物品交易平台的发布助手。用户用一句话描述要转让的闲置物品，你生成规范的商品信息。只输出一个 JSON 对象。
规则：标题不超过 30 字；描述客观、60 字以内、不编造；priceSuggestion 给人民币二手参考价区间（整数元），内部交易建议低于二手平台价；missing 列出建议补充的信息。
输出格式示例：{"title":"罗技 MX Keys 无线键盘","description":"使用约一年，功能正常，外观轻微使用痕迹。","categoryId":1,"condition":"good","priceSuggestion":{"min":180,"max":260,"reason":"二手平台约 200-300 元"},"missing":["是否附带接收器"]}`,
  user: '分类列表：1=数码电子、2=家居生活、3=运动户外、4=书籍文具、5=办公用品、6=其他\n用户输入：闲置罗技MX Keys键盘，用了一年，功能正常，轻微使用痕迹',
  maxTokens: 512,
});
const draft = extractJson<{
  title: string;
  description: string;
  categoryId: number;
  condition: string;
  priceSuggestion: { min: number; max: number; reason: string };
  missing: string[];
}>(draftRaw);
const draftOk = draft !== null && typeof draft.title === 'string' && typeof draft.categoryId === 'number';
show('JSON 结构化输出', clock() - t, draftOk, draftOk ? `「${draft!.title}」 分类id=${draft!.categoryId} 参考价 ¥${draft!.priceSuggestion?.min}-${draft!.priceSuggestion?.max}` : `原始返回：${(draftRaw ?? 'null').slice(0, 200)}`);

// 3. 语义搜索真实场景
t = clock();
const searchRaw = await chat(cfg, {
  system: `你是公司内部闲置物品交易平台的搜索助手。用户用自然语言描述需求，你从在售商品里找符合的。只输出一个 JSON 对象。matches 按相关度排序，最多 8 个，没有就空数组。reason 不超过 20 字，understanding 不超过 25 字。
输出格式示例：{"understanding":"想找腰部支撑用品","matches":[{"id":3,"reason":"人体工学护腰靠垫"}]}`,
  user: `用户搜索：办公室久坐腰疼，想找个东西舒服点，最好 100 以内\n\n在售商品（id|标题|分类|价格|描述）：\n1|戴尔 U2720Q 4K 显示器|数码电子|¥800|使用两年，功能正常\n2|人体工学护腰靠垫|办公用品|¥40|记忆棉，用了半年\n3|小米空气炸锅|家居生活|免费|用过几次\n4|迪卡侬瑜伽垫|运动户外|¥30|几乎全新`,
  maxTokens: 384,
});
const search = extractJson<{ understanding: string; matches: { id: number; reason: string }[] }>(searchRaw);
const searchOk = search !== null && Array.isArray(search!.matches) && search!.matches.some((m) => m.id === 2);
show('语义搜索（应匹配护腰靠垫）', clock() - t, searchOk, search ? `${search.understanding} → ${search.matches.map((m) => `#${m.id}(${m.reason})`).join('、')}` : `原始返回：${(searchRaw ?? 'null').slice(0, 200)}`);

// 4. 价值报告
t = clock();
const reportRaw = await chat(cfg, {
  system: '你是公司内部闲置物品交易平台的运营分析师。根据真实统计数据写 150-250 字运营价值报告，语气克制、不夸大、数字与给定一致。只输出 {"report":"..."}',
  user: JSON.stringify({ 统计范围: '2026-11-04 至 2026-11-07', 发布数: 12, 申请数: 18, 完成交易数: 5, 供需匹配率: '67%', 活跃员工数: 9, 流转金额元: 1145, 免费送出件数: 3 }),
  maxTokens: 512,
});
const report = extractJson<{ report: string }>(reportRaw);
show('价值报告', clock() - t, report !== null && (report!.report?.length ?? 0) > 50, report ? `${report.report!.slice(0, 80)}…` : `原始返回：${(reportRaw ?? 'null').slice(0, 150)}`);

// 5. 图片识别：用项目界面截图验证视觉能力（Base64 Data URL）
t = clock();
const { readFileSync } = await import('node:fs');
const pngB64 = readFileSync(new URL('../../闲置星球内部交易平台界面.png', import.meta.url)).toString('base64');
const visionRaw = await chat(cfg, {
  user: '这张截图是什么产品的界面？图里最大的标题文字是什么？只用一句话回答。',
  contentBlocks: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } }],
  maxTokens: 256,
  timeoutMs: 30_000,
});
const visionOk = visionRaw !== null && /闲置|星球/.test(visionRaw);
show('图片识别（界面截图）', clock() - t, visionOk, visionRaw === null ? '调用失败' : visionRaw.slice(0, 80));

const pass = [text, draft, search, report, visionRaw && visionOk].filter(Boolean).length;
console.log(`\n结果：${pass}/5 通过`);
if (pass < 5) console.log('部分失败不影响主流程——产品按设计会自动降级为手动填写。');

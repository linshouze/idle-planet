// F21 飞书扫码登录：授权码换身份。端点均经 2026-11-07 实测（见 AGENT-CONTEXT 时间线）。
// http 参数可注入，供测试 mock 飞书端点。

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
}

export interface FeishuIdentity {
  openId: string;
  name: string;
  employeeNo: string | null;
}

export type Http = (url: string, init?: RequestInit) => Promise<Response>;

export const feishuCallbackPath = '/api/auth/feishu/callback';

/** code → user_access_token → userinfo（open_id/name）→ tenant_token → contact 取 employee_no。
 *  任一步失败返回 null；contact 取不到 employee_no 不视为失败（范围外用户走绑定分支）。 */
export async function feishuIdentity(cfg: FeishuConfig, code: string, http: Http = fetch): Promise<FeishuIdentity | null> {
  const tokenRes = await http('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.appId,
      client_secret: cfg.appSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: cfg.baseUrl + feishuCallbackPath,
    }),
  }).catch(() => null);
  if (!tokenRes?.ok) return null;
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
  if (!token?.access_token) return null;

  const infoRes = await http('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }).catch(() => null);
  if (!infoRes?.ok) return null;
  const info = (await infoRes.json().catch(() => null)) as { code?: number; data?: { open_id?: string; name?: string } } | null;
  if (info?.code !== 0 || !info.data?.open_id) return null;
  const openId = info.data.open_id;
  const name = info.data.name ?? '';

  let employeeNo: string | null = null;
  const tenantRes = await http('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
  }).catch(() => null);
  const tenant = tenantRes?.ok
    ? ((await tenantRes.json().catch(() => null)) as { code?: number; tenant_access_token?: string } | null)
    : null;
  if (tenant?.code === 0 && tenant.tenant_access_token) {
    const contactRes = await http(`https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`, {
      headers: { Authorization: `Bearer ${tenant.tenant_access_token}` },
    }).catch(() => null);
    if (contactRes?.ok) {
      const contact = (await contactRes.json().catch(() => null)) as { code?: number; data?: { user?: { employee_no?: string } } } | null;
      if (contact?.code === 0) employeeNo = contact.data?.user?.employee_no ?? null;
    }
  }
  return { openId, name, employeeNo };
}

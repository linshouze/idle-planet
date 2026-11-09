export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const UNAUTHORIZED_EVENT = 'idle-planet:unauthorized';

export async function api<T = unknown>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }
  let res: Response;
  try {
    res = await fetch(path, { method: init.method ?? 'GET', headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', '无法连接服务器，请检查网络后重试');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? `请求失败（${res.status}）`);
  }
  return (await res.json()) as T;
}

export const post = <T = { ok: true }>(path: string, json: unknown = {}) => api<T>(path, { method: 'POST', json });
export const patch = <T = { ok: true }>(path: string, json: unknown) => api<T>(path, { method: 'PATCH', json });

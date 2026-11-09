export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = '资源') => new AppError(404, 'NOT_FOUND', `${what}不存在`);
export const forbidden = (message = '没有权限执行此操作') => new AppError(403, 'FORBIDDEN', message);

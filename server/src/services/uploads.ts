import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../errors.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 通过文件头判断真实类型，不信任客户端声明的 MIME。 */
export function detectImageExt(buf: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (
    buf.length >= 12 &&
    String.fromCharCode(...buf.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...buf.slice(8, 12)) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function saveImage(db: DatabaseSync, uploadDir: string, uploaderId: number, buf: Uint8Array): { id: number; url: string } {
  if (buf.length === 0) throw new AppError(400, 'INVALID_IMAGE', '图片为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new AppError(413, 'IMAGE_TOO_LARGE', '图片不能超过 5MB');
  const ext = detectImageExt(buf);
  if (!ext) throw new AppError(400, 'INVALID_IMAGE', '仅支持 JPG、PNG、WebP 图片');

  mkdirSync(uploadDir, { recursive: true });
  const file = `${randomBytes(16).toString('hex')}.${ext}`;
  writeFileSync(join(uploadDir, file), buf);
  // 先写文件再写库：写库失败只会留下孤儿文件，不会出现指向不存在文件的记录。
  const r = db.prepare('INSERT INTO item_images (uploader_id, path) VALUES (?, ?)').run(uploaderId, file);
  return { id: Number(r.lastInsertRowid), url: `/api/uploads/${file}` };
}

export const SAFE_IMAGE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * 基于本地主密钥的 AES-256-GCM 加解密。
 * 主密钥默认取自环境变量 MTask_MASTER_KEY；未设置时用本机指纹派生（仅骨架阶段兜底，生产应显式配置）。
 */
function masterKey(): Buffer {
  const env = process.env.MTask_MASTER_KEY;
  const seed = env || `${process.platform}-${process.env.COMPUTERNAME ?? 'mtask-local'}`;
  return createHash('sha256').update(seed).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = createDecipheriv(ALGO, masterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

export function maskSecret(plain: string): string {
  if (plain.length <= 8) return '****';
  return `${plain.slice(0, 4)}****${plain.slice(-4)}`;
}

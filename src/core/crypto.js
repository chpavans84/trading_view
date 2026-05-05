import crypto from 'crypto';

const KEY  = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY || '', 'hex');
const ALGO = 'aes-256-gcm';

export function encryptCredential(plaintext) {
  if (!plaintext) return null;
  if (KEY.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  const iv      = crypto.randomBytes(12);
  const cipher  = crypto.createCipheriv(ALGO, KEY, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag     = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptCredential(ciphertext) {
  if (!ciphertext) return null;
  // Legacy plaintext — not yet in iv:tag:enc format; pass through on read, re-encrypt on next save
  if (!ciphertext.includes(':')) return ciphertext;
  if (KEY.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  const [ivHex, tagHex, encHex] = ciphertext.split(':');
  const iv       = Buffer.from(ivHex,  'hex');
  const tag      = Buffer.from(tagHex, 'hex');
  const enc      = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}

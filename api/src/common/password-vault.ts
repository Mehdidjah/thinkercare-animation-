import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {fail} from './errors';

// Separate from the login hash. Only the admin-only, reauthenticated endpoint
// may decrypt this copy. Keep the key outside the database and source control.
function key(): Buffer {
  const value = process.env.ACCOUNT_PASSWORD_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    fail('La gestion sécurisée des mots de passe est momentanément indisponible.', 503);
  }
  return Buffer.from(value, 'hex');
}

export function sealPassword(userId: string, password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from('tf_users:' + userId));
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function openPassword(userId: string, sealed: string): string {
  const encryptionKey = key();
  try {
    const [version, iv, tag, data, extra] = sealed.split('.');
    if (version !== 'v1' || extra !== undefined || !iv || !tag || !data) throw new Error('Invalid envelope');
    const ivBytes = Buffer.from(iv, 'base64url');
    const tagBytes = Buffer.from(tag, 'base64url');
    if (ivBytes.length !== 12 || tagBytes.length !== 16) throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, ivBytes, {authTagLength: 16});
    decipher.setAAD(Buffer.from('tf_users:' + userId));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    fail('Ce mot de passe ne peut pas être consulté. Vous pouvez le réinitialiser.', 503);
  }
}

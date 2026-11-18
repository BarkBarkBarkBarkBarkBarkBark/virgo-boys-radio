/**
 * Signed, short-lived first-party admin session, verified by both Next
 * middleware (Edge runtime) and Node route handlers.
 */
export const ADMIN_COOKIE = 'virgo_admin_session';
export const SESSION_SECONDS = 8 * 60 * 60;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => parseInt(pair, 16));
}

async function key() {
  const secret = process.env.OPS_SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('OPS_SESSION_SECRET is missing or too short');
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createAdminSession(): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = 'v1.' + expires + '.' + crypto.randomUUID();
  const signature = await crypto.subtle.sign('HMAC', await key(), new TextEncoder().encode(payload));
  return payload + '.' + bytesToHex(new Uint8Array(signature));
}

export async function verifyAdminSession(token: string | undefined): Promise<boolean> {
  if (!token || token.length > 250) return false;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d{10}$/.test(parts[1] ?? '')) return false;
  const expires = Number(parts[1]);
  if (expires <= Date.now() / 1000 || expires > Date.now() / 1000 + SESSION_SECONDS) return false;
  if (!/^[a-f0-9-]{36}$/.test(parts[2] ?? '')) return false;
  const signature = hexToBytes(parts[3] ?? '');
  if (!signature) return false;
  try {
    return await crypto.subtle.verify('HMAC', await key(), signature.buffer as ArrayBuffer,
      new TextEncoder().encode(parts.slice(0, 3).join('.')));
  } catch {
    return false;
  }
}

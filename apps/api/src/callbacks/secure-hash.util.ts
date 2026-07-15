import { createHmac } from 'crypto';

export function computeSecureHash(payload: Record<string, unknown>, secretKey: Uint8Array): string {
  const keys = Object.keys(payload)
    .filter((key) => key !== 'secureHash')
    .sort();
  const concatenated = keys.map((key) => String(payload[key] ?? '')).join('');
  return createHmac('sha256', secretKey).update(concatenated).digest('hex').toLowerCase();
}

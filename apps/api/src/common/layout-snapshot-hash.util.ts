import * as crypto from 'crypto';

// Q-4 / D-95: the ONE implementation of Bill.layoutSnapshot's tamper-evidence
// hash — imported by both the write path (callbacks.service.ts's P-1,
// bills.service.ts's P-2, each writing Bill.layoutSnapshotHash once at
// creation) and pnpm verify's immutability check (reading it back). Never
// duplicate this function; a second copy could silently drift and defeat the
// guarantee it exists to provide.
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashSnapshot(snapshot: unknown): string {
  return crypto.createHash('sha256').update(canonicalStringify(snapshot)).digest('hex');
}

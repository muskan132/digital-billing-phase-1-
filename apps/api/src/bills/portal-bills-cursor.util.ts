// H-1 / D-58: opaque keyset cursor — base64 JSON of the last row's own
// (createdAt, id), the exact pair GET /portal/bills sorts and tie-breaks
// on. Opaque so a caller can't hand-craft or nudge it; malformed input
// throws rather than silently producing a wrong page.
export interface PortalBillsCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: PortalBillsCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id })).toString('base64url');
}

export function decodeCursor(raw: string): PortalBillsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('malformed cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).createdAt !== 'string' ||
    typeof (parsed as Record<string, unknown>).id !== 'string'
  ) {
    throw new Error('malformed cursor');
  }
  const createdAt = new Date((parsed as { createdAt: string }).createdAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error('malformed cursor');
  }
  return { createdAt, id: (parsed as { id: string }).id };
}

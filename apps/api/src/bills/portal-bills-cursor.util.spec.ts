import { decodeCursor, encodeCursor } from './portal-bills-cursor.util';

describe('portal-bills-cursor.util (H-1 / D-58)', () => {
  it('round-trips createdAt and id exactly', () => {
    const createdAt = new Date('2026-08-01T12:34:56.789Z');
    const encoded = encodeCursor({ createdAt, id: 'bill-abc123' });
    const decoded = decodeCursor(encoded);
    expect(decoded.id).toBe('bill-abc123');
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it('is opaque — not plain JSON/base64 a caller would casually recognize as editable', () => {
    const encoded = encodeCursor({ createdAt: new Date('2026-08-01T00:00:00.000Z'), id: 'x' });
    expect(encoded).not.toContain('{');
    expect(encoded).not.toContain('createdAt');
  });

  it('throws on malformed base64/JSON rather than silently producing a wrong page', () => {
    expect(() => decodeCursor('not-valid-base64-json!!!')).toThrow();
  });

  it('throws when required fields are missing', () => {
    const badEncoded = Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url');
    expect(() => decodeCursor(badEncoded)).toThrow();
  });

  it('throws when createdAt is not a parseable date', () => {
    const badEncoded = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'x' })).toString('base64url');
    expect(() => decodeCursor(badEncoded)).toThrow();
  });
});

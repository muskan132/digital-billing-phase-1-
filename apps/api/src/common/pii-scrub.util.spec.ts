import { scrubPiiDeep, scrubPiiFromText } from './pii-scrub.util';

describe('scrubPiiFromText', () => {
  it('masks a mobile number substring embedded inside a larger free-text string', () => {
    const text = 'customerMobile_pii: "9876543210", something: "else"';
    const scrubbed = scrubPiiFromText(text);
    expect(scrubbed).not.toContain('9876543210');
    expect(scrubbed).not.toContain('876543'); // no partial digit-run leak either
    expect(scrubbed).toContain('98'); // maskMobile keeps first/last 2 chars — same algorithm, reused
    expect(scrubbed).toContain('10');
  });

  it('masks an email substring embedded inside a larger free-text string', () => {
    const text = 'customerEmail_pii: "realcustomer@example.com", other: 1';
    const scrubbed = scrubPiiFromText(text);
    expect(scrubbed).not.toContain('realcustomer@example.com');
    expect(scrubbed).not.toContain('realcustomer'); // local part fully gone, not just partially
    expect(scrubbed).toContain('@example.com'); // maskEmail keeps the domain — same algorithm, reused
  });

  it('masks both a mobile and an email in the same multi-line pretty-printed dump (the real PrismaClientValidationError shape)', () => {
    const text = [
      'Invalid `prisma.order.create()` invocation',
      'data: {',
      '  customerMobile_pii: "9876543210",',
      '  customerEmail_pii: "realcustomer@example.com",',
      '}',
    ].join('\n');
    const scrubbed = scrubPiiFromText(text);
    expect(scrubbed).not.toContain('9876543210');
    expect(scrubbed).not.toContain('realcustomer@example.com');
    expect(scrubbed).not.toContain('realcustomer');
  });

  it('does not touch text with no PII-shaped substrings', () => {
    const text = 'Unique constraint failed on the fields: (`txnId`)';
    expect(scrubPiiFromText(text)).toBe(text);
  });

  it('an email containing a 10-digit local part is scrubbed as an email, not double-processed by the mobile pattern', () => {
    const text = 'contact: "9876543210x@example.com"';
    const scrubbed = scrubPiiFromText(text);
    expect(scrubbed).not.toContain('9876543210');
    expect(scrubbed).toContain('@example.com');
  });
});

describe('scrubPiiDeep', () => {
  it('scrubs a string value nested inside a plain object (the meta.message shape confirmed live for P2010)', () => {
    const meta = { code: '22003', message: 'ERROR: value "9876543210" is out of range for type integer' };
    const scrubbed = scrubPiiDeep(meta) as typeof meta;
    expect(scrubbed.code).toBe('22003');
    expect(scrubbed.message).not.toContain('9876543210');
  });

  it('scrubs a string value nested inside an array inside an object', () => {
    const meta = { target: ['txnId'], nested: { list: ['contact realcustomer@example.com here'] } };
    const scrubbed = scrubPiiDeep(meta) as { target: string[]; nested: { list: string[] } };
    expect(scrubbed.target).toEqual(['txnId']); // field names untouched — no PII pattern matches
    expect(scrubbed.nested.list[0]).not.toContain('realcustomer@example.com');
  });

  it('leaves non-string primitives untouched', () => {
    const meta = { count: 5, ok: true, missing: null, whatever: undefined };
    expect(scrubPiiDeep(meta)).toEqual(meta);
  });
});

import { PREVIEW_FIXTURES } from './preview-fixtures';

// D-17 ∪ D-28's full Bill.snapshot whitelist (the maximal set any snapshot —
// RECEIPT or TAX_INVOICE — may ever carry). A fixture's key set must be a
// SUBSET of this, not necessarily equal to it — TAX_INVOICE fixtures never use
// the RECEIPT-only PG-callback fields (paymentMode, receiptNumber, etc.).
const SNAPSHOT_WHITELIST = new Set([
  'merchantName',
  'amountPaise',
  'currency',
  'paymentMode',
  'paymentDateTime',
  'receiptNumber',
  'merchantTxnNo',
  'cardNetwork',
  'paymentInstId',
  'respDescription',
  'invoiceNumber',
  'placeOfSupply',
  'merchantGstin',
  'merchantState',
  'merchantAddress',
  'subtotalPaise',
  'discountPaise',
  'taxPaise',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
  'items',
]);

// D-28's exact items[] member shape — not a subset here, this one IS the whole set.
const ITEM_WHITELIST = new Set([
  'lineNo',
  'name',
  'hsn',
  'uom',
  'quantity',
  'unitPricePaise',
  'itemDiscountPaise',
  'billDiscountAllocPaise',
  'taxRateBp',
  'taxableValuePaise',
  'taxPaise',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
]);

const FIXTURE_KEYS = Object.keys(PREVIEW_FIXTURES) as (keyof typeof PREVIEW_FIXTURES)[];

describe('PREVIEW_FIXTURES (F-1 / D-35)', () => {
  it('covers at least the required fixture set', () => {
    expect(FIXTURE_KEYS.sort()).toEqual(['INTER_STATE_IGST', 'LONG_40_LINES', 'MINIMAL', 'TYPICAL', 'ZERO_RATED'].sort());
  });

  describe.each(FIXTURE_KEYS)('%s', (key) => {
    const fixture = PREVIEW_FIXTURES[key];

    it('has at least one line item', () => {
      expect(fixture.items.length).toBeGreaterThan(0);
    });

    it('every per-line tax figure sums exactly to the fixture total (BigInt-exact, no float)', () => {
      const sumTax = fixture.items.reduce((acc, i) => acc + BigInt(i.taxPaise), 0n);
      const sumCgst = fixture.items.reduce((acc, i) => acc + BigInt(i.cgstPaise), 0n);
      const sumSgst = fixture.items.reduce((acc, i) => acc + BigInt(i.sgstPaise), 0n);
      const sumIgst = fixture.items.reduce((acc, i) => acc + BigInt(i.igstPaise), 0n);
      const sumTaxableAndTax = fixture.items.reduce((acc, i) => acc + BigInt(i.taxableValuePaise) + BigInt(i.taxPaise), 0n);

      expect(sumTax).toBe(BigInt(fixture.taxPaise));
      expect(sumCgst).toBe(BigInt(fixture.cgstPaise));
      expect(sumSgst).toBe(BigInt(fixture.sgstPaise));
      expect(sumIgst).toBe(BigInt(fixture.igstPaise));
      // CGST + SGST + IGST must account for the whole tax figure too (D-24: a
      // line is either intra-state (CGST+SGST) or inter-state (IGST), never both).
      expect(sumCgst + sumSgst + sumIgst).toBe(BigInt(fixture.taxPaise));
      expect(sumTaxableAndTax).toBe(BigInt(fixture.amountPaise));
    });

    it('the top-level key set is a subset of the D-17/D-28 Bill.snapshot whitelist', () => {
      for (const k of Object.keys(fixture)) {
        expect(SNAPSHOT_WHITELIST.has(k)).toBe(true);
      }
    });

    it("every items[] member's key set exactly matches D-28's whitelist — no extra, no missing", () => {
      for (const item of fixture.items) {
        expect(new Set(Object.keys(item))).toEqual(ITEM_WHITELIST);
      }
    });
  });

  it('INTER_STATE_IGST actually exercises the IGST branch (CGST/SGST are zero)', () => {
    const fixture = PREVIEW_FIXTURES.INTER_STATE_IGST;
    expect(BigInt(fixture.cgstPaise)).toBe(0n);
    expect(BigInt(fixture.sgstPaise)).toBe(0n);
    expect(BigInt(fixture.igstPaise)).toBeGreaterThan(0n);
  });

  it('ZERO_RATED actually has zero tax throughout, not just a zero total by coincidence', () => {
    const fixture = PREVIEW_FIXTURES.ZERO_RATED;
    expect(fixture.items.every((i) => i.taxRateBp === 0)).toBe(true);
    expect(BigInt(fixture.taxPaise)).toBe(0n);
  });

  it('LONG_40_LINES actually has 40 lines', () => {
    expect(PREVIEW_FIXTURES.LONG_40_LINES.items).toHaveLength(40);
  });

  it('MINIMAL has exactly one line', () => {
    expect(PREVIEW_FIXTURES.MINIMAL.items).toHaveLength(1);
  });

  it('contains no real customer data — no email, no phone-number-shaped string, no customer-identifying keys anywhere', () => {
    const serialized = JSON.stringify(PREVIEW_FIXTURES);
    expect(serialized).not.toMatch(/@/); // no email addresses anywhere
    expect(serialized).not.toMatch(/\b[6-9]\d{9}\b/); // no Indian-mobile-shaped 10-digit string
    expect(serialized).not.toMatch(/customerMobile|customerEmail/i); // no customer PII field names at all
  });
});

import fc from 'fast-check';
import { computeInvoice, InvoiceLineInput } from './invoice-calc';

function line(overrides: Partial<InvoiceLineInput> & { lineNo: number }): InvoiceLineInput {
  return {
    quantity: 1,
    unitPricePaise: 0n,
    itemDiscountPaise: 0n,
    taxRateBp: 0,
    ...overrides,
  };
}

describe('computeInvoice', () => {
  it('handles mixed tax rates in one bill', () => {
    const result = computeInvoice(
      [
        line({ lineNo: 1, quantity: 2, unitPricePaise: 10000n, taxRateBp: 500 }), // 5%
        line({ lineNo: 2, quantity: 1, unitPricePaise: 5000n, taxRateBp: 1800 }), // 18%
      ],
      0n,
      '27',
      '27',
    );

    // Line 1: gross=20000, tax=20000*500/10000=1000
    expect(result.lines[0].taxPaise).toBe(1000n);
    // Line 2: gross=5000, tax=5000*1800/10000=900
    expect(result.lines[1].taxPaise).toBe(900n);
    expect(result.taxPaise).toBe(1900n);
    expect(result.totalPaise).toBe(20000n + 5000n + 1900n);
  });

  it('rounds a tax landing exactly on a half-paise, half-up', () => {
    // taxable=1, rate=5000bp (50%): 1*5000=5000, +5000=10000, /10000 = 1 (0.5 rounds up)
    const result = computeInvoice([line({ lineNo: 1, quantity: 1, unitPricePaise: 1n, taxRateBp: 5000 })], 0n, '27', '27');
    expect(result.lines[0].taxPaise).toBe(1n);
  });

  it('splits an odd line tax into CGST/SGST that sum exactly to the line tax (intra-state)', () => {
    // taxable=100, rate=700bp (7%): tax = (100*700+5000)/10000 = 75000/10000 = 7 (odd)
    const result = computeInvoice([line({ lineNo: 1, quantity: 1, unitPricePaise: 100n, taxRateBp: 700 })], 0n, '27', '27');
    const l = result.lines[0];
    expect(l.taxPaise).toBe(7n);
    expect(l.cgstPaise + l.sgstPaise).toBe(l.taxPaise);
    expect(l.igstPaise).toBe(0n);
    // No paise created or lost, and cgst gets the extra on an odd split
    expect(l.cgstPaise).toBe(4n);
    expect(l.sgstPaise).toBe(3n);
  });

  it('splits into IGST only for an inter-state bill', () => {
    const result = computeInvoice([line({ lineNo: 1, quantity: 1, unitPricePaise: 100n, taxRateBp: 700 })], 0n, '29', '27');
    const l = result.lines[0];
    expect(l.igstPaise).toBe(l.taxPaise);
    expect(l.cgstPaise).toBe(0n);
    expect(l.sgstPaise).toBe(0n);
  });

  it('allocates a bill discount whose residual is smaller than the line count via largest-remainder, lineNo tie-break', () => {
    // Three equal-value lines (afterItem = 100 each, sum = 300); discount = 100.
    // rawAlloc[i] = floor(100*100/300) = 33 each, sum=99, residual=1 -> goes to lineNo 1
    // (all remainders equal here, so the ascending-lineNo tie-break decides).
    const result = computeInvoice(
      [
        line({ lineNo: 1, quantity: 1, unitPricePaise: 100n }),
        line({ lineNo: 2, quantity: 1, unitPricePaise: 100n }),
        line({ lineNo: 3, quantity: 1, unitPricePaise: 100n }),
      ],
      100n,
      '27',
      '27',
    );

    const allocs = result.lines.map((l) => l.billDiscountAllocPaise);
    expect(allocs.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(allocs).toEqual([34n, 33n, 33n]); // lineNo 1 gets the residual paise
  });

  it('accepts taxRateBp = 0 as a valid zero rate', () => {
    const result = computeInvoice([line({ lineNo: 1, quantity: 1, unitPricePaise: 1000n, taxRateBp: 0 })], 0n, '27', '27');
    expect(result.lines[0].taxPaise).toBe(0n);
    expect(result.totalPaise).toBe(1000n);
  });

  it('handles a fully-discounted (zero-value) bill', () => {
    const result = computeInvoice(
      [line({ lineNo: 1, quantity: 2, unitPricePaise: 500n, itemDiscountPaise: 1000n, taxRateBp: 1800 })],
      0n,
      '27',
      '27',
    );
    expect(result.lines[0].taxableValuePaise).toBe(0n);
    expect(result.lines[0].taxPaise).toBe(0n);
    expect(result.totalPaise).toBe(0n);
  });

  it('handles a single line', () => {
    const result = computeInvoice([line({ lineNo: 1, quantity: 3, unitPricePaise: 250n, taxRateBp: 1200 })], 0n, '27', '27');
    expect(result.lines).toHaveLength(1);
    expect(result.subtotalPaise).toBe(750n);
  });

  it('handles 100 lines', () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      line({ lineNo: i + 1, quantity: (i % 5) + 1, unitPricePaise: BigInt(100 + i), taxRateBp: (i % 3) * 500 }),
    );
    const result = computeInvoice(lines, 500n, '27', '27');
    expect(result.lines).toHaveLength(100);
    expect(result.totalPaise).toBe(result.lines.reduce((acc, l) => acc + l.taxableValuePaise + l.taxPaise, 0n));
  });

  it('throws on quantity < 1', () => {
    expect(() => computeInvoice([line({ lineNo: 1, quantity: 0 })], 0n, '27', '27')).toThrow(/quantity/);
  });

  it('throws on negative unitPricePaise', () => {
    expect(() => computeInvoice([line({ lineNo: 1, unitPricePaise: -1n })], 0n, '27', '27')).toThrow(/unitPricePaise/);
  });

  it('throws on itemDiscountPaise exceeding gross', () => {
    expect(() =>
      computeInvoice([line({ lineNo: 1, quantity: 1, unitPricePaise: 100n, itemDiscountPaise: 101n })], 0n, '27', '27'),
    ).toThrow(/itemDiscountPaise/);
  });

  it('throws on negative taxRateBp', () => {
    expect(() => computeInvoice([line({ lineNo: 1, taxRateBp: -1 })], 0n, '27', '27')).toThrow(/taxRateBp/);
  });

  it('throws when billDiscountPaise exceeds total post-item-discount value', () => {
    expect(() =>
      computeInvoice([line({ lineNo: 1, quantity: 1, unitPricePaise: 100n })], 101n, '27', '27'),
    ).toThrow(/billDiscountPaise/);
  });

  it('property: taxable + tax always equals total, and per-line CGST+SGST+IGST always equals line tax', () => {
    const lineArb = fc.record({
      lineNo: fc.integer({ min: 1, max: 1000 }),
      quantity: fc.integer({ min: 1, max: 50 }),
      unitPricePaise: fc.bigInt({ min: 0n, max: 100000n }),
      taxRateBp: fc.integer({ min: 0, max: 2800 }),
    });

    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 20 }).map((ls) => ls.map((l, i) => ({ ...l, lineNo: i + 1 }))),
        fc.boolean(),
        (rawLines, intraState) => {
          const lines: InvoiceLineInput[] = rawLines.map((l) => ({ ...l, itemDiscountPaise: 0n }));
          const result = computeInvoice(lines, 0n, intraState ? '27' : '29', '27');

          const sumTaxableAndTax = result.lines.reduce((acc, l) => acc + l.taxableValuePaise + l.taxPaise, 0n);
          expect(sumTaxableAndTax).toBe(result.totalPaise);

          for (const l of result.lines) {
            expect(l.cgstPaise + l.sgstPaise + l.igstPaise).toBe(l.taxPaise);
          }
        },
      ),
    );
  });

  it('property (D-23): bill discount allocations always sum exactly to billDiscountPaise and never over/under-allocate a line', () => {
    const lineArb = fc.record({
      lineNo: fc.integer({ min: 1, max: 1000 }),
      quantity: fc.integer({ min: 1, max: 50 }),
      unitPricePaise: fc.bigInt({ min: 0n, max: 100000n }),
      taxRateBp: fc.integer({ min: 0, max: 2800 }),
    });

    const caseArb = fc
      .array(lineArb, { minLength: 1, maxLength: 20 })
      .map((ls) => ls.map((l, i) => ({ ...l, lineNo: i + 1, itemDiscountPaise: 0n })))
      .chain((lines) => {
        const sumAfterItem = lines.reduce((acc, l) => acc + BigInt(l.quantity) * l.unitPricePaise, 0n);
        return fc.record({
          lines: fc.constant(lines),
          billDiscountPaise: fc.bigInt({ min: 0n, max: sumAfterItem }),
        });
      });

    fc.assert(
      fc.property(caseArb, fc.boolean(), ({ lines, billDiscountPaise }, intraState) => {
        const result = computeInvoice(lines, billDiscountPaise, intraState ? '27' : '29', '27');

        const sumAlloc = result.lines.reduce((acc, l) => acc + l.billDiscountAllocPaise, 0n);
        expect(sumAlloc).toBe(billDiscountPaise);

        for (const l of result.lines) {
          expect(l.billDiscountAllocPaise).toBeGreaterThanOrEqual(0n);
          expect(l.billDiscountAllocPaise).toBeLessThanOrEqual(l.afterItemDiscountPaise);
        }
      }),
    );
  });
});

import { computeInvoice, InvoiceLineInput, InvoiceResult } from './invoice-calc';
import { CalcMismatch, SuppliedTotals, validateCalculation } from './calc-validate';

function line(overrides: Partial<InvoiceLineInput> & { lineNo: number }): InvoiceLineInput {
  return {
    quantity: 1,
    unitPricePaise: 0n,
    itemDiscountPaise: 0n,
    taxRateBp: 0,
    ...overrides,
  };
}

function suppliedFrom(result: InvoiceResult): SuppliedTotals {
  return {
    subtotalPaise: result.subtotalPaise,
    discountPaise: result.discountPaise,
    taxPaise: result.taxPaise,
    cgstPaise: result.cgstPaise,
    sgstPaise: result.sgstPaise,
    igstPaise: result.igstPaise,
    totalPaise: result.totalPaise,
    lines: result.lines.map((l) => ({
      lineNo: l.lineNo,
      taxPaise: l.taxPaise,
      cgstPaise: l.cgstPaise,
      sgstPaise: l.sgstPaise,
      igstPaise: l.igstPaise,
    })),
  };
}

describe('validateCalculation', () => {
  const lines = [
    line({ lineNo: 1, quantity: 2, unitPricePaise: 10000n, taxRateBp: 500 }),
    line({ lineNo: 2, quantity: 1, unitPricePaise: 5000n, taxRateBp: 1800 }),
  ];

  it('passes an exact payload and returns the computed result', () => {
    const expected = computeInvoice(lines, 0n, '27', '27');
    const result = validateCalculation(lines, 0n, '27', '27', suppliedFrom(expected));
    expect(result.totalPaise).toBe(expected.totalPaise);
  });

  it('rejects a total off by one paise, naming totalPaise', () => {
    const expected = computeInvoice(lines, 0n, '27', '27');
    const supplied = suppliedFrom(expected);
    supplied.totalPaise += 1n;

    try {
      validateCalculation(lines, 0n, '27', '27', supplied);
      fail('expected CalcMismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(CalcMismatch);
      expect((err as CalcMismatch).field).toBe('totalPaise');
    }
  });

  it('rejects a bill-level tax off by one paise, naming taxPaise', () => {
    const expected = computeInvoice(lines, 0n, '27', '27');
    const supplied = suppliedFrom(expected);
    supplied.taxPaise += 1n;

    try {
      validateCalculation(lines, 0n, '27', '27', supplied);
      fail('expected CalcMismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(CalcMismatch);
      expect((err as CalcMismatch).field).toBe('taxPaise');
    }
  });

  it('rejects a single line tax off by one paise, naming that line', () => {
    const expected = computeInvoice(lines, 0n, '27', '27');
    const supplied = suppliedFrom(expected);
    supplied.lines[1].taxPaise += 1n;

    try {
      validateCalculation(lines, 0n, '27', '27', supplied);
      fail('expected CalcMismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(CalcMismatch);
      expect((err as CalcMismatch).field).toBe('lines[2].taxPaise');
    }
  });

  it('rejects a wrong CGST/SGST split even when the line tax total is correct, naming cgstPaise', () => {
    // taxable=100, rate=700bp (7%): tax=7 (odd), correctly split cgst=4/sgst=3 (D-24).
    const splitLines = [line({ lineNo: 1, quantity: 1, unitPricePaise: 100n, taxRateBp: 700 })];
    const expected = computeInvoice(splitLines, 0n, '27', '27');
    const supplied = suppliedFrom(expected);
    // Reverse the split without changing taxPaise, so a taxPaise-only check would miss it.
    supplied.lines[0].cgstPaise = expected.lines[0].sgstPaise;
    supplied.lines[0].sgstPaise = expected.lines[0].cgstPaise;

    try {
      validateCalculation(splitLines, 0n, '27', '27', supplied);
      fail('expected CalcMismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(CalcMismatch);
      expect((err as CalcMismatch).field).toBe('lines[1].cgstPaise');
    }
  });

  it('wraps a negative unit price as CalcMismatch, not a raw Error', () => {
    const badLines = [line({ lineNo: 1, unitPricePaise: -1n })];
    const supplied = suppliedFrom(computeInvoice(lines, 0n, '27', '27'));

    try {
      validateCalculation(badLines, 0n, '27', '27', supplied);
      fail('expected CalcMismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(CalcMismatch);
      const cm = err as CalcMismatch;
      expect(cm.field).toBe('lines[1].unitPricePaise');
      expect(cm.expected).toBe('>= 0');
      expect(cm.supplied).toBe('-1');
    }
  });

  it('wraps an item discount exceeding line gross as CalcMismatch, not a raw Error', () => {
    const badLines = [line({ lineNo: 1, quantity: 1, unitPricePaise: 100n, itemDiscountPaise: 101n })];
    const supplied = suppliedFrom(computeInvoice(lines, 0n, '27', '27'));

    try {
      validateCalculation(badLines, 0n, '27', '27', supplied);
      fail('expected CalcMismatch');
    } catch (err) {
      expect(err).toBeInstanceOf(CalcMismatch);
      const cm = err as CalcMismatch;
      expect(cm.field).toBe('lines[1].itemDiscountPaise');
      expect(cm.expected).toBe('<= gross (100)');
      expect(cm.supplied).toBe('101');
    }
  });
});

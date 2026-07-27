// M-3: validates caller-supplied totals/tax_block against M-2's recomputed ladder
// (D-21, D-22 step 8). No I/O, no Prisma, no framework — same constraints as M-2.

import { computeInvoice, InvoiceLineInput, InvoiceResult } from './invoice-calc';

export class CalcMismatch extends Error {
  readonly field: string;
  readonly expected: string;
  readonly supplied: string;

  constructor(field: string, expected: string, supplied: string) {
    super(`CALC_MISMATCH: ${field} expected ${expected}, got ${supplied}`);
    this.name = 'CalcMismatch';
    this.field = field;
    this.expected = expected;
    this.supplied = supplied;
  }
}

export interface SuppliedLineTotals {
  lineNo: number;
  taxPaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
}

export interface SuppliedTotals {
  subtotalPaise: bigint;
  discountPaise: bigint;
  taxPaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalPaise: bigint;
  lines: SuppliedLineTotals[];
}

// computeInvoice's structural rejections (D-22 step 1/2/4) are plain Errors with a fixed
// message shape. Parsed exactly once, here, so no downstream caller (I-1) has to
// regex-match error messages to build a 422 body — everyone gets CalcMismatch instead.
const LINE_QUANTITY = /^Line (\d+): quantity must be >= 1, got (-?\d+)$/;
const LINE_UNIT_PRICE = /^Line (\d+): unitPricePaise must be >= 0, got (-?\d+)$/;
const LINE_TAX_RATE = /^Line (\d+): taxRateBp must be >= 0, got (-?\d+)$/;
const LINE_ITEM_DISCOUNT = /^Line (\d+): itemDiscountPaise \((-?\d+)\) exceeds gross \((-?\d+)\)$/;
const BILL_DISCOUNT = /^billDiscountPaise \((-?\d+)\) exceeds total post-item-discount value \((-?\d+)\)$/;

function wrapStructuralError(err: unknown): never {
  if (!(err instanceof Error)) throw err;

  let m = err.message.match(LINE_QUANTITY);
  if (m) throw new CalcMismatch(`lines[${m[1]}].quantity`, '>= 1', m[2]);

  m = err.message.match(LINE_UNIT_PRICE);
  if (m) throw new CalcMismatch(`lines[${m[1]}].unitPricePaise`, '>= 0', m[2]);

  m = err.message.match(LINE_TAX_RATE);
  if (m) throw new CalcMismatch(`lines[${m[1]}].taxRateBp`, '>= 0', m[2]);

  m = err.message.match(LINE_ITEM_DISCOUNT);
  if (m) throw new CalcMismatch(`lines[${m[1]}].itemDiscountPaise`, `<= gross (${m[3]})`, m[2]);

  m = err.message.match(BILL_DISCOUNT);
  if (m) throw new CalcMismatch('billDiscountPaise', `<= total post-item-discount value (${m[2]})`, m[1]);

  throw err;
}

export function validateCalculation(
  lines: InvoiceLineInput[],
  billDiscountPaise: bigint,
  placeOfSupply: string,
  merchantGstStateCode: string,
  supplied: SuppliedTotals,
): InvoiceResult {
  let result: InvoiceResult;
  try {
    result = computeInvoice(lines, billDiscountPaise, placeOfSupply, merchantGstStateCode);
  } catch (err) {
    wrapStructuralError(err);
  }

  const suppliedByLineNo = new Map(supplied.lines.map((l) => [l.lineNo, l]));
  for (const line of result.lines) {
    const s = suppliedByLineNo.get(line.lineNo);
    if (!s) {
      throw new CalcMismatch(`lines[${line.lineNo}]`, 'present in supplied totals', 'missing');
    }
    if (line.taxPaise !== s.taxPaise) {
      throw new CalcMismatch(`lines[${line.lineNo}].taxPaise`, line.taxPaise.toString(), s.taxPaise.toString());
    }
    if (line.cgstPaise !== s.cgstPaise) {
      throw new CalcMismatch(`lines[${line.lineNo}].cgstPaise`, line.cgstPaise.toString(), s.cgstPaise.toString());
    }
    if (line.sgstPaise !== s.sgstPaise) {
      throw new CalcMismatch(`lines[${line.lineNo}].sgstPaise`, line.sgstPaise.toString(), s.sgstPaise.toString());
    }
    if (line.igstPaise !== s.igstPaise) {
      throw new CalcMismatch(`lines[${line.lineNo}].igstPaise`, line.igstPaise.toString(), s.igstPaise.toString());
    }
  }

  // D-22 step 8: bill-level fields, compared in this exact order.
  const billLevel: Array<[string, bigint, bigint]> = [
    ['subtotalPaise', result.subtotalPaise, supplied.subtotalPaise],
    ['discountPaise', result.discountPaise, supplied.discountPaise],
    ['taxPaise', result.taxPaise, supplied.taxPaise],
    ['cgstPaise', result.cgstPaise, supplied.cgstPaise],
    ['sgstPaise', result.sgstPaise, supplied.sgstPaise],
    ['igstPaise', result.igstPaise, supplied.igstPaise],
    ['totalPaise', result.totalPaise, supplied.totalPaise],
  ];
  for (const [field, expected, sup] of billLevel) {
    if (expected !== sup) {
      throw new CalcMismatch(field, expected.toString(), sup.toString());
    }
  }

  return result;
}

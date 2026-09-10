import * as fs from 'fs';
import * as path from 'path';
import {
  BILLS_CSV_FULL_HEADERS,
  BILLS_CSV_MASKED_HEADERS,
  serializeBillsCsv,
  serializeBillsFull,
  serializeBillsMasked,
} from './bills-export-csv.util';
import { ExportBillRow } from './portal-bills.service';

const RAW_MOBILE = '9876543210';
const RAW_EMAIL = 'anna@example.com';

function row(overrides: Partial<ExportBillRow> = {}): ExportBillRow {
  return {
    id: 'bill-1',
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    billType: 'TAX_INVOICE',
    source: 'DIRECT_API',
    invoiceNumber: 'INV-1',
    totalPaise: 10700n,
    currency: 'INR',
    deliveryStatus: 'SENT',
    customerMobile: RAW_MOBILE,
    customerEmail: RAW_EMAIL,
    ...overrides,
  };
}

const SHARED = ['bill_id', 'created_at', 'bill_type', 'source', 'invoice_number', 'total_paise', 'currency', 'delivery_status'];

describe('serializeBillsMasked — key-set test (E-2 / D-71)', () => {
  it('header is EXACTLY the 8 shared columns + the two MASKED contact columns', () => {
    const header = serializeBillsMasked([]).trim();
    expect(header.split(',')).toEqual([...SHARED, 'customer_mobile_masked', 'customer_email_masked']);
    expect(BILLS_CSV_MASKED_HEADERS).toEqual([...SHARED, 'customer_mobile_masked', 'customer_email_masked']);
  });

  it('a data row has exactly 10 fields, and NO raw contact value appears ANYWHERE in the output', () => {
    const csv = serializeBillsMasked([row()]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].split(',')).toHaveLength(10);
    expect(csv).not.toContain(RAW_MOBILE);
    expect(csv).not.toContain(RAW_EMAIL);
    // the masked forms DO appear
    expect(csv).toContain('98****3210');
    expect(csv).toContain('a***@example.com');
  });

  it('null contact → empty masked fields, still no leak', () => {
    const csv = serializeBillsMasked([row({ customerMobile: null, customerEmail: null })]);
    expect(csv.trimEnd().split('\r\n')[1]).toBe('bill-1,2026-08-01T12:00:00.000Z,TAX_INVOICE,DIRECT_API,INV-1,10700,INR,SENT,,');
  });
});

describe('serializeBillsFull — key-set test (E-2 / D-71 / D-81)', () => {
  it('header is EXACTLY the 8 shared columns + raw customer_mobile / customer_email — nothing else', () => {
    expect(serializeBillsFull([]).trim().split(',')).toEqual([...SHARED, 'customer_mobile', 'customer_email']);
    expect(BILLS_CSV_FULL_HEADERS).toEqual([...SHARED, 'customer_mobile', 'customer_email']);
  });

  it('exposes ONLY raw mobile + raw email as PII — no GSTIN, subtotals, line items, broadcasts[], raw recipient, rawCallback, secureHash', () => {
    const csv = serializeBillsFull([row()]);
    expect(csv).toContain(RAW_MOBILE);
    expect(csv).toContain(RAW_EMAIL);
    for (const forbidden of ['gstin', 'GSTIN', 'subtotal', 'cgst', 'sgst', 'igst', 'lineNo', 'hsn', 'rawCallback', 'secureHash', 'secretKey', 'recipient', 'orderId']) {
      expect(csv).not.toContain(forbidden);
    }
    // exactly 10 fields — no room for an extra column
    expect(csv.trimEnd().split('\r\n')[1].split(',')).toHaveLength(10);
  });

  it('total_paise is a BigInt-derived string, never a number', () => {
    const csv = serializeBillsFull([row({ totalPaise: 123456789012345n })]);
    expect(csv).toContain(',123456789012345,');
  });
});

describe('CSV escaping + formula-injection guard (D-81)', () => {
  it('quotes a field containing a comma / quote / newline (RFC 4180)', () => {
    const csv = serializeBillsFull([row({ invoiceNumber: 'A,B "C"\nD' })]);
    expect(csv).toContain('"A,B ""C""\nD"');
    // row shape not broken — still 10 fields when re-split correctly is hard to
    // assert with a naive split, so assert the raw comma is quoted:
    expect(csv).not.toContain(',A,B ');
  });

  it("prefixes a leading = / + / - / @ with an apostrophe so it is not evaluated as a formula", () => {
    const csv = serializeBillsFull([row({ invoiceNumber: '=SUM(A1:A9)' })]);
    expect(csv).toContain("'=SUM(A1:A9)");
    const csv2 = serializeBillsMasked([row({ invoiceNumber: '@cmd' })]);
    expect(csv2).toContain("'@cmd");
  });

  it('a normal value is emitted bare', () => {
    expect(serializeBillsFull([row({ invoiceNumber: 'INV-2026-001' })])).toContain(',INV-2026-001,');
  });
});

describe('serializeBillsCsv dispatch', () => {
  it('routes by projection', () => {
    expect(serializeBillsCsv([], 'masked')).toBe(serializeBillsMasked([]));
    expect(serializeBillsCsv([], 'full')).toBe(serializeBillsFull([]));
  });
});

describe('bills-export-csv.util — deny-test discipline', () => {
  it('the file emits no diagnostic output', () => {
    const src = fs.readFileSync(path.join(__dirname, 'bills-export-csv.util.ts'), 'utf8');
    expect(src).not.toMatch(/\bLogger\b|console\./);
  });
});

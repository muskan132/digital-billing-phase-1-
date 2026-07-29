// TEMPLATE_SYSTEM_v2 §7 — THE regression test for bill layout immutability.
//
// Chains the real write path (BillsService.createBill, P-2) into the real read path
// (LinksService.resolve, L-2/L-3) in one test, rather than hand-writing both sides of
// the comparison independently: (a) create a bill against template A, capturing
// exactly what the write path persisted; (b) construct a "mutated template" with
// different blocks; (c) resolve the bill through a mock row that carries (a)'s frozen
// snapshot AND a "poisoned" differing template payload under the same shape a live
// join would have used; (d) assert the resolved output matches (a), never (b).
//
// This is what would actually catch a regression where someone edits P-1 but not P-2
// (or vice versa), or reintroduces the live template join in the renderer later —
// unlike two independently hand-crafted fixtures, which could silently drift apart
// from each other without ever proving the write and read sides agree.

import { BillsService } from './bills.service';
import { LinksService } from '../links/links.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBillDto } from './dto/create-bill.dto';

const MERCHANT = {
  id: 'merchant_A',
  name: 'Demo Merchant',
  gstin: '27ABCDE1234F1Z5',
  gstStateCode: '27',
  defaultChannel: 'EMAIL',
  addressLine1: '221, Linking Road',
  addressLine2: null,
  city: 'Mumbai',
  pincode: '400050',
  state: 'Maharashtra',
};

const ORIGINAL_BLOCKS = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'ITEMS', order: 2, props: {} },
];

// A "mutated" template — same id, different content, as if someone edited it in place
// after the bill below was issued. Deliberately different skeleton AND blocks so any
// leak is unmistakable.
const MUTATED_BLOCKS = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'FOOTER', order: 2, props: { customText: 'MUTATED-AFTER-ISSUE-MARKER' } },
];

const TEMPLATE_AT_ISSUE_TIME = {
  id: 'tpl-shared-tax',
  merchantId: null,
  billType: 'TAX_INVOICE',
  skeleton: 'TAX_COMPLIANT',
  layoutSchema: ORIGINAL_BLOCKS,
  version: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function validDto(): CreateBillDto {
  return {
    external_transaction_id: 'ext-immutability-1',
    invoice_number: 'INV-IMMUTABLE-1',
    place_of_supply: '27',
    currency: 'INR',
    sale_at: '2026-07-27T10:00:00Z',
    line_items: [
      {
        line_no: 1,
        name: 'Widget',
        hsn: '1234',
        uom: 'NOS',
        quantity: 1,
        unit_price_paise: '100',
        item_discount_paise: '0',
        tax_rate_bp: 700,
        tax_paise: '7',
        cgst_paise: '4',
        sgst_paise: '3',
        igst_paise: '0',
      },
    ],
    totals: { subtotal_paise: '100', bill_discount_paise: '0', discount_paise: '0', tax_paise: '7', total_paise: '107' },
    tax_block: { cgst_paise: '4', sgst_paise: '3', igst_paise: '0' },
  };
}

describe('Bill layout-snapshot immutability (TEMPLATE_SYSTEM_v2 §7)', () => {
  it('a bill resolved after its template is mutated still renders the blocks frozen at creation, never the mutated ones', async () => {
    // ---- (a) WRITE: real BillsService.createBill, mocked Prisma, capture the actual
    // layoutSnapshot the write path built — not a hand-crafted stand-in. ----
    const orderUpsert = jest.fn().mockResolvedValue({
      id: 'order-1',
      bill: { id: 'bill-1', templateId: TEMPLATE_AT_ISSUE_TIME.id },
      link: { identifier: 'abcdefghij' },
    });
    const writePrisma = {
      order: { findUnique: jest.fn().mockResolvedValue(null), upsert: orderUpsert },
      merchant: { findUnique: jest.fn().mockResolvedValue(MERCHANT) },
      template: { findFirst: jest.fn().mockResolvedValue(TEMPLATE_AT_ISSUE_TIME) },
    } as unknown as PrismaService;

    const billsService = new BillsService(writePrisma);
    await billsService.createBill(validDto(), MERCHANT.id);

    const capturedLayoutSnapshot = orderUpsert.mock.calls[0][0].create.bill.create.layoutSnapshot;
    expect(capturedLayoutSnapshot).toEqual({
      schemaVersion: 1,
      skeleton: 'TAX_COMPLIANT',
      blocks: ORIGINAL_BLOCKS,
      templateId: TEMPLATE_AT_ISSUE_TIME.id,
      templateVersion: 1,
    });

    // ---- (b) "mutate the template" — MUTATED_BLOCKS above stands in for what the
    // Template row would now contain if someone edited it after the bill was issued.
    // (No actual mutation call needed: nothing in the read path may ever re-fetch the
    // live template, so there is nothing to mutate a second time — see (c).) ----

    // ---- (c) READ: real LinksService.resolve(), mocked Prisma row carries (a)'s
    // frozen snapshot under bill.layoutSnapshot, PLUS a poisoned bill.template payload
    // holding the MUTATED blocks under the same shape the pre-§7 code used to select.
    // resolve()'s select no longer asks Prisma for `template` at all (locked down by
    // the structural test in links.service.spec.ts) — this poisoned property exists
    // purely so that IF resolve() ever read it, this test would catch it immediately. ----
    const findUnique = jest.fn().mockResolvedValue({
      identifier: 'abcdefghij',
      order: {
        merchant: {
          name: MERCHANT.name,
          addressLine1: MERCHANT.addressLine1,
          addressLine2: MERCHANT.addressLine2,
          city: MERCHANT.city,
          state: MERCHANT.state,
          pincode: MERCHANT.pincode,
          gstin: MERCHANT.gstin,
          supportEmail: null,
          supportPhone: null,
        },
        bill: {
          billType: 'TAX_INVOICE',
          totalPaise: 107n,
          currency: 'INR',
          snapshot: { merchantName: MERCHANT.name, invoiceNumber: 'INV-IMMUTABLE-1' },
          invoiceNumber: 'INV-IMMUTABLE-1',
          subtotalPaise: 100n,
          discountPaise: 0n,
          taxPaise: 7n,
          cgstPaise: 4n,
          sgstPaise: 3n,
          igstPaise: 0n,
          placeOfSupply: '27',
          merchantGstin: MERCHANT.gstin,
          layoutSnapshot: capturedLayoutSnapshot,
          // Poison — see comment above.
          template: {
            id: TEMPLATE_AT_ISSUE_TIME.id,
            billType: 'TAX_INVOICE',
            skeleton: 'MINIMALIST', // deliberately different from the frozen 'TAX_COMPLIANT'
            layoutSchema: MUTATED_BLOCKS,
          },
        },
        items: [],
      },
    });
    const readPrisma = { link: { findUnique } } as unknown as PrismaService;
    const linksService = new LinksService(readPrisma);

    const result = await linksService.resolve('abcdefghij');

    // ---- (d) The resolved output must equal (a)'s frozen snapshot exactly, and must
    // never contain any trace of the mutated blocks. ----
    expect(result.bill.layoutSnapshot).toEqual(capturedLayoutSnapshot);
    expect((result.bill.layoutSnapshot as { skeleton: string }).skeleton).toBe('TAX_COMPLIANT');
    expect((result.bill.layoutSnapshot as { blocks: unknown }).blocks).toEqual(ORIGINAL_BLOCKS);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('MUTATED-AFTER-ISSUE-MARKER');
    expect(serialized).not.toContain('FOOTER');
  });
});

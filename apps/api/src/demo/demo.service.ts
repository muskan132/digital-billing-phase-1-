import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { computeSecureHash } from '../callbacks/secure-hash.util';
import { computeInvoice, InvoiceLineInput } from '../bills/invoice-calc';
import { rupeesToPaise } from '../common/money.util';

const API_ORIGIN = 'http://localhost:4000';
const WEB_ORIGIN = 'http://localhost:3000';
const DEMO_MERCHANT_JIOPAY_MID = 'JP2000000007';
const DEMO_API_KEY_FILE = path.join(process.cwd(), '.demo-api-key.local');
// Fixed intra-state place of supply, matching the demo merchant's own gstStateCode
// (seed.ts) — keeps every live-form submission on the same, already-proven-safe
// intra-state path as the existing fixtures. No selector: not asked for, and every
// extra live control is one more thing that could go wrong mid-demo.
const DEMO_PLACE_OF_SUPPLY = '27';
// The form collects name/qty/price/tax-rate only — HSN/UOM are compliance fields with
// no live-demo value, so they're fixed here rather than turned into more form inputs.
const DEMO_HSN = '9999';
const DEMO_UOM = 'NOS';

const FIXTURE_FILES: Record<'tax_invoice' | 'retail' | 'restaurant', string> = {
  tax_invoice: 'test-tax-compliant.json',
  retail: 'test-retail.json',
  restaurant: 'test-restaurant.json',
};

const TEMPLATE_IDS: Record<'tax_invoice' | 'retail' | 'restaurant', string> = {
  tax_invoice: 'seed-template-tax-invoice',
  retail: 'seed-template-retail',
  restaurant: 'seed-template-restaurant',
};

export interface PreviewInvoiceItem {
  name: string;
  quantity: number;
  unitPriceRupees: string;
  taxRateBp: number;
}

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Builds a fresh, correctly-signed PG callback (unique txnID/merchantTxnNo/
  // paymentID each call, so replay/idempotency never collides across demo
  // clicks) and pushes it through the real, guarded /v1/callbacks/pg route —
  // same signing logic (computeSecureHash) the real gateway would use, no
  // duplicated business logic.
  async simulateCallback(amount: string): Promise<{ url: string } | { error: string }> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { jiopayMid: DEMO_MERCHANT_JIOPAY_MID },
      select: { secretKeyEnc: true },
    });
    if (!merchant) {
      return { error: 'Demo merchant not seeded — run `pnpm prisma db seed` first.' };
    }

    const suffix = randomUUID().slice(0, 12);
    const txnID = `demo-${suffix}`;
    const payload: Record<string, unknown> = {
      acqName: 'PayPhi',
      aggregatorID: 'JP2001xxx60985',
      TransmissionDateTime: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
      paymentInstId: '4XXX XXXX XXXX 1111',
      cardNetwork: 'VISA',
      customerMobileNo: '9812345678',
      customerEmailID: 'demo-panel@example.com',
      paymentSubInstType: 'DC',
      paymentMode: 'Card',
      amount,
      responseCode: '0000',
      respDescription: 'Transaction successful',
      merchantId: DEMO_MERCHANT_JIOPAY_MID,
      merchantTxnNo: `DEMO${suffix}`,
      txnID,
      paymentDateTime: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
      paymentID: `demo-pay-${suffix}`,
      oth_charge: false,
    };
    payload.secureHash = computeSecureHash(payload, merchant.secretKeyEnc);

    const response = await fetch(`${API_ORIGIN}/v1/callbacks/pg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      this.logger.error(`Demo callback simulation failed: HTTP ${response.status}`);
      return { error: 'Simulated payment failed — see server logs.' };
    }

    const order = await this.prisma.order.findUnique({
      where: { txnId: txnID },
      include: { link: true },
    });
    if (!order?.link) {
      return { error: 'Payment was recorded but no bill link was created (e.g. no recipient configured).' };
    }
    return { url: `${WEB_ORIGIN}/${order.link.identifier}` };
  }

  // Posts one of three already-verified, correctly-computed fixture bodies
  // (built and 201-tested earlier this session) through the real, guarded
  // /v1/bills route, using the demo merchant API key from the gitignored
  // plaintext file S-7 provisions — never from client-side JS.
  async createInvoice(fixtureKey: 'tax_invoice' | 'retail' | 'restaurant'): Promise<{ url: string } | { error: string }> {
    let apiKey: string;
    try {
      apiKey = fs.readFileSync(DEMO_API_KEY_FILE, 'utf-8').trim();
    } catch {
      return { error: 'Demo API key file missing — run `pnpm prisma db seed` first.' };
    }

    const fixturePath = path.join(process.cwd(), FIXTURE_FILES[fixtureKey]);
    let fixture: Record<string, unknown>;
    try {
      fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    } catch {
      throw new BadRequestException('Demo fixture file missing or invalid');
    }

    const suffix = randomUUID().slice(0, 12);
    fixture.external_transaction_id = `demo-invoice-${suffix}`;
    fixture.invoice_number = `INV-DEMO-${suffix}`;

    return this.postToBills(apiKey, fixture);
  }

  // Pure calculation preview — no persistence, no side effects. Runs the exact same
  // M-2 computeInvoice the real /v1/bills path validates against, so whatever this
  // returns is, by construction, the one figure createInvoiceFromComputed can never
  // disagree with.
  previewInvoice(items: PreviewInvoiceItem[]): {
    line_items: Record<string, unknown>[];
    totals: Record<string, string>;
    tax_block: Record<string, string>;
  } {
    if (items.length < 1 || items.length > 3) {
      throw new BadRequestException('1-3 items required');
    }

    const lines: InvoiceLineInput[] = items.map((item, i) => {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new BadRequestException(`Item ${i + 1}: quantity must be a positive integer`);
      }
      let unitPricePaise: bigint;
      try {
        unitPricePaise = rupeesToPaise(item.unitPriceRupees);
      } catch {
        throw new BadRequestException(`Item ${i + 1}: invalid unit price`);
      }
      return {
        lineNo: i + 1,
        quantity: item.quantity,
        unitPricePaise,
        itemDiscountPaise: 0n,
        taxRateBp: item.taxRateBp,
      };
    });

    const result = computeInvoice(lines, 0n, DEMO_PLACE_OF_SUPPLY, DEMO_PLACE_OF_SUPPLY);

    const line_items = result.lines.map((line, i) => ({
      line_no: line.lineNo,
      name: items[i].name,
      hsn: DEMO_HSN,
      uom: DEMO_UOM,
      quantity: items[i].quantity,
      unit_price_paise: lines[i].unitPricePaise.toString(),
      item_discount_paise: '0',
      tax_rate_bp: line.taxRateBp,
      tax_paise: line.taxPaise.toString(),
      cgst_paise: line.cgstPaise.toString(),
      sgst_paise: line.sgstPaise.toString(),
      igst_paise: line.igstPaise.toString(),
    }));

    return {
      line_items,
      totals: {
        subtotal_paise: result.subtotalPaise.toString(),
        bill_discount_paise: '0',
        discount_paise: result.discountPaise.toString(),
        tax_paise: result.taxPaise.toString(),
        total_paise: result.totalPaise.toString(),
      },
      tax_block: {
        cgst_paise: result.cgstPaise.toString(),
        sgst_paise: result.sgstPaise.toString(),
        igst_paise: result.igstPaise.toString(),
      },
    };
  }

  // Takes previewInvoice's own output verbatim (never re-derived, never anything the
  // form typed directly) and posts it through the real, guarded /v1/bills route —
  // same in-process pattern as createInvoice above. CALC_MISMATCH cannot fire here:
  // the figures being validated are the figures the server itself just computed.
  async createInvoiceFromComputed(
    templateKey: 'tax_invoice' | 'retail' | 'restaurant',
    computed: { line_items: Record<string, unknown>[]; totals: Record<string, string>; tax_block: Record<string, string> },
  ): Promise<{ url: string } | { error: string }> {
    let apiKey: string;
    try {
      apiKey = fs.readFileSync(DEMO_API_KEY_FILE, 'utf-8').trim();
    } catch {
      return { error: 'Demo API key file missing — run `pnpm prisma db seed` first.' };
    }

    const suffix = randomUUID().slice(0, 12);
    const payload = {
      external_transaction_id: `demo-form-${suffix}`,
      invoice_number: `INV-DEMO-FORM-${suffix}`,
      place_of_supply: DEMO_PLACE_OF_SUPPLY,
      currency: 'INR',
      sale_at: new Date().toISOString(),
      template_id: TEMPLATE_IDS[templateKey],
      line_items: computed.line_items,
      totals: computed.totals,
      tax_block: computed.tax_block,
      contact: { email: 'demo-panel@example.com' },
    };

    return this.postToBills(apiKey, payload);
  }

  private async postToBills(apiKey: string, payload: Record<string, unknown>): Promise<{ url: string } | { error: string }> {
    const response = await fetch(`${API_ORIGIN}/v1/bills`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      this.logger.error(`Demo invoice creation failed: HTTP ${response.status}`);
      return { error: 'Invoice creation failed — see server logs.' };
    }
    const body = (await response.json()) as { url: string };
    return { url: body.url };
  }
}

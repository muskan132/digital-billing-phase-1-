import { formatCallbackDateTime } from './date-format';
import { BLOCK_TYPES as KNOWN_BLOCK_TYPES, BlockType } from '@digital-billing/block-manifest';

// Block-type enum: sourced from the block manifest (D-30) — the single shared
// declaration of every valid layoutSchema block type, imported here rather than
// declared locally, per D-30's rejection of duplication-plus-a-drift-test. See
// packages/block-manifest/src/index.ts for the full per-type prop/renderer
// declaration and the rationale for this set (14 rendering block types plus
// the five declared-but-dataless UTILITY starter blocks, I-1 / D-67).

export interface LayoutBlock {
  type: string;
  order: number;
  props: Record<string, unknown>;
  // Both optional (U-3): historical Bill.layoutSnapshot rows frozen before this field
  // existed have neither key at all, not an explicit true/'full' — renderTemplate must
  // treat an ABSENT value as "visible"/"full", never as false/undefined-is-falsy, or
  // every already-issued bill's blocks would render as hidden the instant this ships.
  visible?: boolean;
  width?: 'full' | 'half' | 'third';
}

// Bill.snapshot as P-1 (apps/api/src/callbacks/callbacks.service.ts) actually writes it.
// All fields optional here: a missing field is a data-completeness gap, not a schema
// error, so it never throws. Non-money fields render blank; amountPaise/currency
// render an explicit "Amount unavailable" marker instead (see AMOUNT_UNAVAILABLE below).
export interface BillSnapshot {
  merchantName?: string;
  amountPaise?: string;
  currency?: string;
  paymentMode?: string | null;
  paymentDateTime?: string | null;
  receiptNumber?: string | null;
  merchantTxnNo?: string | null;
  cardNetwork?: string | null;
  paymentInstId?: string | null;
  respDescription?: string | null;
  // v2 (D-28): TAX_INVOICE-only fields, absent on a RECEIPT snapshot.
  invoiceNumber?: string;
  placeOfSupply?: string;
  merchantGstin?: string | null;
  merchantState?: string | null;
  merchantAddress?: string | null;
  // Q-7 / D-88 addendum: present only when the caller supplied invoice_date at
  // creation. Absent (not null) on bills issued before this field existed — never
  // backfilled.
  invoiceDate?: string;
  subtotalPaise?: string;
  discountPaise?: string;
  taxPaise?: string;
  cgstPaise?: string;
  sgstPaise?: string;
  igstPaise?: string;
  items?: BillSnapshotLineItem[];
}

// Mirrors P-2's exact D-28 items[] member shape (apps/api/src/bills/bills.service.ts).
export interface BillSnapshotLineItem {
  lineNo: number;
  name: string;
  hsn: string;
  uom: string;
  quantity: number;
  unitPricePaise: string;
  itemDiscountPaise: string;
  billDiscountAllocPaise: string;
  taxRateBp: number;
  taxableValuePaise: string;
  taxPaise: string;
  cgstPaise: string;
  sgstPaise: string;
  igstPaise: string;
}

// One row per invoice line, as rendered (V-5). discountPaise combines itemDiscountPaise
// + billDiscountAllocPaise into the single "discount" column the printed line needs so
// unitPrice*qty - discount = taxable reconciles visually, even though the two discount
// components are stored separately (D-22/D-23) — display-only combination, the
// underlying stored values are untouched.
export interface RenderedLineItem {
  lineNo: number;
  name: string;
  hsn: string;
  uom: string;
  quantity: number;
  unitPricePaise: string;
  discountPaise: string;
  taxRateBp: number;
  taxableValuePaise: string;
  taxPaise: string;
}

// docs/TEMPLATE_SYSTEM_v2.md §2 — the column-config model: field is the immutable data
// binding, label/visible/align are presentation. The renderer must look fields up by
// this config, never hardcode field names in JSX — that's what lets a future builder
// change labels/visibility/order with no renderer changes.
export interface ColumnConfig {
  field: string;
  label: string;
  visible: boolean;
  align: 'left' | 'center' | 'right';
}

// One row of arbitrary field->value lookups, keyed to match ColumnConfig.field values
// (and secondaryFields entries) exactly. lineNo is kept out of `fields` — it's a React
// key, not a displayable column.
export interface RenderedColumnRow {
  lineNo: number;
  fields: Record<string, string | number>;
}

// Merchant business details as L-2 (apps/api/src/links/links.service.ts) whitelists
// them — the equivalent of what's printed on any shop receipt, not customer PII.
export interface BillMerchant {
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

// U-3: `width` is attached via this intersection over a SEPARATELY named union
// (RenderedBlockContent) — renderBlock returns the un-widthed content type below and
// renderTemplate's single call site adds `width` via spread, so none of the cases
// below need to change for row-grouping, and (importantly) Omit<RenderedBlock,'width'>
// was avoided here on purpose: Omit does not distribute cleanly over an intersected
// union and would have collapsed the discriminated-union narrowing every consumer of
// RenderedBlock (BillBlocks.tsx's switch) relies on.
type RenderedBlockContent =
  | {
      type: 'HEADER';
      merchantName: string | undefined;
      receiptNumber: string | null | undefined;
      formattedDateTime: string | null;
    }
  | {
      type: 'MERCHANT_INFO';
      kind: 'receipt';
      addressLine1: string | null | undefined;
      addressLine2: string | null | undefined;
      city: string | null | undefined;
      state: string | null | undefined;
      pincode: string | null | undefined;
      gstin: string | null | undefined;
    }
  // 'tax_invoice' (TAX_COMPLIANT, BUG 1 fix): the two-column seller/invoice-meta block.
  // Sourced entirely from the FROZEN snapshot (merchantName/merchantAddress/
  // merchantGstin/invoiceNumber/placeOfSupply/invoiceDate), never the live `merchant`
  // param — BR-2 immutability: a tax invoice's printed seller details must reflect what
  // was true at issue time, not the merchant's current profile. invoiceDate is
  // undefined on bills issued before Q-7 — never fabricated (D-88).
  | {
      type: 'MERCHANT_INFO';
      kind: 'tax_invoice';
      merchantName: string | undefined;
      address: string | null | undefined;
      gstin: string | null | undefined;
      invoiceNumber: string | undefined;
      invoiceDate: string | undefined;
      placeOfSupply: string | undefined;
    }
  // §3 catalogue #3 — bill no. + date (Q-7 / D-88: sourced from snapshot.invoiceDate,
  // undefined on bills issued before this field existed — never fabricated).
  | { type: 'BILL_META'; billNumber: string | undefined; date: string | undefined }
  // 'single': no line items on the snapshot (RECEIPT bills — FSD BR-23 confirms a
  // Payment Receipt has no line-item section) — the original one-row summary.
  // 'itemized' (V-5): real per-line rows, hardcoded fields. No longer used by any
  // seeded template after BUG 1 (TAX_COMPLIANT moved to 'columns' below) — kept in
  // place as a valid variant, not deleted, since nothing asked for its removal.
  // 'columns' (RETAIL, and now TAX_COMPLIANT): field/label/visible/align-driven, per
  // §2/§9's builder contract — used whenever the template's ITEMS block declares
  // props.columns. The same data model drives both a stacked mobile layout (RETAIL)
  // and a real <table> (TAX_COMPLIANT) — only the JSX differs, not this shape.
  | { type: 'ITEMS'; kind: 'single'; totalPaise: string; currency: string }
  | { type: 'ITEMS'; kind: 'itemized'; items: RenderedLineItem[]; currency: string }
  | {
      type: 'ITEMS';
      kind: 'columns';
      columns: ColumnConfig[];
      secondaryFields: string[];
      currency: string;
      rows: RenderedColumnRow[];
    }
  | {
      type: 'PAYMENT_DETAILS';
      paymentMode: string | null | undefined;
      cardNetwork: string | null | undefined;
      paymentInstId: string | null | undefined;
      merchantTxnNo: string | null | undefined;
    }
  // Q-6 (D-97): the forbidden CGST/SGST-as-columns matrix ('legacy_matrix') is
  // removed — 'aggregate' is now the sole TAX_SUMMARY shape, for every
  // skeleton, per TEMPLATE_SYSTEM_v2 §5's requirement.
  //
  // KNOWN LIMITATION on isIntraState (flagged, not fixed — would require
  // reopening P-2/L-3's locked schema): derived from whether igstPaise is zero/absent.
  // A fully zero-rated bill (every line taxRateBp=0) produces cgst=sgst=igst=0
  // regardless of the bill's actual place of supply, because D-24's split logic yields
  // 0/0 whenever tax=0 — the information needed to disambiguate intra- vs inter-state
  // does not survive into the zero values. A fully-exempt inter-state invoice may
  // therefore display under the wrong tax-type label. Practical impact is low — every
  // figure shown is zero either way — but it is a labeling-correctness gap on a
  // compliance document.
  //
  // 'aggregate' (RETAIL, final §5 spec — replaces the earlier 'component_rows'
  // simple/detailed pair entirely, per direct instruction): ONE structure regardless of
  // how many distinct tax rates are on the bill. No per-rate breakdown, no rate
  // percentages — just the bill-level Taxable Amount, one CGST row, one SGST row (or
  // one IGST row inter-state), each summed across ALL rates directly from
  // snapshot.items, and Total Tax = cgstPaise + sgstPaise (or igstPaise).
  | {
      type: 'TAX_SUMMARY';
      kind: 'aggregate';
      isIntraState: boolean;
      taxableValuePaise: string;
      cgstPaise: string;
      sgstPaise: string;
      igstPaise: string;
      totalTaxPaise: string;
      currency: string;
    }
  // 'simple' (unchanged, all existing skeletons): shows amountPaise, the grand total.
  // 'pre_tax' (RETAIL, §3): shows subtotalPaise - discountPaise — the taxable value,
  // per D-22's exact definition — opted into via props.basis on the template's TOTAL
  // block. Never the default: existing skeletons' un-annotated TOTAL blocks keep
  // exactly their current behavior.
  | { type: 'TOTAL'; kind: 'simple'; totalPaise: string; currency: string }
  | { type: 'TOTAL'; kind: 'pre_tax'; totalPaise: string; currency: string }
  // §3 catalogue #8 — the post-tax hero total. See the KNOWN_BLOCK_TYPES comment above
  // for why this is a distinct block from TOTAL, not a restyled duplicate.
  | { type: 'AMOUNT_PAYABLE'; totalPaise: string; currency: string }
  // §3 catalogue #10 — no data source yet anywhere in Bill.snapshot (nothing computes
  // a per-bill savings figure today). Built to spec; savingsPaise stays undefined until
  // a future task adds one — never fabricated.
  | { type: 'SAVINGS'; savingsPaise: string | undefined; currency: string }
  // §3 catalogue #11 — same as SAVINGS: no data source yet, never fabricated.
  | { type: 'LOYALTY'; pointsEarned: number | undefined; balance: number | undefined }
  // §3 catalogue #19 — unlike SAVINGS/LOYALTY, this content is template-authored
  // static copy (frozen into layoutSnapshot.blocks[].props at issue time), not
  // bill-computed — it CAN render real content today via the seeded template's props.
  | {
      type: 'COUPON';
      headline: string | undefined;
      code: string | undefined;
      validity: string | undefined;
      ctaLabel: string | undefined;
    }
  // §3 catalogue #20 — same as COUPON: template-authored static copy.
  | { type: 'SURVEY'; prompt: string | undefined; surveyType: string | undefined; url: string | undefined }
  // Not in §3's catalogue at all — genuinely new, RETAIL only (see KNOWN_BLOCK_TYPES
  // comment). `path` is template-authored static copy, same pattern as COUPON/SURVEY —
  // combining it with PUBLIC_BILL_BASE_URL and generating the actual QR image happens
  // in BillBlocks.tsx, not here, since that's where env-var/image-generation concerns
  // already live, keeping this function free of I/O.
  | { type: 'QR_CODE'; path: string | undefined; caption: string | undefined }
  | {
      type: 'FOOTER';
      supportEmail: string | null | undefined;
      supportPhone: string | null | undefined;
    }
  // I-1 (D-67): UTILITY starter blocks. Structurally present, deliberately
  // dataless — no write path supplies consumer numbers, billing periods, meter
  // readings, tariff slabs or due dates, and none of it is template-authored
  // copy (a per-bill meter reading in the template would print on every bill).
  // Each carries only its discriminant: renderBlock returns it, BillBlocks
  // renders nothing for it. "Dataless" is asserted by a test, not just this
  // comment. They light up with no template change once the data arrives.
  | { type: 'CONSUMER_INFO' }
  | { type: 'BILLING_PERIOD' }
  | { type: 'METER_READING' }
  | { type: 'TARIFF_SLABS' }
  | { type: 'DUE_DATE' };

export type RenderedBlock = { width: 'full' | 'half' | 'third' } & RenderedBlockContent;

// A blank amount on a paid bill is a worse failure than a blank name/date field would
// be — silently empty money reads as "nothing to pay" rather than "data problem" to a
// customer. So unlike other fields, a missing money value gets an explicit visible
// marker instead of undefined.
export const AMOUNT_UNAVAILABLE = 'Amount unavailable';

function isKnownBlockType(type: string): type is BlockType {
  return (KNOWN_BLOCK_TYPES as readonly string[]).includes(type);
}

function renderMoneyFields(snapshot: BillSnapshot): { totalPaise: string; currency: string } {
  return {
    totalPaise: snapshot.amountPaise ?? AMOUNT_UNAVAILABLE,
    currency: snapshot.currency ?? AMOUNT_UNAVAILABLE,
  };
}

function renderBlock(block: LayoutBlock, snapshot: BillSnapshot, merchant: BillMerchant): RenderedBlockContent {
  if (!isKnownBlockType(block.type)) {
    // D-10: any type outside the enum is invalid and must be rejected, not silently
    // skipped or passed through — this is a schema violation, not missing data.
    throw new Error(`Unknown block type: ${block.type}`);
  }

  switch (block.type) {
    case 'HEADER':
      return {
        type: 'HEADER',
        merchantName: merchant.name ?? snapshot.merchantName,
        receiptNumber: snapshot.receiptNumber,
        formattedDateTime: formatCallbackDateTime(snapshot.paymentDateTime),
      };
    case 'MERCHANT_INFO': {
      // TAX_COMPLIANT (BUG 1): opted into via an explicit props.variant, same pattern
      // as TOTAL's props.basis / TAX_SUMMARY's props.mode — sourced from the frozen
      // snapshot, never the live `merchant` param (see the RenderedBlock comment above).
      if (block.props.variant === 'tax_invoice') {
        return {
          type: 'MERCHANT_INFO',
          kind: 'tax_invoice',
          merchantName: snapshot.merchantName,
          address: snapshot.merchantAddress,
          gstin: snapshot.merchantGstin,
          invoiceNumber: snapshot.invoiceNumber,
          invoiceDate: snapshot.invoiceDate,
          placeOfSupply: snapshot.placeOfSupply,
        };
      }
      return {
        type: 'MERCHANT_INFO',
        kind: 'receipt',
        addressLine1: merchant.addressLine1,
        addressLine2: merchant.addressLine2,
        city: merchant.city,
        state: merchant.state,
        pincode: merchant.pincode,
        gstin: merchant.gstin,
      };
    }
    case 'BILL_META':
      return { type: 'BILL_META', billNumber: snapshot.invoiceNumber, date: snapshot.invoiceDate };
    case 'ITEMS': {
      const hasItems = snapshot.items && snapshot.items.length > 0;

      // RETAIL (§2/§9): the template's ITEMS block declares props.columns — read
      // column definitions generically, never hardcode field names in JSX.
      if (hasItems && Array.isArray(block.props.columns)) {
        const columns = block.props.columns as ColumnConfig[];
        const secondaryFields = Array.isArray(block.props.secondaryFields)
          ? (block.props.secondaryFields as string[])
          : [];
        const rows: RenderedColumnRow[] = snapshot.items!.map((item) => ({
          lineNo: item.lineNo,
          fields: {
            name: item.name,
            hsn: item.hsn,
            uom: item.uom,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            // Display-only combination — see RenderedLineItem's comment.
            discountPaise: (BigInt(item.itemDiscountPaise) + BigInt(item.billDiscountAllocPaise)).toString(),
            taxRateBp: item.taxRateBp,
            taxableValuePaise: item.taxableValuePaise,
            taxPaise: item.taxPaise,
            // Tax-inclusive per-line total — the customer-facing "what this item cost".
            amountPaise: (BigInt(item.taxableValuePaise) + BigInt(item.taxPaise)).toString(),
          },
        }));
        return {
          type: 'ITEMS',
          kind: 'columns',
          columns,
          secondaryFields,
          currency: snapshot.currency ?? AMOUNT_UNAVAILABLE,
          rows,
        };
      }

      if (hasItems) {
        return {
          type: 'ITEMS',
          kind: 'itemized',
          currency: snapshot.currency ?? AMOUNT_UNAVAILABLE,
          items: snapshot.items!.map((item) => ({
            lineNo: item.lineNo,
            name: item.name,
            hsn: item.hsn,
            uom: item.uom,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            // Display-only combination — see RenderedLineItem's comment.
            discountPaise: (BigInt(item.itemDiscountPaise) + BigInt(item.billDiscountAllocPaise)).toString(),
            taxRateBp: item.taxRateBp,
            taxableValuePaise: item.taxableValuePaise,
            taxPaise: item.taxPaise,
          })),
        };
      }
      return { type: 'ITEMS', kind: 'single', ...renderMoneyFields(snapshot) };
    }
    case 'PAYMENT_DETAILS':
      return {
        type: 'PAYMENT_DETAILS',
        paymentMode: snapshot.paymentMode,
        cardNetwork: snapshot.cardNetwork,
        paymentInstId: snapshot.paymentInstId,
        merchantTxnNo: snapshot.merchantTxnNo,
      };
    case 'TAX_SUMMARY': {
      const items = snapshot.items ?? [];
      // See the KNOWN LIMITATION comment on RenderedBlock's TAX_SUMMARY variants above
      // — this derivation cannot distinguish a genuinely intra-state bill from a fully
      // zero-rated inter-state one.
      const isIntraState = !snapshot.igstPaise || snapshot.igstPaise === '0';
      const currency = snapshot.currency ?? AMOUNT_UNAVAILABLE;

      // Q-6 (D-97): 'aggregate' is the sole TAX_SUMMARY shape — one CGST row,
      // one SGST row (or one IGST row inter-state), each summed across ALL
      // tax rates, regardless of props.mode. TEMPLATE_SYSTEM_v2 §5 forbids
      // the per-rate matrix unconditionally, not just when a template opts in.
      let taxableValuePaise = BigInt(0);
      let cgstPaise = BigInt(0);
      let sgstPaise = BigInt(0);
      let igstPaise = BigInt(0);
      for (const item of items) {
        taxableValuePaise += BigInt(item.taxableValuePaise);
        cgstPaise += BigInt(item.cgstPaise);
        sgstPaise += BigInt(item.sgstPaise);
        igstPaise += BigInt(item.igstPaise);
      }
      const totalTaxPaise = isIntraState ? cgstPaise + sgstPaise : igstPaise;
      return {
        type: 'TAX_SUMMARY',
        kind: 'aggregate',
        isIntraState,
        taxableValuePaise: taxableValuePaise.toString(),
        cgstPaise: cgstPaise.toString(),
        sgstPaise: sgstPaise.toString(),
        igstPaise: igstPaise.toString(),
        totalTaxPaise: totalTaxPaise.toString(),
        currency,
      };
    }
    case 'TOTAL': {
      if (block.props.basis === 'pre_tax' && snapshot.subtotalPaise !== undefined && snapshot.discountPaise !== undefined) {
        const preTaxPaise = (BigInt(snapshot.subtotalPaise) - BigInt(snapshot.discountPaise)).toString();
        return { type: 'TOTAL', kind: 'pre_tax', totalPaise: preTaxPaise, currency: snapshot.currency ?? AMOUNT_UNAVAILABLE };
      }
      return { type: 'TOTAL', kind: 'simple', ...renderMoneyFields(snapshot) };
    }
    case 'AMOUNT_PAYABLE':
      return { type: 'AMOUNT_PAYABLE', ...renderMoneyFields(snapshot) };
    case 'SAVINGS':
      // No data source yet anywhere in Bill.snapshot — see RenderedBlock's comment.
      return { type: 'SAVINGS', savingsPaise: undefined, currency: snapshot.currency ?? AMOUNT_UNAVAILABLE };
    case 'LOYALTY':
      // No data source yet — see RenderedBlock's comment.
      return { type: 'LOYALTY', pointsEarned: undefined, balance: undefined };
    case 'COUPON':
      // Template-authored static copy, frozen into layoutSnapshot at issue time.
      return {
        type: 'COUPON',
        headline: typeof block.props.headline === 'string' ? block.props.headline : undefined,
        code: typeof block.props.code === 'string' ? block.props.code : undefined,
        validity: typeof block.props.validity === 'string' ? block.props.validity : undefined,
        ctaLabel: typeof block.props.ctaLabel === 'string' ? block.props.ctaLabel : undefined,
      };
    case 'SURVEY':
      // Template-authored static copy, frozen into layoutSnapshot at issue time.
      return {
        type: 'SURVEY',
        prompt: typeof block.props.prompt === 'string' ? block.props.prompt : undefined,
        surveyType: typeof block.props.type === 'string' ? block.props.type : undefined,
        url: typeof block.props.url === 'string' ? block.props.url : undefined,
      };
    case 'QR_CODE':
      // Template-authored static copy, frozen into layoutSnapshot at issue time.
      return {
        type: 'QR_CODE',
        path: typeof block.props.path === 'string' ? block.props.path : undefined,
        caption: typeof block.props.caption === 'string' ? block.props.caption : undefined,
      };
    case 'FOOTER':
      return {
        type: 'FOOTER',
        supportEmail: merchant.supportEmail,
        supportPhone: merchant.supportPhone,
      };
    // I-1 (D-67): UTILITY starter blocks — no data source anywhere yet, and no
    // template-authored props (see RenderedBlock comment). Return the bare
    // block; BillBlocks renders nothing for it.
    case 'CONSUMER_INFO':
      return { type: 'CONSUMER_INFO' };
    case 'BILLING_PERIOD':
      return { type: 'BILLING_PERIOD' };
    case 'METER_READING':
      return { type: 'METER_READING' };
    case 'TARIFF_SLABS':
      return { type: 'TARIFF_SLABS' };
    case 'DUE_DATE':
      return { type: 'DUE_DATE' };
  }
}

export function renderTemplate(
  layoutSchema: LayoutBlock[],
  snapshot: BillSnapshot,
  merchant: BillMerchant = {},
): RenderedBlock[] {
  return [...layoutSchema]
    // U-3: `visible !== false`, not `visible === true` — an absent key (every
    // historical Bill.layoutSnapshot frozen before this field existed, and any v1
    // array predating T-4) must render exactly as it always has, not vanish.
    .filter((block) => block.visible !== false)
    .sort((a, b) => a.order - b.order)
    .map((block) => ({ ...renderBlock(block, snapshot, merchant), width: block.width ?? 'full' }));
}

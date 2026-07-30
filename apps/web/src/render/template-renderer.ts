import { formatCallbackDateTime } from './date-format';

// Block-type enum per D-10 (docs/DECISIONS_v1.md) — the only valid layoutSchema block
// types for v1. Expected to grow further (MARKETING per the FSD).
// SAVINGS/LOYALTY/COUPON/SURVEY/AMOUNT_PAYABLE added for the RETAIL template
// (docs/TEMPLATE_SYSTEM_v2.md §3 catalogue #10/#11/#19/#20/#8). AMOUNT_PAYABLE is
// distinct from TOTAL: §3 documents TOTAL as the pre-tax total and AMOUNT_PAYABLE as
// the post-tax hero total — §5's fixed document order (Items -> TOTAL -> tax ladder ->
// AMOUNT_PAYABLE) only makes sense if they're different figures.
const KNOWN_BLOCK_TYPES = [
  'HEADER',
  'MERCHANT_INFO',
  'ITEMS',
  'PAYMENT_DETAILS',
  'TAX_SUMMARY',
  'TOTAL',
  'AMOUNT_PAYABLE',
  'SAVINGS',
  'LOYALTY',
  'COUPON',
  'SURVEY',
  'FOOTER',
] as const;
type BlockType = (typeof KNOWN_BLOCK_TYPES)[number];

export interface LayoutBlock {
  type: string;
  order: number;
  props: Record<string, unknown>;
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

// One row per distinct tax rate, summed across all lines at that rate (V-5).
//
// KNOWN BUG (logged, not fixed here — see memory/project_tax_compliant_known_bugs.md):
// this is exactly the CGST/SGST-as-columns matrix docs/TEMPLATE_SYSTEM_v2.md §5 forbids
// ("Never a rate-matrix with CGST/SGST as columns — no real bill does that"). Built in
// V-5, before that doc existed in this session. Kept as-is, tagged 'legacy_matrix' on
// the RenderedBlock TAX_SUMMARY variant below, so TAX_COMPLIANT's existing rendering is
// undisturbed — the RETAIL template (which needs the correct shape) uses the 'aggregate'
// variant instead. Do not extend this shape further; fix it directly via the tracked
// follow-up task instead.
export interface TaxSummaryRow {
  taxRateBp: number;
  taxableValuePaise: string;
  cgstPaise: string;
  sgstPaise: string;
  igstPaise: string;
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

export type RenderedBlock =
  | {
      type: 'HEADER';
      merchantName: string | undefined;
      receiptNumber: string | null | undefined;
      formattedDateTime: string | null;
    }
  | {
      type: 'MERCHANT_INFO';
      addressLine1: string | null | undefined;
      addressLine2: string | null | undefined;
      city: string | null | undefined;
      state: string | null | undefined;
      pincode: string | null | undefined;
      gstin: string | null | undefined;
    }
  // 'single': no line items on the snapshot (RECEIPT bills — FSD BR-23 confirms a
  // Payment Receipt has no line-item section) — the original one-row summary.
  // 'itemized' (V-5): real per-line rows for TAX_COMPLIANT, hardcoded fields — left
  // untouched (see TaxSummaryRow's comment re: not disturbing shipped rendering).
  // 'columns' (RETAIL): field/label/visible/align-driven, per §2/§9's builder contract
  // — used whenever the template's ITEMS block declares props.columns.
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
  // 'legacy_matrix' (V-5): TAX_COMPLIANT's existing, known-wrong shape — see
  // TaxSummaryRow's comment. Untouched by the RETAIL task.
  //
  // KNOWN LIMITATION on isIntraState, both kinds (flagged, not fixed — would require
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
  | { type: 'TAX_SUMMARY'; kind: 'legacy_matrix'; isIntraState: boolean; rows: TaxSummaryRow[]; currency: string }
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
  | {
      type: 'FOOTER';
      supportEmail: string | null | undefined;
      supportPhone: string | null | undefined;
    };

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

function renderBlock(block: LayoutBlock, snapshot: BillSnapshot, merchant: BillMerchant): RenderedBlock {
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
    case 'MERCHANT_INFO':
      return {
        type: 'MERCHANT_INFO',
        addressLine1: merchant.addressLine1,
        addressLine2: merchant.addressLine2,
        city: merchant.city,
        state: merchant.state,
        pincode: merchant.pincode,
        gstin: merchant.gstin,
      };
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

      // RETAIL, final spec — opted into via any explicit props.mode (RETAIL's seed sets
      // 'auto'; the value no longer selects among sub-modes, there is only one — it just
      // distinguishes this template's aggregate system from TAX_COMPLIANT's untouched
      // legacy_matrix below, whose seed has no props.mode at all).
      if (block.props.mode) {
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

      // 'legacy_matrix' — TAX_COMPLIANT's existing, known-wrong shape (see
      // TaxSummaryRow's comment). Untouched.
      const groups = new Map<
        number,
        { taxableValuePaise: bigint; cgstPaise: bigint; sgstPaise: bigint; igstPaise: bigint }
      >();
      for (const item of items) {
        const g = groups.get(item.taxRateBp) ?? {
          taxableValuePaise: BigInt(0),
          cgstPaise: BigInt(0),
          sgstPaise: BigInt(0),
          igstPaise: BigInt(0),
        };
        g.taxableValuePaise += BigInt(item.taxableValuePaise);
        g.cgstPaise += BigInt(item.cgstPaise);
        g.sgstPaise += BigInt(item.sgstPaise);
        g.igstPaise += BigInt(item.igstPaise);
        groups.set(item.taxRateBp, g);
      }
      const legacyRows: TaxSummaryRow[] = [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([taxRateBp, g]) => ({
          taxRateBp,
          taxableValuePaise: g.taxableValuePaise.toString(),
          cgstPaise: g.cgstPaise.toString(),
          sgstPaise: g.sgstPaise.toString(),
          igstPaise: g.igstPaise.toString(),
        }));
      return { type: 'TAX_SUMMARY', kind: 'legacy_matrix', isIntraState, rows: legacyRows, currency };
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
    case 'FOOTER':
      return {
        type: 'FOOTER',
        supportEmail: merchant.supportEmail,
        supportPhone: merchant.supportPhone,
      };
  }
}

export function renderTemplate(
  layoutSchema: LayoutBlock[],
  snapshot: BillSnapshot,
  merchant: BillMerchant = {},
): RenderedBlock[] {
  return [...layoutSchema].sort((a, b) => a.order - b.order).map((block) => renderBlock(block, snapshot, merchant));
}

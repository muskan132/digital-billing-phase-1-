// G-1: GST compliance-field validator for POST /v1/bills (BR-4, BR-5, FSD 5.3, D-25, D-26).
// No I/O, no Prisma, no framework — same constraints as M-2/M-3. Field names are snake_case,
// mirroring the wire payload shape from SCOPE_v2's flow (place_of_supply, invoice_number,
// tax_block, line_items[]) since the POST /v1/bills DTO itself is not built until I-1.

export class GstFieldMissing extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`GST_FIELD_MISSING: ${field}`);
    this.name = 'GstFieldMissing';
    this.field = field;
  }
}

export interface GstValidationLine {
  hsn?: string | null;
  uom?: string | null;
}

export interface GstValidationTaxBlock {
  cgstPaise?: bigint;
  sgstPaise?: bigint;
  igstPaise?: bigint;
}

export interface GstValidationInput {
  invoiceNumber?: string | null;
  currency?: string | null;
  placeOfSupply?: string | null;
  lineItems: GstValidationLine[];
  taxBlock: GstValidationTaxBlock;
}

export interface GstValidationMerchant {
  gstin?: string | null;
  gstStateCode?: string | null;
}

const CURRENCY_SHAPE = /^[A-Z]{3}$/; // ISO-4217 alpha shape; no vendor code list exists in docs/repo
const PLACE_OF_SUPPLY_SHAPE = /^\d{2}$/; // D-25: 2-digit GST state code

export function validateGstFields(input: GstValidationInput, merchant: GstValidationMerchant): void {
  if (!merchant.gstin) {
    throw new GstFieldMissing('merchant.gstin');
  }
  if (!merchant.gstStateCode) {
    throw new GstFieldMissing('merchant.gstStateCode');
  }
  if (merchant.gstStateCode !== merchant.gstin.slice(0, 2)) {
    throw new GstFieldMissing('merchant.gstStateCode');
  }
  if (!input.invoiceNumber) {
    throw new GstFieldMissing('invoice_number');
  }
  if (!input.placeOfSupply || !PLACE_OF_SUPPLY_SHAPE.test(input.placeOfSupply)) {
    throw new GstFieldMissing('place_of_supply');
  }
  if (!input.currency || !CURRENCY_SHAPE.test(input.currency)) {
    throw new GstFieldMissing('currency');
  }

  input.lineItems.forEach((line, i) => {
    if (!line.hsn) {
      throw new GstFieldMissing(`line_items[${i}].hsn`);
    }
    if (!line.uom) {
      throw new GstFieldMissing(`line_items[${i}].uom`);
    }
  });

  // D-25: the intra/inter-state shape is derived by the core, never taken from the caller.
  const isIntraState = input.placeOfSupply === merchant.gstStateCode;
  if (isIntraState) {
    if (input.taxBlock.igstPaise) {
      throw new GstFieldMissing('tax_block.igst_paise');
    }
  } else {
    if (input.taxBlock.cgstPaise) {
      throw new GstFieldMissing('tax_block.cgst_paise');
    }
    if (input.taxBlock.sgstPaise) {
      throw new GstFieldMissing('tax_block.sgst_paise');
    }
  }
}

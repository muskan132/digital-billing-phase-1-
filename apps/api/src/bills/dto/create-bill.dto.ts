// I-1: POST /v1/bills payload shape (parse-don't-validate — no decorators; structural
// enforcement is line_items-required here, business enforcement is G-1/M-3). All money
// fields are decimal-string paise on the wire, parsed via BigInt() — never Number()/
// parseFloat (SCOPE_v2 Definition-of-Done grep list). bill_type is deliberately absent
// (BR-21): no field here can ever be read as a bill-type override.

export interface CreateBillLineItemDto {
  line_no: number;
  name: string;
  hsn?: string;
  uom?: string;
  quantity: number;
  unit_price_paise: string;
  item_discount_paise?: string;
  tax_rate_bp: number;
  // D-21: the caller supplies per-line tax too, not just the bill-level tax_block —
  // needed so M-3 can catch a per-line CGST/SGST split mismatch even when the line's
  // total tax happens to balance.
  tax_paise: string;
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
}

export interface CreateBillTotalsDto {
  subtotal_paise: string;
  // D-22 step 4's allocation input — distinct from discount_paise below, which is the
  // combined (item + bill) aggregate compared against Bill.discountPaise.
  bill_discount_paise?: string;
  discount_paise: string;
  tax_paise: string;
  total_paise: string;
}

export interface CreateBillTaxBlockDto {
  cgst_paise: string;
  sgst_paise: string;
  igst_paise: string;
}

export interface CreateBillContactDto {
  mobile?: string;
  email?: string;
}

export interface CreateBillDto {
  external_transaction_id: string;
  invoice_number: string;
  place_of_supply: string;
  currency: string;
  sale_at: string;
  // D-19: present only for the BR-15 mismatch check against the guard-resolved
  // merchantId; never read again once that check has run.
  merchant_id?: string;
  line_items: CreateBillLineItemDto[];
  totals: CreateBillTotalsDto;
  tax_block: CreateBillTaxBlockDto;
  contact?: CreateBillContactDto;
  template_id?: string;
}

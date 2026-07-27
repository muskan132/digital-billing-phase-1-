import {
  GstFieldMissing,
  GstValidationInput,
  GstValidationMerchant,
  validateGstFields,
} from './gst-validate';

function validMerchant(): GstValidationMerchant {
  return { gstin: '27ABCDE1234F1Z5', gstStateCode: '27' };
}

function validInput(overrides: Partial<GstValidationInput> = {}): GstValidationInput {
  return {
    invoiceNumber: 'INV-001',
    currency: 'INR',
    placeOfSupply: '27',
    lineItems: [{ hsn: '1234', uom: 'NOS' }],
    taxBlock: { cgstPaise: 10n, sgstPaise: 10n, igstPaise: 0n },
    ...overrides,
  };
}

function expectMissing(fn: () => void, field: string) {
  try {
    fn();
    fail(`expected GstFieldMissing(${field})`);
  } catch (err) {
    expect(err).toBeInstanceOf(GstFieldMissing);
    expect((err as GstFieldMissing).field).toBe(field);
  }
}

describe('validateGstFields', () => {
  it('accepts a fully valid intra-state payload', () => {
    expect(() => validateGstFields(validInput(), validMerchant())).not.toThrow();
  });

  it('accepts a fully valid inter-state payload', () => {
    const input = validInput({ placeOfSupply: '29', taxBlock: { cgstPaise: 0n, sgstPaise: 0n, igstPaise: 20n } });
    expect(() => validateGstFields(input, validMerchant())).not.toThrow();
  });

  it('rejects a null merchant gstin', () => {
    expectMissing(() => validateGstFields(validInput(), { ...validMerchant(), gstin: null }), 'merchant.gstin');
  });

  it('rejects a null merchant gstStateCode', () => {
    expectMissing(
      () => validateGstFields(validInput(), { ...validMerchant(), gstStateCode: null }),
      'merchant.gstStateCode',
    );
  });

  it('rejects a gstStateCode inconsistent with gstin[0:2]', () => {
    expectMissing(
      () => validateGstFields(validInput(), { ...validMerchant(), gstStateCode: '29' }),
      'merchant.gstStateCode',
    );
  });

  it('rejects a missing invoice_number', () => {
    expectMissing(() => validateGstFields(validInput({ invoiceNumber: null }), validMerchant()), 'invoice_number');
  });

  it('rejects a missing place_of_supply', () => {
    expectMissing(() => validateGstFields(validInput({ placeOfSupply: null }), validMerchant()), 'place_of_supply');
  });

  it('rejects a malformed place_of_supply', () => {
    expectMissing(() => validateGstFields(validInput({ placeOfSupply: '277' }), validMerchant()), 'place_of_supply');
  });

  it('rejects a missing currency', () => {
    expectMissing(() => validateGstFields(validInput({ currency: null }), validMerchant()), 'currency');
  });

  it('rejects a non-ISO-4217-shaped currency', () => {
    expectMissing(() => validateGstFields(validInput({ currency: 'inr' }), validMerchant()), 'currency');
  });

  it('rejects a line missing HSN', () => {
    expectMissing(
      () => validateGstFields(validInput({ lineItems: [{ hsn: undefined, uom: 'NOS' }] }), validMerchant()),
      'line_items[0].hsn',
    );
  });

  it('rejects a line missing UOM', () => {
    expectMissing(
      () => validateGstFields(validInput({ lineItems: [{ hsn: '1234', uom: undefined }] }), validMerchant()),
      'line_items[0].uom',
    );
  });

  it('accepts a zero-rated line (no tax_rate_bp field here, but HSN present)', () => {
    const input = validInput({ lineItems: [{ hsn: '1234', uom: 'NOS' }] });
    expect(() => validateGstFields(input, validMerchant())).not.toThrow();
  });

  it('rejects a zero-rated line without HSN', () => {
    expectMissing(
      () => validateGstFields(validInput({ lineItems: [{ hsn: undefined, uom: 'NOS' }] }), validMerchant()),
      'line_items[0].hsn',
    );
  });

  it('rejects an intra-state bill supplying a nonzero igst_paise', () => {
    const input = validInput({ taxBlock: { cgstPaise: 10n, sgstPaise: 10n, igstPaise: 5n } });
    expectMissing(() => validateGstFields(input, validMerchant()), 'tax_block.igst_paise');
  });

  it('rejects an inter-state bill supplying a nonzero cgst_paise', () => {
    const input = validInput({ placeOfSupply: '29', taxBlock: { cgstPaise: 5n, sgstPaise: 0n, igstPaise: 20n } });
    expectMissing(() => validateGstFields(input, validMerchant()), 'tax_block.cgst_paise');
  });

  it('rejects an inter-state bill supplying a nonzero sgst_paise', () => {
    const input = validInput({ placeOfSupply: '29', taxBlock: { cgstPaise: 0n, sgstPaise: 5n, igstPaise: 20n } });
    expectMissing(() => validateGstFields(input, validMerchant()), 'tax_block.sgst_paise');
  });
});

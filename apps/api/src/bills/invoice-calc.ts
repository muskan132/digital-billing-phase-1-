// Pure calculation core for direct-API tax invoices (D-22 through D-25). No I/O, no
// Prisma, no framework — M-3 wraps this to compare against caller-supplied figures.

export interface InvoiceLineInput {
  lineNo: number;
  quantity: number;
  unitPricePaise: bigint;
  itemDiscountPaise: bigint;
  taxRateBp: number;
}

export interface InvoiceLineResult {
  lineNo: number;
  grossPaise: bigint;
  afterItemDiscountPaise: bigint;
  billDiscountAllocPaise: bigint;
  taxableValuePaise: bigint;
  taxRateBp: number;
  taxPaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
}

export interface InvoiceResult {
  lines: InvoiceLineResult[];
  subtotalPaise: bigint;
  discountPaise: bigint;
  taxPaise: bigint;
  cgstPaise: bigint;
  sgstPaise: bigint;
  igstPaise: bigint;
  totalPaise: bigint;
}

function halfUp(value: bigint, taxRateBp: bigint): bigint {
  // D-24: BigInt division truncates; all inputs are non-negative, so adding half the
  // divisor before dividing yields conventional half-up rounding.
  return (value * taxRateBp + 5000n) / 10000n;
}

export function computeInvoice(
  lines: InvoiceLineInput[],
  billDiscountPaise: bigint,
  placeOfSupply: string,
  merchantGstStateCode: string,
): InvoiceResult {
  // Step 1-2 (D-22): gross and post-item-discount value per line, with structural
  // pre-condition checks — these are computation invariants, not caller-value mismatches
  // (M-3 handles the latter by comparing this function's output to supplied figures).
  const afterItem: bigint[] = [];
  for (const line of lines) {
    if (line.quantity < 1) {
      throw new Error(`Line ${line.lineNo}: quantity must be >= 1, got ${line.quantity}`);
    }
    if (line.unitPricePaise < 0n) {
      throw new Error(`Line ${line.lineNo}: unitPricePaise must be >= 0, got ${line.unitPricePaise}`);
    }
    if (line.taxRateBp < 0) {
      throw new Error(`Line ${line.lineNo}: taxRateBp must be >= 0, got ${line.taxRateBp}`); // D-26
    }
    const gross = BigInt(line.quantity) * line.unitPricePaise;
    if (line.itemDiscountPaise > gross) {
      throw new Error(`Line ${line.lineNo}: itemDiscountPaise (${line.itemDiscountPaise}) exceeds gross (${gross})`);
    }
    afterItem.push(gross - line.itemDiscountPaise);
  }

  const sumAfterItem = afterItem.reduce((acc, v) => acc + v, 0n);
  if (billDiscountPaise > sumAfterItem) {
    throw new Error(`billDiscountPaise (${billDiscountPaise}) exceeds total post-item-discount value (${sumAfterItem})`);
  }

  // Step 4 (D-23): allocate billDiscountPaise proportional to post-item-discount value,
  // largest-remainder for the residual, ties broken by ascending lineNo.
  const rawAlloc = afterItem.map((v) => (sumAfterItem === 0n ? 0n : (billDiscountPaise * v) / sumAfterItem));
  const allocatedSoFar = rawAlloc.reduce((acc, v) => acc + v, 0n);
  let residual = billDiscountPaise - allocatedSoFar;

  const remainders = lines.map((line, i) => {
    const numerator = sumAfterItem === 0n ? 0n : (billDiscountPaise * afterItem[i]) % sumAfterItem;
    return { index: i, lineNo: line.lineNo, remainder: numerator };
  });
  remainders.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1; // descending remainder
    return a.lineNo - b.lineNo; // ascending lineNo tie-break
  });

  const alloc = [...rawAlloc];
  for (const { index } of remainders) {
    if (residual <= 0n) break;
    alloc[index] += 1n;
    residual -= 1n;
  }

  // Step 5-7 (D-24/D-25): taxable value, per-line tax + CGST/SGST/IGST split, totals.
  const isIntraState = placeOfSupply === merchantGstStateCode;
  const lineResults: InvoiceLineResult[] = lines.map((line, i) => {
    const taxableValuePaise = afterItem[i] - alloc[i];
    const taxPaise = halfUp(taxableValuePaise, BigInt(line.taxRateBp));

    let cgstPaise = 0n;
    let sgstPaise = 0n;
    let igstPaise = 0n;
    if (isIntraState) {
      cgstPaise = (taxPaise + 1n) / 2n;
      sgstPaise = taxPaise - cgstPaise; // subtraction, not a second rounding (D-24)
    } else {
      igstPaise = taxPaise;
    }

    return {
      lineNo: line.lineNo,
      grossPaise: BigInt(line.quantity) * line.unitPricePaise,
      afterItemDiscountPaise: afterItem[i],
      billDiscountAllocPaise: alloc[i],
      taxableValuePaise,
      taxRateBp: line.taxRateBp,
      taxPaise,
      cgstPaise,
      sgstPaise,
      igstPaise,
    };
  });

  const subtotalPaise = lineResults.reduce((acc, l) => acc + l.grossPaise, 0n);
  const itemDiscountTotal = lines.reduce((acc, l) => acc + l.itemDiscountPaise, 0n);
  const discountPaise = itemDiscountTotal + billDiscountPaise;
  const taxPaise = lineResults.reduce((acc, l) => acc + l.taxPaise, 0n);
  const cgstPaise = lineResults.reduce((acc, l) => acc + l.cgstPaise, 0n);
  const sgstPaise = lineResults.reduce((acc, l) => acc + l.sgstPaise, 0n);
  const igstPaise = lineResults.reduce((acc, l) => acc + l.igstPaise, 0n);
  const totalPaise = lineResults.reduce((acc, l) => acc + l.taxableValuePaise + l.taxPaise, 0n);

  return {
    lines: lineResults,
    subtotalPaise,
    discountPaise,
    taxPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalPaise,
  };
}

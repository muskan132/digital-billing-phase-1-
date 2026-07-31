import { RenderedBlock } from './template-renderer';
import { formatMoney } from './money-format';
import { TaxInvoiceCard } from './TaxInvoiceCard';
import { isPresent, formatFieldValue } from './render-helpers';

// One component per known block type — a broken block should never take down the
// rest of the bill (docs/UI_STYLE_v1.md: "a broken widget/asset hides that block, it
// never breaks the rest of the bill"), so each case renders independently.
export function BillBlocks({ blocks, skeleton }: { blocks: RenderedBlock[]; skeleton: string }) {
  // TAX_COMPLIANT (BUG 1): document-width layout with two-column regions can't fit the
  // generic vertical per-block stacker below — a dedicated component owns its own
  // composition instead, picking specific blocks by type out of the same array.
  if (skeleton === 'TAX_COMPLIANT') {
    return <TaxInvoiceCard blocks={blocks} />;
  }

  const skin =
    skeleton === 'COMPACT_THERMAL'
      ? 'thermal'
      : skeleton === 'RETAIL'
        ? 'retail'
        : skeleton === 'RESTAURANT'
          ? 'restaurant'
          : 'minimalist';

  return (
    <div className={`bill-card bill-card--${skin}`}>
      {blocks.map((block, index) => (
        <BillBlock key={index} block={block} skin={skin} />
      ))}
      {/* Single PAID badge, positioned per skin by CSS alone (top-right pill for
          minimalist, centred near the bottom for thermal) — not duplicated per block. */}
      <span className="bill-paid-badge">PAID</span>
    </div>
  );
}

function BillBlock({ block, skin }: { block: RenderedBlock; skin: string }) {
  switch (block.type) {
    case 'HEADER':
      return (
        <header className="bill-header">
          <h1 className="bill-merchant-name">{block.merchantName ?? 'Merchant'}</h1>
          <p className="bill-receipt-label">Payment receipt</p>
          {isPresent(block.receiptNumber) && <p className="bill-receipt-number">Ref: {block.receiptNumber}</p>}
          {block.formattedDateTime && <p className="bill-header-date">{block.formattedDateTime}</p>}
        </header>
      );

    case 'MERCHANT_INFO': {
      // 'tax_invoice' is rendered by TaxInvoiceCard.tsx, not here — this generic
      // per-block stacker is only ever handed 'receipt' blocks (BillBlocks branches to
      // TaxInvoiceCard before reaching this switch for the TAX_COMPLIANT skeleton).
      if (block.kind !== 'receipt') return null;
      const addressLines = [block.addressLine1, block.addressLine2].filter(isPresent);
      const cityLine = [block.city, block.state, block.pincode].filter(isPresent).join(', ');
      if (addressLines.length === 0 && !cityLine && !isPresent(block.gstin)) return null;
      return (
        <div className="bill-merchant-info">
          {addressLines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          {cityLine !== '' && <p>{cityLine}</p>}
          {isPresent(block.gstin) && <p className="bill-gstin">GSTIN: {block.gstin}</p>}
        </div>
      );
    }

    case 'BILL_META': {
      // date is always undefined today — see the RenderedBlock comment in
      // template-renderer.ts. Only Bill No. renders in practice.
      if (!isPresent(block.billNumber) && !isPresent(block.date)) return null;
      return (
        <div className="bill-meta">
          {isPresent(block.billNumber) && <span>Bill No. {block.billNumber}</span>}
          {isPresent(block.date) && <span>{block.date}</span>}
        </div>
      );
    }

    case 'ITEMS': {
      if (block.kind === 'single') {
        return (
          <div className="bill-items">
            <span>Payment received</span>
            <span className="bill-amount-inline">{formatMoney(block.totalPaise, block.currency)}</span>
          </div>
        );
      }

      if (block.kind === 'itemized') {
        return (
          <div className="bill-items-table">
            <div className="bill-item-row bill-item-row--head">
              <span>Item</span>
              <span>HSN</span>
              <span>UOM</span>
              <span>Qty</span>
              <span>Rate</span>
              <span>Discount</span>
              <span>Tax %</span>
              <span>Taxable</span>
              <span>Tax</span>
            </div>
            {block.items.map((item) => (
              <div className="bill-item-row" key={item.lineNo}>
                {/* Merchant-supplied free text (D-28's named residual risk) — this safety
                    depends entirely on JSX's default text-escaping and on never using
                    dangerouslySetInnerHTML anywhere in this file. Treat that as an
                    explicit invariant: any future edit introducing dangerouslySetInnerHTML
                    here reopens an XSS hole on a public unauthenticated page. */}
                <span>{item.name}</span>
                <span>{item.hsn}</span>
                <span>{item.uom}</span>
                <span>{item.quantity}</span>
                <span>{formatMoney(item.unitPricePaise, block.currency)}</span>
                <span>{formatMoney(item.discountPaise, block.currency)}</span>
                <span>{(item.taxRateBp / 100).toString()}%</span>
                <span>{formatMoney(item.taxableValuePaise, block.currency)}</span>
                <span>{formatMoney(item.taxPaise, block.currency)}</span>
              </div>
            ))}
          </div>
        );
      }

      // 'columns' (RETAIL, §2/§9): field/label/visible/align-driven — never hardcode
      // field names. Today's seeded config shows name×qty inline, amount right-aligned,
      // HSN as a muted secondary line; a future builder toggling e.g. RATE visible
      // renders it in bill-item-stack-extra with its configured label, with no
      // renderer change required.
      const visibleColumns = block.columns.filter((c) => c.visible);
      const nameCol = visibleColumns.find((c) => c.field === 'name');
      const qtyCol = visibleColumns.find((c) => c.field === 'quantity');
      const amountCol = visibleColumns.find((c) => c.field === 'amountPaise');
      const otherCols = visibleColumns.filter((c) => c !== nameCol && c !== qtyCol && c !== amountCol);

      return (
        <div className="bill-items-stack">
          {block.rows.map((row) => (
            <div className="bill-item-stack-row" key={row.lineNo}>
              <div className="bill-item-stack-main">
                <span className="bill-item-name">
                  {/* Merchant-supplied free text (item name) — this safety depends
                      entirely on JSX's default text-escaping and on never using
                      dangerouslySetInnerHTML anywhere in this file. Treat that as an
                      explicit invariant: any future edit introducing
                      dangerouslySetInnerHTML here reopens an XSS hole on a public
                      unauthenticated page. */}
                  {nameCol && row.fields.name}
                  {qtyCol && row.fields.quantity !== undefined && (
                    <span className="bill-item-qty"> × {row.fields.quantity}</span>
                  )}
                </span>
                {amountCol && (
                  <span className="bill-item-amount">{formatFieldValue('amountPaise', row.fields.amountPaise, block.currency)}</span>
                )}
              </div>
              {otherCols.length > 0 && (
                <div className="bill-item-stack-extra">
                  {otherCols.map((col) => (
                    <span key={col.field}>
                      {col.label}: {formatFieldValue(col.field, row.fields[col.field], block.currency)}
                    </span>
                  ))}
                </div>
              )}
              {block.secondaryFields.length > 0 && (
                <div className="bill-item-stack-secondary">
                  {block.secondaryFields.map((field) => (
                    <span key={field} className="bill-item-secondary-field">
                      {row.fields[field]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      );
    }

    case 'PAYMENT_DETAILS': {
      // Card network + masked instrument is one line, omitted entirely when
      // paymentInstId is null (non-card payment modes never get a masked instrument).
      const cardLine = isPresent(block.paymentInstId)
        ? [block.cardNetwork, block.paymentInstId].filter(isPresent).join(' · ')
        : null;
      return (
        <div className="bill-payment-details">
          {isPresent(block.paymentMode) && <p>{block.paymentMode}</p>}
          {cardLine && <p>{cardLine}</p>}
          {isPresent(block.merchantTxnNo) && <p className="bill-ref-secondary">Order ref: {block.merchantTxnNo}</p>}
        </div>
      );
    }

    case 'TAX_SUMMARY': {
      if (block.kind === 'legacy_matrix') {
        if (block.rows.length === 0) return null;
        return (
          <div className="bill-tax-summary">
            <div className="bill-tax-summary-row bill-tax-summary-row--head">
              <span>Rate</span>
              <span>Taxable</span>
              {block.isIntraState ? (
                <>
                  <span>CGST</span>
                  <span>SGST</span>
                </>
              ) : (
                <span>IGST</span>
              )}
            </div>
            {block.rows.map((row) => (
              <div className="bill-tax-summary-row" key={row.taxRateBp}>
                <span>{(row.taxRateBp / 100).toString()}%</span>
                <span>{formatMoney(row.taxableValuePaise, block.currency)}</span>
                {block.isIntraState ? (
                  <>
                    <span>{formatMoney(row.cgstPaise, block.currency)}</span>
                    <span>{formatMoney(row.sgstPaise, block.currency)}</span>
                  </>
                ) : (
                  <span>{formatMoney(row.igstPaise, block.currency)}</span>
                )}
              </div>
            ))}
          </div>
        );
      }

      // 'aggregate' (RETAIL, final §5 spec): Taxable Amount, one CGST row, one SGST
      // row (or one IGST row inter-state) — each already summed across ALL tax rates
      // in the data layer, no per-rate breakdown, no rate percentages, no matter how
      // many distinct tax rates are on the bill. Total Tax closes the block.
      return (
        <div className="bill-tax-summary bill-tax-summary--aggregate">
          <div className="bill-tax-summary-ladder-row">
            <span>Taxable Amount</span>
            <span>{formatMoney(block.taxableValuePaise, block.currency)}</span>
          </div>
          {block.isIntraState ? (
            <>
              <div className="bill-tax-summary-ladder-row">
                <span>CGST</span>
                <span>{formatMoney(block.cgstPaise, block.currency)}</span>
              </div>
              <div className="bill-tax-summary-ladder-row">
                <span>SGST</span>
                <span>{formatMoney(block.sgstPaise, block.currency)}</span>
              </div>
            </>
          ) : (
            <div className="bill-tax-summary-ladder-row">
              <span>IGST</span>
              <span>{formatMoney(block.igstPaise, block.currency)}</span>
            </div>
          )}
          <div className="bill-tax-summary-ladder-row bill-tax-summary-ladder-row--total">
            <span>Total Tax</span>
            <span>{formatMoney(block.totalTaxPaise, block.currency)}</span>
          </div>
        </div>
      );
    }

    case 'TOTAL':
      return (
        <div className="bill-total">
          <span className="bill-total-label">{block.kind === 'pre_tax' ? 'Total' : 'Total paid'}</span>
          <strong className="bill-amount">{formatMoney(block.totalPaise, block.currency)}</strong>
        </div>
      );

    case 'AMOUNT_PAYABLE':
      // "Grand Total" — the confirmed mockup's closing element of the document: a
      // separate visual section (own top border + background), not part of the tax
      // summary block above it. Same AMOUNT_PAYABLE block/data, restyled per §5's final
      // spec, not a new block type.
      return (
        <div className="bill-grand-total">
          <span className="bill-grand-total-label">Grand Total</span>
          <strong className="bill-grand-total-value">{formatMoney(block.totalPaise, block.currency)}</strong>
        </div>
      );

    case 'SAVINGS': {
      // No data source yet — see RenderedBlock's comment. Never fabricate a value.
      if (!isPresent(block.savingsPaise)) return null;
      return (
        <div className="bill-savings">
          <span>You saved {formatMoney(block.savingsPaise, block.currency)}</span>
        </div>
      );
    }

    case 'LOYALTY': {
      // No data source yet — see RenderedBlock's comment. Never fabricate a value.
      if (block.pointsEarned == null) return null;
      return (
        <div className="bill-loyalty">
          <span>Loyalty points earned: {block.pointsEarned}</span>
          {block.balance != null && <span className="bill-loyalty-balance">Balance: {block.balance}</span>}
        </div>
      );
    }

    case 'COUPON': {
      if (!isPresent(block.headline) && !isPresent(block.code)) return null;
      return (
        <div className="bill-coupon">
          {/* Merchant-authored template copy (§3 security note) — plain JSX children
              only, never dangerouslySetInnerHTML. */}
          {isPresent(block.headline) && <p className="bill-coupon-headline">{block.headline}</p>}
          {isPresent(block.code) && <p className="bill-coupon-code">{block.code}</p>}
          {isPresent(block.validity) && <p className="bill-coupon-validity">{block.validity}</p>}
          {isPresent(block.ctaLabel) && <span className="bill-coupon-cta">{block.ctaLabel}</span>}
        </div>
      );
    }

    case 'SURVEY': {
      if (!isPresent(block.prompt)) return null;
      return (
        <div className="bill-survey">
          {/* Merchant-authored template copy — plain JSX children only, never
              dangerouslySetInnerHTML. */}
          <p className="bill-survey-prompt">{block.prompt}</p>
        </div>
      );
    }

    case 'FOOTER': {
      const contacts = [block.supportEmail, block.supportPhone].filter(isPresent);
      if (skin === 'retail') {
        return (
          <footer className="bill-footer bill-footer--retail">
            {contacts.length > 0 && <span>Questions? Contact us at {contacts.join(' · ')}</span>}
            <span className="bill-powered-by">Powered by JioPay</span>
          </footer>
        );
      }
      if (contacts.length === 0) return null;
      return <footer className="bill-footer">Questions about this receipt? Contact us at {contacts.join(' · ')}</footer>;
    }
  }
}

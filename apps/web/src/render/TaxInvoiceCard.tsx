import { RenderedBlock } from './template-renderer';
import { formatMoney } from './money-format';
import { isPresent, formatFieldValue } from './render-helpers';

// TAX_COMPLIANT (BUG 1, docs/TEMPLATE_SYSTEM_v2.md §4.4 minus BILL_TO/PAYMENT_DETAILS —
// this is the B2C direct-API path: buyer identity must never render on this public
// unauthenticated page, and there are no B2B bank/A/C/IFSC terms here). A dedicated,
// document-width composition — not the generic per-block stacker other skins use —
// picking specific blocks by type out of the same RenderedBlock[] array BillBlocks
// already computed.
export function TaxInvoiceCard({ blocks }: { blocks: RenderedBlock[] }) {
  const header = blocks.find((b) => b.type === 'HEADER');
  const merchantInfo = blocks.find((b) => b.type === 'MERCHANT_INFO');
  const items = blocks.find((b) => b.type === 'ITEMS');
  const total = blocks.find((b) => b.type === 'TOTAL');
  const taxSummary = blocks.find((b) => b.type === 'TAX_SUMMARY');
  const amountPayable = blocks.find((b) => b.type === 'AMOUNT_PAYABLE');
  const footer = blocks.find((b) => b.type === 'FOOTER');

  return (
    <div className="tax-invoice-scroll-wrapper">
      <div className="bill-card bill-card--tax-invoice">
        <header className="tax-invoice-header">
          <div>
            <h1 className="tax-invoice-title">TAX INVOICE</h1>
            <p className="tax-invoice-subtitle">Original for Recipient</p>
          </div>
          {header && header.type === 'HEADER' && <span className="bill-paid-badge">PAID</span>}
        </header>

        {merchantInfo && merchantInfo.type === 'MERCHANT_INFO' && merchantInfo.kind === 'tax_invoice' && (
          <div className="tax-invoice-meta">
            <div className="tax-invoice-meta-seller">
              <p className="tax-invoice-meta-label">Seller</p>
              {/* Merchant-supplied free text — plain JSX children only, never
                  dangerouslySetInnerHTML. Any future edit introducing
                  dangerouslySetInnerHTML here reopens an XSS hole on a public
                  unauthenticated page. */}
              {isPresent(merchantInfo.merchantName) && <p className="tax-invoice-seller-name">{merchantInfo.merchantName}</p>}
              {isPresent(merchantInfo.address) && <p>{merchantInfo.address}</p>}
              {isPresent(merchantInfo.gstin) && <p className="bill-gstin">GSTIN: {merchantInfo.gstin}</p>}
            </div>
            <div className="tax-invoice-meta-details">
              {isPresent(merchantInfo.invoiceNumber) && (
                <div className="tax-invoice-meta-row">
                  <span>Invoice No.</span>
                  <span>{merchantInfo.invoiceNumber}</span>
                </div>
              )}
              {isPresent(merchantInfo.placeOfSupply) && (
                <div className="tax-invoice-meta-row">
                  <span>Place of Supply</span>
                  <span>{merchantInfo.placeOfSupply}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {items && items.type === 'ITEMS' && items.kind === 'columns' && (
          <div className="tax-invoice-table-wrapper">
            <table className="tax-invoice-table">
              <thead>
                <tr>
                  {items.columns
                    .filter((c) => c.visible)
                    .map((c) => (
                      <th key={c.field} className={`align-${c.align}`}>
                        {c.label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {items.rows.map((row) => (
                  <tr key={row.lineNo}>
                    {items.columns
                      .filter((c) => c.visible)
                      .map((c) => (
                        // Merchant-supplied free text (item description) — plain JSX
                        // children only, never dangerouslySetInnerHTML. Same invariant
                        // as the seller-name block above.
                        <td key={c.field} className={`align-${c.align}`}>
                          {formatFieldValue(c.field, row.fields[c.field], items.currency)}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total && total.type === 'TOTAL' && (
          <div className="tax-invoice-total-row">
            <span>{total.kind === 'pre_tax' ? 'Total' : 'Total paid'}</span>
            <strong>{formatMoney(total.totalPaise, total.currency)}</strong>
          </div>
        )}

        {taxSummary && taxSummary.type === 'TAX_SUMMARY' && taxSummary.kind === 'aggregate' && (
          // Narrow, right-aligned — not full width. Same aggregated structure RETAIL
          // ships (Taxable Amount / CGST / SGST or IGST / Total Tax), reused directly:
          // reuses the .bill-tax-summary-ladder-row classes RETAIL's CSS already
          // defines, no per-rate rows, no RATE column.
          <div className="tax-invoice-tax-summary-region">
            <div className="tax-invoice-tax-summary">
              <div className="bill-tax-summary-ladder-row">
                <span>Taxable Amount</span>
                <span>{formatMoney(taxSummary.taxableValuePaise, taxSummary.currency)}</span>
              </div>
              {taxSummary.isIntraState ? (
                <>
                  <div className="bill-tax-summary-ladder-row">
                    <span>CGST</span>
                    <span>{formatMoney(taxSummary.cgstPaise, taxSummary.currency)}</span>
                  </div>
                  <div className="bill-tax-summary-ladder-row">
                    <span>SGST</span>
                    <span>{formatMoney(taxSummary.sgstPaise, taxSummary.currency)}</span>
                  </div>
                </>
              ) : (
                <div className="bill-tax-summary-ladder-row">
                  <span>IGST</span>
                  <span>{formatMoney(taxSummary.igstPaise, taxSummary.currency)}</span>
                </div>
              )}
              <div className="bill-tax-summary-ladder-row bill-tax-summary-ladder-row--total">
                <span>Total Tax</span>
                <span>{formatMoney(taxSummary.totalTaxPaise, taxSummary.currency)}</span>
              </div>
            </div>
          </div>
        )}

        {footer &&
          footer.type === 'FOOTER' &&
          (() => {
            const contacts = [footer.supportEmail, footer.supportPhone].filter(isPresent);
            if (contacts.length === 0) return null;
            return (
              <footer className="bill-footer tax-invoice-footer">
                Questions about this receipt? Contact us at {contacts.join(' · ')}
              </footer>
            );
          })()}

        {amountPayable && amountPayable.type === 'AMOUNT_PAYABLE' && (
          // Same AMOUNT_PAYABLE block, same "Grand Total" markup/classes RETAIL ships —
          // reused directly, not reimplemented. Last child inside the card so the
          // shared .bill-grand-total CSS (bleeds to card edges, rounds with the card's
          // own bottom corners) applies unmodified.
          <div className="bill-grand-total">
            <span className="bill-grand-total-label">Grand Total</span>
            <strong className="bill-grand-total-value">{formatMoney(amountPayable.totalPaise, amountPayable.currency)}</strong>
          </div>
        )}
      </div>
    </div>
  );
}

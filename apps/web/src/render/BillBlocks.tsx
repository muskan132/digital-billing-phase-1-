import { RenderedBlock } from './template-renderer';
import { formatMoney } from './money-format';

function isPresent(value: string | null | undefined): value is string {
  return value != null && value !== '';
}

// One component per known block type — a broken block should never take down the
// rest of the bill (docs/UI_STYLE_v1.md: "a broken widget/asset hides that block, it
// never breaks the rest of the bill"), so each case renders independently.
export function BillBlocks({ blocks, skeleton }: { blocks: RenderedBlock[]; skeleton: string }) {
  const skin = skeleton === 'COMPACT_THERMAL' ? 'thermal' : 'minimalist';

  return (
    <div className={`bill-card bill-card--${skin}`}>
      {blocks.map((block, index) => (
        <BillBlock key={index} block={block} />
      ))}
      {/* Single PAID badge, positioned per skin by CSS alone (top-right pill for
          minimalist, centred near the bottom for thermal) — not duplicated per block. */}
      <span className="bill-paid-badge">PAID</span>
    </div>
  );
}

function BillBlock({ block }: { block: RenderedBlock }) {
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

    case 'ITEMS':
      // Single row, not an item-by-item breakdown — see the comment on the ITEMS
      // case in template-renderer.ts for why.
      return (
        <div className="bill-items">
          <span>Payment received</span>
          <span className="bill-amount-inline">{formatMoney(block.totalPaise, block.currency)}</span>
        </div>
      );

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

    case 'TOTAL':
      return (
        <div className="bill-total">
          <span className="bill-total-label">Total paid</span>
          <strong className="bill-amount">{formatMoney(block.totalPaise, block.currency)}</strong>
        </div>
      );

    case 'FOOTER': {
      const contacts = [block.supportEmail, block.supportPhone].filter(isPresent);
      if (contacts.length === 0) return null;
      return <footer className="bill-footer">Questions about this receipt? Contact us at {contacts.join(' · ')}</footer>;
    }
  }
}

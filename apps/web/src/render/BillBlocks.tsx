import { RenderedBlock } from './template-renderer';
import { formatPaise } from './money-format';

// One component per known block type — a broken block should never take down the
// rest of the bill (docs/UI_STYLE_v1.md: "a broken widget/asset hides that block, it
// never breaks the rest of the bill"), so each case renders independently.
export function BillBlocks({ blocks }: { blocks: RenderedBlock[] }) {
  return (
    <div className="bill-card">
      {blocks.map((block, index) => (
        <BillBlock key={index} block={block} />
      ))}
    </div>
  );
}

function BillBlock({ block }: { block: RenderedBlock }) {
  switch (block.type) {
    case 'HEADER':
      return <h1 className="bill-title">{block.merchantName ?? 'Bill'}</h1>;
    case 'MERCHANT_INFO':
      return <p className="bill-merchant-info">{block.merchantName}</p>;
    case 'ITEMS':
      // Single total line, not an item-by-item breakdown — see the comment on the
      // ITEMS case in template-renderer.ts for why.
      return (
        <div className="bill-items">
          {formatPaise(block.totalPaise)} {block.currency}
        </div>
      );
    case 'TOTAL':
      return (
        <div className="bill-total">
          <strong>
            Total: {formatPaise(block.totalPaise)} {block.currency}
          </strong>
        </div>
      );
    case 'FOOTER':
      return (
        <footer className="bill-footer">
          {block.paymentMode} {block.paymentMode && block.paymentDateTime ? '·' : ''} {block.paymentDateTime}
        </footer>
      );
  }
}

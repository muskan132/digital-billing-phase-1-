import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderTemplate, LayoutBlock, BillSnapshot, BillMerchant } from './template-renderer';
import { BillBlocks } from './BillBlocks';

const SNAPSHOT: BillSnapshot = { merchantName: 'Demo Merchant', amountPaise: '10000', currency: 'INR' };
const MERCHANT: BillMerchant = { name: 'Demo Merchant' };

function renderHtml(blocks: LayoutBlock[]): string {
  const rendered = renderTemplate(blocks, SNAPSHOT, MERCHANT);
  return renderToStaticMarkup(React.createElement(BillBlocks, { blocks: rendered, skeleton: 'RETAIL' }));
}

describe('BillBlocks row-grouping (U-3 / TEMPLATE_SYSTEM_v2 §6)', () => {
  it('two adjacent half-width blocks share one bill-block-row container', () => {
    const html = renderHtml([
      { type: 'HEADER', order: 1, props: {}, width: 'half' },
      { type: 'FOOTER', order: 2, props: {}, width: 'half' },
    ]);

    // Exactly one row wrapper, containing both blocks' row-item wrappers.
    const rowMatches = html.match(/bill-block-row"/g) ?? [];
    expect(rowMatches).toHaveLength(1);
    expect(html).toContain('bill-block-row-item--half');
  });

  it('three adjacent third-width blocks share one row', () => {
    const html = renderHtml([
      { type: 'HEADER', order: 1, props: {}, width: 'third' },
      { type: 'MERCHANT_INFO', order: 2, props: {}, width: 'third' },
      { type: 'FOOTER', order: 3, props: {}, width: 'third' },
    ]);

    const rowMatches = html.match(/bill-block-row"/g) ?? [];
    expect(rowMatches).toHaveLength(1);
    expect((html.match(/bill-block-row-item--third/g) ?? [])).toHaveLength(3);
  });

  it('a full-width block never joins a row, even between two half blocks', () => {
    const html = renderHtml([
      { type: 'HEADER', order: 1, props: {}, width: 'half' },
      { type: 'MERCHANT_INFO', order: 2, props: {}, width: 'full' },
      { type: 'FOOTER', order: 3, props: {}, width: 'half' },
    ]);

    // Two SEPARATE rows (HEADER alone, FOOTER alone) — the full block splits them.
    const rowMatches = html.match(/bill-block-row"/g) ?? [];
    expect(rowMatches).toHaveLength(2);
  });

  it('an all-full-width layout (every existing template today) produces zero row wrappers — unchanged from before this change', () => {
    const html = renderHtml([
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
      { type: 'FOOTER', order: 3, props: {} },
    ]);

    expect(html).not.toContain('bill-block-row');
  });

  it('a lone unmatched half block still renders (in its own row wrapper), not dropped', () => {
    const html = renderHtml([
      { type: 'HEADER', order: 1, props: {}, width: 'half' },
      { type: 'FOOTER', order: 2, props: {}, width: 'full' },
    ]);

    expect(html).toContain('bill-block-row-item--half');
    const rowMatches = html.match(/bill-block-row"/g) ?? [];
    expect(rowMatches).toHaveLength(1);
  });
});

import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { renderTemplate, RenderedBlock, BillSnapshot } from './template-renderer';

// S-12-fix: extracted out of app/(preview)/demo/templates/preview-frame/page.tsx for
// the same reason as render-production-bill.ts — Next's typed-route validator rejects
// any page export beyond its allowlist once .next/types is generated. Moved here
// verbatim — same function, same call site, no behavior change.
//
// D-34: mounts the SAME renderer components the public bill page uses — renderTemplate
// + BillBlocks — so the preview iframe's output can never diverge from production.
// Exported so X-1 (render-parity.spec.ts) can call the SAME wiring the preview
// component uses, instead of a spec-local reimplementation that could silently drift.
export function renderPreviewBill(
  doc: LayoutSchemaV2,
  fixture: BillSnapshot,
): { blocks: RenderedBlock[]; skeleton: string } {
  const blocks = renderTemplate(doc.blocks, fixture, {
    name: fixture.merchantName,
    addressLine1: fixture.merchantAddress,
    gstin: fixture.merchantGstin,
  });
  return { blocks, skeleton: doc.skeleton };
}

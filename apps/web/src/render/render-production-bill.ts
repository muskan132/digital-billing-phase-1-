import { renderTemplate, RenderedBlock, LayoutBlock, BillSnapshot, BillMerchant } from './template-renderer';

// TEMPLATE_SYSTEM_v2 §7: the frozen render spec — the ONLY source of layout/skeleton
// for rendering. Never read bill.template.layoutSchema via a live join here again;
// that is the exact bug §7 exists to fix.
export interface BillLayoutSnapshot {
  schemaVersion: number;
  skeleton: string;
  blocks: LayoutBlock[];
  templateId: string;
  templateVersion: number;
}

// S-12-fix: extracted out of app/(main)/[identifier]/page.tsx, which can no longer
// export anything beyond Next's typed-route allowlist (default, metadata, ...) once
// .next/types is generated. Moved here verbatim — same function, same call sites,
// no behavior change. The page imports and re-exposes it internally.
//
// Exported so X-1 (render-parity.spec.ts) can call the SAME wiring the page uses,
// instead of a spec-local reimplementation that could silently drift from what
// actually ships here. Throws exactly as renderTemplate does (D-10, unknown block
// type) — the caller (BillPage) is responsible for catching that, same as before.
export function renderProductionBill(
  layoutSnapshot: BillLayoutSnapshot,
  snapshot: BillSnapshot,
  merchant: BillMerchant,
): { blocks: RenderedBlock[]; skeleton: string } {
  const blocks = renderTemplate(layoutSnapshot.blocks, snapshot, merchant);
  return { blocks, skeleton: layoutSnapshot.skeleton };
}

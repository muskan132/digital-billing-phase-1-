'use client';

// D-34: mounts the SAME renderer components the public bill page uses —
// renderTemplate + BillBlocks, imported directly from src/render, not a
// preview-only reimplementation. This file's only job is: receive a
// (layoutSchema, fixture) pair via postMessage and hand it to those exact
// functions. If this route ever needs anything renderTemplate/BillBlocks
// don't already provide, that's a sign the preview is diverging from
// production, not a reason to add it here.
import { useEffect, useState } from 'react';
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { renderTemplate, RenderedBlock, BillSnapshot } from '../../../../../src/render/template-renderer';
import { BillBlocks } from '../../../../../src/render/BillBlocks';
import { isPreviewMessage, PreviewMessage } from '../../../../../src/builder/preview-protocol';

// Exported so X-1 (render-parity.spec.ts) can call the SAME wiring this
// component uses, instead of a spec-local reimplementation that could
// silently drift from what actually ships here.
export function renderPreviewBill(doc: LayoutSchemaV2, fixture: BillSnapshot): { blocks: RenderedBlock[]; skeleton: string } {
  const blocks = renderTemplate(doc.blocks, fixture, {
    name: fixture.merchantName,
    addressLine1: fixture.merchantAddress,
    gstin: fixture.merchantGstin,
  });
  return { blocks, skeleton: doc.skeleton };
}

export default function PreviewFramePage() {
  const [message, setMessage] = useState<PreviewMessage | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Same-origin iframe (D-34) — reject anything else outright.
      if (event.origin !== window.location.origin) {
        return;
      }
      if (isPreviewMessage(event.data)) {
        setMessage(event.data);
      }
    }
    window.addEventListener('message', onMessage);
    // Tell the parent we're ready to receive — avoids a race where the
    // parent's first postMessage arrives before this listener is attached.
    window.parent.postMessage({ type: 'digital-billing-preview-ready' }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!message) {
    return null; // no builder chrome, no loading text — an empty frame until the first message arrives
  }

  const rendered = renderPreviewBill(message.doc, message.fixture);

  return <BillBlocks blocks={rendered.blocks} skeleton={rendered.skeleton} />;
}

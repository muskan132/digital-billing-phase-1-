'use client';

// U-1: builder shell. Gating is server-side only (DemoOnlyGuard, 404-over-403 —
// same precedent as apps/web/app/demo/page.tsx, which has no web-side gate
// either): this route renders unconditionally and relies on the API 404ing
// every /v1/templates/* call outside dev.
//
// Split-view redesign (post-X-2): COMPONENTS/BILL/FINAL LOOK's 3-tab bar is gone.
// EditBillPanel (left) merges what those first two tabs did into one per-block
// card; FinalLookTab (right) — reused exactly as U-4/D-34 built it, no changes —
// is now permanently mounted instead of behind a tab. No tabs remain because
// nothing is left to switch between; if a genuine second view appears later, a
// tab bar is a small addition then, not something to keep around unused now.
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { useBuilderState } from '../../../../../src/builder/useBuilderState';
import { EditBillPanel } from '../../../../../src/builder/EditBillPanel';
import { FinalLookTab } from '../../../../../src/builder/FinalLookTab';

const API_ORIGIN = 'http://localhost:4000';

interface TemplateRow {
  id: string;
  name: string;
  layoutSchema: LayoutSchemaV2;
}

type LoadState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; template: TemplateRow };

export default function BuilderPage() {
  const params = useParams<{ id: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ status: 'loading' });
  // A stable initial doc for useReducer's lazy init — replaced via load() once
  // the real template arrives, never rendered as-is (loadState gates the UI).
  const builder = useBuilderState({ schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] });

  useEffect(() => {
    let cancelled = false;
    setLoadState({ status: 'loading' });

    fetch(`${API_ORIGIN}/v1/templates/${encodeURIComponent(params.id)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Template fetch failed: HTTP ${res.status}`);
        }
        return res.json() as Promise<TemplateRow>;
      })
      .then((template) => {
        if (cancelled) return;
        builder.load(template.layoutSchema);
        setLoadState({ status: 'ready', template });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setLoadState({ status: 'error', message: err.message });
      });

    return () => {
      cancelled = true;
    };
    // Re-run only when the route's template id changes — `builder` is stable
    // across renders (useReducer + useCallback), including it would refetch
    // on every keystroke-driven draft update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (loadState.status === 'loading') {
    return <p>Loading template…</p>;
  }
  if (loadState.status === 'error') {
    return <p>Failed to load template: {loadState.message}</p>;
  }

  return (
    <div className="builder-shell">
      <header className="builder-header">
        <h1>{loadState.template.name}</h1>
        <div className="builder-undo-redo">
          <button type="button" onClick={builder.undo} disabled={!builder.canUndo}>
            Undo
          </button>
          <button type="button" onClick={builder.redo} disabled={!builder.canRedo}>
            Redo
          </button>
        </div>
      </header>

      <main className="edit-bill-layout">
        <EditBillPanel doc={builder.doc} onEdit={builder.edit} onEditDebounced={builder.editDebounced} />
        <div className="edit-bill-preview">
          <FinalLookTab doc={builder.doc} />
        </div>
      </main>
    </div>
  );
}

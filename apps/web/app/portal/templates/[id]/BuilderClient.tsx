'use client';

// W-3: thin portal-specific host for the UNCHANGED Phase-3 builder
// components — same imports, same props, as the demo builder page
// (app/(main)/demo/templates/[id]/page.tsx). The only new thing here is
// the Save action, wired to the local Route Handler proxy
// (./save/route.ts) instead of a direct API call, since a save needs the
// session cookie + CSRF token neither of which a plain browser fetch to
// the API can reliably carry cross-origin.
import { useState } from 'react';
import { useBuilderState } from '../../../../src/builder/useBuilderState';
import { EditBillPanel } from '../../../../src/builder/EditBillPanel';
import { FinalLookTab } from '../../../../src/builder/FinalLookTab';
import { PortalTemplateRow } from './page';

type SaveState = { status: 'idle' } | { status: 'saving' } | { status: 'error'; message: string };

export function BuilderClient({ template }: { template: PortalTemplateRow }) {
  const builder = useBuilderState(template.layoutSchema);
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });

  async function handleSave() {
    setSaveState({ status: 'saving' });
    try {
      const response = await fetch(`/portal/templates/${encodeURIComponent(template.id)}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          layoutSchema: {
            blocks: builder.doc.blocks,
            ...(builder.doc.theme ? { theme: builder.doc.theme } : {}),
          },
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setSaveState({ status: 'error', message: (data?.message as string) ?? (data?.error_code as string) ?? 'Save failed.' });
        return;
      }
      // D-32: save() always forks — the saved document now lives under a
      // NEW template id, never the one this page was loaded with.
      window.location.href = `/portal/templates/${encodeURIComponent(data.id as string)}`;
    } catch {
      setSaveState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  return (
    <div className="builder-shell">
      <header className="builder-header">
        <h1>{template.name}</h1>
        <div className="builder-undo-redo">
          <button type="button" onClick={builder.undo} disabled={!builder.canUndo}>
            Undo
          </button>
          <button type="button" onClick={builder.redo} disabled={!builder.canRedo}>
            Redo
          </button>
          <button type="button" onClick={handleSave} disabled={saveState.status === 'saving'}>
            {saveState.status === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {saveState.status === 'error' && <p className="portal-builder-save-error">{saveState.message}</p>}

      <main className="edit-bill-layout">
        <EditBillPanel doc={builder.doc} onEdit={builder.edit} onEditDebounced={builder.editDebounced} />
        <div className="edit-bill-preview">
          <FinalLookTab doc={builder.doc} />
        </div>
      </main>
    </div>
  );
}

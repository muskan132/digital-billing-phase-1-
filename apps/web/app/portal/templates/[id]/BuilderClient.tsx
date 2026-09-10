'use client';

// W-3 + F-8: portal-specific host for the UNCHANGED Phase-3 builder components
// (useBuilderState/EditBillPanel/FinalLookTab — imported as-is, zero edits to
// src/builder/*). Write actions go through the local Route Handler proxies
// (./save|save-as/route.ts) which carry the session cookie + CSRF token.
//
// F-8: Save and Save As are two distinct buttons. A STARTER (merchantId: null,
// isStarter=true) offers ONLY Save As — the backend refuses save() on a starter
// with 422 CANNOT_FORK_LIBRARY_PRESET, so the button is hidden rather than
// shown-and-failing. A refusal from either renders the server's NAMED error
// verbatim (extractServerError), never a generic "save failed".
import { useState } from 'react';
import { useBuilderState } from '../../../../src/builder/useBuilderState';
import { EditBillPanel } from '../../../../src/builder/EditBillPanel';
import { FinalLookTab } from '../../../../src/builder/FinalLookTab';
import { extractServerError } from '../../../../src/portal/templates-list.util';
import { PortalTemplateRow } from './page';

type ActionState = { status: 'idle' } | { status: 'busy' } | { status: 'error'; message: string };

export function BuilderClient({ template }: { template: PortalTemplateRow }) {
  const builder = useBuilderState(template.layoutSchema);
  const [state, setState] = useState<ActionState>({ status: 'idle' });
  const [saveAsName, setSaveAsName] = useState('');

  function currentLayoutSchema() {
    return { blocks: builder.doc.blocks, ...(builder.doc.theme ? { theme: builder.doc.theme } : {}) };
  }

  async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  }

  async function handleSave() {
    setState({ status: 'busy' });
    try {
      const { ok, status, json } = await post(`/portal/templates/${encodeURIComponent(template.id)}/save`, {
        layoutSchema: currentLayoutSchema(),
      });
      if (!ok) {
        setState({ status: 'error', message: extractServerError(json, status).message });
        return;
      }
      // D-32: save() always forks — the saved document lives under a NEW id.
      window.location.href = `/portal/templates/${encodeURIComponent((json as { id: string }).id)}`;
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  async function handleSaveAs() {
    if (saveAsName.trim().length === 0) {
      setState({ status: 'error', message: 'Enter a name for the new template.' });
      return;
    }
    setState({ status: 'busy' });
    try {
      const { ok, status, json } = await post(`/portal/templates/${encodeURIComponent(template.id)}/save-as`, {
        name: saveAsName.trim(),
        layoutSchema: currentLayoutSchema(),
      });
      if (!ok) {
        setState({ status: 'error', message: extractServerError(json, status).message });
        return;
      }
      // D-62: Save As creates a NEW lineage — navigate to it.
      window.location.href = `/portal/templates/${encodeURIComponent((json as { id: string }).id)}`;
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  const busy = state.status === 'busy';

  return (
    <div className="builder-shell">
      <header className="builder-header">
        <div>
          <h1>{template.name}</h1>
          {template.isStarter && <span className="builder-starter-tag">Starter — Save As to make it yours</span>}
        </div>
        <div className="builder-toolbar">
          <button type="button" onClick={builder.undo} disabled={!builder.canUndo || busy}>
            Undo
          </button>
          <button type="button" onClick={builder.redo} disabled={!builder.canRedo || busy}>
            Redo
          </button>
          {!template.isStarter && (
            <button type="button" onClick={handleSave} disabled={busy}>
              {busy ? 'Working…' : 'Save'}
            </button>
          )}
          <span className="builder-save-as">
            <input
              type="text"
              placeholder="New template name"
              value={saveAsName}
              onChange={(e) => setSaveAsName(e.target.value)}
              maxLength={120}
              disabled={busy}
            />
            <button type="button" onClick={handleSaveAs} disabled={busy}>
              Save As
            </button>
          </span>
        </div>
      </header>

      {state.status === 'error' && <p className="portal-builder-save-error">{state.message}</p>}

      <main className="edit-bill-layout">
        <EditBillPanel doc={builder.doc} onEdit={builder.edit} onEditDebounced={builder.editDebounced} />
        <div className="edit-bill-preview">
          <FinalLookTab doc={builder.doc} />
        </div>
      </main>
    </div>
  );
}

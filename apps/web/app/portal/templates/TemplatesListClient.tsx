'use client';

// F-8: the /portal/templates list UI. Two visibly separate lists (D-68's
// isStarter projection), the archived view (F-5), create-from-scratch (F-3),
// per-row archive/delete/restore, and the default badge (F-6's two pointers).
// Every mutation goes through the existing server-to-server proxy routes
// (session cookie + CSRF); a refusal renders the server's NAMED error verbatim
// (extractServerError), never a generic "action failed".
//
// Starters (merchantId: null) offer ONLY "Open" — no Save, no Archive, no
// Delete — matching exactly what the backend permits: save() → 422
// CANNOT_FORK_LIBRARY_PRESET, archive()/delete → 404. Save As lives inside the
// builder (it needs the edited layoutSchema), reached via "Open".
import { useState } from 'react';
import {
  defaultBadgeLabel,
  extractServerError,
  PortalTemplateDefaults,
  PortalTemplateListItem,
} from '../../../src/portal/templates-list.util';

const BILL_TYPE_LABELS: Record<string, string> = { RECEIPT: 'Receipt', TAX_INVOICE: 'Tax invoice' };

// D-73: create-from-scratch accepts these skeletons only (UTILITY excluded).
const CREATABLE_SKELETONS = ['MINIMALIST', 'COMPACT_THERMAL', 'TAX_COMPLIANT', 'RETAIL', 'RESTAURANT'] as const;

interface Props {
  mine: PortalTemplateListItem[];
  starters: PortalTemplateListItem[];
  archived: PortalTemplateListItem[];
  defaults: PortalTemplateDefaults | null;
  canWrite: boolean;
}

type RowError = { id: string; error_code: string | null; message: string } | null;

async function postProxy(path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(path, {
    method: 'POST',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

export function TemplatesListClient({ mine, starters, archived, defaults, canWrite }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<RowError>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function runMutation(id: string, path: string) {
    setBusyId(id);
    setRowError(null);
    try {
      const { ok, status, json } = await postProxy(path);
      if (!ok) {
        const err = extractServerError(json, status);
        setRowError({ id, ...err });
        return;
      }
      window.location.reload();
    } catch {
      setRowError({ id, error_code: null, message: 'Could not reach the server.' });
    } finally {
      setBusyId(null);
    }
  }

  const archive = (id: string) => runMutation(id, `/portal/templates/${encodeURIComponent(id)}/archive`);
  const del = (id: string) => runMutation(id, `/portal/templates/${encodeURIComponent(id)}/delete`);
  const restore = (id: string) => runMutation(id, `/portal/templates/${encodeURIComponent(id)}/restore`);

  return (
    <section className="portal-templates">
      <div className="portal-templates-header">
        <h1 className="portal-templates-title">Templates</h1>
        {canWrite && (
          <button type="button" className="portal-templates-create-toggle" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Cancel' : 'Create from scratch'}
          </button>
        )}
      </div>

      {showCreate && canWrite && <CreateFromScratchForm />}

      <h2 className="portal-templates-section-title">My templates</h2>
      {mine.length === 0 ? (
        <p className="portal-templates-empty">You have no templates yet. Open a starter and use Save As, or create one from scratch.</p>
      ) : (
        <ul className="portal-templates-list">
          {mine.map((t) => {
            const badge = defaultBadgeLabel(t.id, defaults);
            return (
              <li key={t.id} className="portal-templates-row">
                <div className="portal-templates-row-main">
                  <a href={`/portal/templates/${encodeURIComponent(t.id)}`} className="portal-templates-row-name">
                    {t.name}
                  </a>
                  {badge && <span className="portal-templates-badge">{badge}</span>}
                  <span className="portal-templates-row-meta">
                    {BILL_TYPE_LABELS[t.billType] ?? t.billType} · v{t.version}
                  </span>
                </div>
                {canWrite && (
                  <div className="portal-templates-row-actions">
                    <button type="button" onClick={() => archive(t.id)} disabled={busyId === t.id}>
                      Archive
                    </button>
                    <button type="button" className="portal-templates-danger" onClick={() => del(t.id)} disabled={busyId === t.id}>
                      Delete
                    </button>
                  </div>
                )}
                {rowError?.id === t.id && (
                  <p className="portal-templates-row-error" data-error-code={rowError.error_code ?? ''}>
                    {rowError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="portal-templates-section-title">Starter templates</h2>
      <p className="portal-templates-section-note">Shared library. Open one and use Save As to make it yours.</p>
      {starters.length === 0 ? (
        <p className="portal-templates-empty">No starters available.</p>
      ) : (
        <ul className="portal-templates-list">
          {starters.map((t) => (
            <li key={t.id} className="portal-templates-row portal-templates-row--starter">
              <div className="portal-templates-row-main">
                <a href={`/portal/templates/${encodeURIComponent(t.id)}`} className="portal-templates-row-name">
                  {t.name}
                </a>
                <span className="portal-templates-row-meta">{BILL_TYPE_LABELS[t.billType] ?? t.billType}</span>
              </div>
              {/* No Save, no Archive, no Delete — the backend permits none of those on a starter. */}
            </li>
          ))}
        </ul>
      )}

      <h2 className="portal-templates-section-title">Archived</h2>
      {archived.length === 0 ? (
        <p className="portal-templates-empty">Nothing archived.</p>
      ) : (
        <ul className="portal-templates-list">
          {archived.map((t) => (
            <li key={t.id} className="portal-templates-row portal-templates-row--archived">
              <div className="portal-templates-row-main">
                <span className="portal-templates-row-name">{t.name}</span>
                <span className="portal-templates-row-meta">{BILL_TYPE_LABELS[t.billType] ?? t.billType} · v{t.version}</span>
              </div>
              {canWrite && (
                <div className="portal-templates-row-actions">
                  <button type="button" onClick={() => restore(t.id)} disabled={busyId === t.id}>
                    Restore
                  </button>
                </div>
              )}
              {rowError?.id === t.id && (
                <p className="portal-templates-row-error" data-error-code={rowError.error_code ?? ''}>
                  {rowError.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateFromScratchForm() {
  const [name, setName] = useState('');
  const [billType, setBillType] = useState('RECEIPT');
  const [skeleton, setSkeleton] = useState<string>(CREATABLE_SKELETONS[0]);
  const [state, setState] = useState<{ status: 'idle' | 'saving' } | { status: 'error'; message: string }>({ status: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) {
      setState({ status: 'error', message: 'Name is required.' });
      return;
    }
    setState({ status: 'saving' });
    try {
      const { ok, status, json } = await postProxy('/portal/templates/create', { name: name.trim(), billType, skeleton });
      if (!ok) {
        setState({ status: 'error', message: extractServerError(json, status).message });
        return;
      }
      const created = json as { id?: string };
      if (created?.id) {
        window.location.href = `/portal/templates/${encodeURIComponent(created.id)}`;
        return;
      }
      window.location.reload();
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  return (
    <form className="portal-templates-create-form" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
      </label>
      <label>
        Bill type
        <select value={billType} onChange={(e) => setBillType(e.target.value)}>
          <option value="RECEIPT">Receipt</option>
          <option value="TAX_INVOICE">Tax invoice</option>
        </select>
      </label>
      <label>
        Skeleton
        <select value={skeleton} onChange={(e) => setSkeleton(e.target.value)}>
          {CREATABLE_SKELETONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={state.status === 'saving'}>
        {state.status === 'saving' ? 'Creating…' : 'Create'}
      </button>
      {state.status === 'error' && <p className="portal-templates-row-error">{state.message}</p>}
    </form>
  );
}

// F-8: /portal/templates — the template list page. Server-side fetch of the
// three read endpoints (list / archived / defaults, all already built and
// tested) plus /portal/me for the role, handed to the client list component.
// Same server-to-server fetch pattern as every other portal page (H-2/W-2/F-6).
import { cookies } from 'next/headers';
import { TemplatesListClient } from './TemplatesListClient';
import {
  partitionTemplates,
  PortalTemplateDefaults,
  PortalTemplateListItem,
} from '../../../src/portal/templates-list.util';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

function isListItem(v: unknown): v is PortalTemplateListItem {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.billType === 'string' &&
    typeof t.skeleton === 'string' &&
    typeof t.version === 'number' &&
    typeof t.isDefault === 'boolean' &&
    typeof t.isStarter === 'boolean'
  );
}

function isDefaultRef(v: unknown): v is { id: string; name: string } {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string';
}

function parseList(v: unknown): PortalTemplateListItem[] | null {
  if (typeof v !== 'object' || v === null) return null;
  const templates = (v as Record<string, unknown>).templates;
  if (!Array.isArray(templates) || !templates.every(isListItem)) return null;
  return templates as PortalTemplateListItem[];
}

function parseArchived(v: unknown): PortalTemplateListItem[] | null {
  if (!Array.isArray(v) || !v.every(isListItem)) return null;
  return v as PortalTemplateListItem[];
}

function parseDefaults(v: unknown): PortalTemplateDefaults | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = v as Record<string, unknown>;
  if (!(d.receipt === null || isDefaultRef(d.receipt))) return null;
  if (!(d.taxInvoice === null || isDefaultRef(d.taxInvoice))) return null;
  return { receipt: (d.receipt as { id: string; name: string } | null) ?? null, taxInvoice: (d.taxInvoice as { id: string; name: string } | null) ?? null };
}

async function fetchJson<T>(path: string, session: string | undefined): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      cache: 'no-store',
      headers: session ? { cookie: `${SESSION_COOKIE}=${session}` } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export default async function PortalTemplatesPage() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;

  const [listRaw, archivedRaw, defaultsRaw, meRaw] = await Promise.all([
    fetchJson<unknown>('/portal/templates', session),
    fetchJson<unknown>('/portal/templates/archived', session),
    fetchJson<unknown>('/portal/templates/defaults', session),
    fetchJson<unknown>('/portal/me', session),
  ]);

  const list = parseList(listRaw);
  const archived = parseArchived(archivedRaw) ?? [];
  const defaults = parseDefaults(defaultsRaw);
  const role = meRaw && typeof meRaw === 'object' ? (meRaw as { role?: unknown }).role : undefined;
  const canWrite = role === 'MERCHANT_ADMIN';

  if (list === null) {
    return (
      <section className="portal-templates">
        <h1 className="portal-templates-title">Templates</h1>
        <p className="portal-templates-error">Something went wrong loading your templates.</p>
      </section>
    );
  }

  const { mine, starters } = partitionTemplates(list);

  return (
    <TemplatesListClient mine={mine} starters={starters} archived={archived} defaults={defaults} canWrite={canWrite} />
  );
}

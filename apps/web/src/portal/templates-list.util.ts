// F-8: pure helpers for the /portal/templates list page. Kept out of the
// client component so the partitioning (D-68), the default-badge derivation
// (F-6's two pointers) and the verbatim-error extraction are unit-tested
// without a browser (apps/web jest is node-env, no testing-library).

export interface PortalTemplateListItem {
  id: string;
  name: string;
  billType: string;
  skeleton: string;
  version: number;
  isDefault: boolean;
  isStarter: boolean;
}

export interface PortalTemplateDefaults {
  receipt: { id: string; name: string } | null;
  taxInvoice: { id: string; name: string } | null;
}

// D-68: split on the isStarter projection (merchantId IS NULL), never on
// anything the UI infers. `mine` and `starters` preserve input order.
export function partitionTemplates(items: PortalTemplateListItem[]): {
  mine: PortalTemplateListItem[];
  starters: PortalTemplateListItem[];
} {
  const mine: PortalTemplateListItem[] = [];
  const starters: PortalTemplateListItem[] = [];
  for (const item of items) {
    (item.isStarter ? starters : mine).push(item);
  }
  return { mine, starters };
}

// F-6: the badge derives from the two default pointers (D-60), not the list
// DTO's isDefault (which is receipt-only until this is the only reader).
// Returns null when the template is neither default.
export function defaultBadgeLabel(templateId: string, defaults: PortalTemplateDefaults | null): string | null {
  if (!defaults) return null;
  if (defaults.receipt?.id === templateId) return 'Receipt default';
  if (defaults.taxInvoice?.id === templateId) return 'Tax invoice default';
  return null;
}

// The roadmap requires the server's NAMED error to reach the UI verbatim
// (e.g. TEMPLATE_HAS_ISSUED_BILLS, CANNOT_ARCHIVE_DEFAULT_TEMPLATE) — never a
// generic "action failed". Prefer the human message; fall back to the code;
// only then a generic. The raw error_code is returned alongside so the UI can
// expose it (a data attribute, a test hook).
export interface ServerError {
  error_code: string | null;
  message: string;
}

export function extractServerError(body: unknown, httpStatus: number): ServerError {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const errorCode = typeof b.error_code === 'string' ? b.error_code : null;
    const message =
      typeof b.message === 'string' && b.message.length > 0
        ? b.message
        : errorCode ?? `Request failed (HTTP ${httpStatus}).`;
    return { error_code: errorCode, message };
  }
  return { error_code: null, message: `Request failed (HTTP ${httpStatus}).` };
}

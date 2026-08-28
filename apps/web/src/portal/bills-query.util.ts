// H-2: pure URL/query helpers for the /portal/bills history page. GET
// /portal/bills (H-1) only ever hands back a forward `nextCursor` — there's
// no server-side "previous" concept. "Back" is implemented client-side as a
// breadcrumb stack of cursors already visited, carried in the `c` query
// param (comma-joined — cursor tokens are base64url, so they can never
// contain a comma). Going back re-issues the exact cursor used to reach an
// earlier page, and H-1's determinism (portal-bills.service.spec.ts) is what
// makes that a real round-trip, not a coincidence.
export interface PortalBillsFilters {
  dateFrom?: string;
  dateTo?: string;
  billType?: string;
  source?: string;
}

export type PortalBillsSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseFilters(searchParams: PortalBillsSearchParams): PortalBillsFilters {
  return {
    dateFrom: firstValue(searchParams.dateFrom) || undefined,
    dateTo: firstValue(searchParams.dateTo) || undefined,
    billType: firstValue(searchParams.billType) || undefined,
    source: firstValue(searchParams.source) || undefined,
  };
}

export function parseCursorStack(searchParams: PortalBillsSearchParams): string[] {
  const raw = firstValue(searchParams.c);
  if (!raw) return [];
  return raw.split(',').filter((token) => token.length > 0);
}

// The cursor for the page currently being viewed — the last breadcrumb, or
// undefined for page 1 (H-1 treats an absent cursor as "first page").
export function currentCursor(cursorStack: string[]): string | undefined {
  return cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;
}

function buildHref(filters: PortalBillsFilters, cursorStack: string[]): string {
  const params = new URLSearchParams();
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
  if (filters.billType) params.set('billType', filters.billType);
  if (filters.source) params.set('source', filters.source);
  if (cursorStack.length > 0) params.set('c', cursorStack.join(','));
  const query = params.toString();
  return query ? `/portal/bills?${query}` : '/portal/bills';
}

// Appends the response's own nextCursor to the breadcrumb trail.
export function nextPageHref(filters: PortalBillsFilters, cursorStack: string[], nextCursor: string): string {
  return buildHref(filters, [...cursorStack, nextCursor]);
}

// Pops the last breadcrumb — re-issues the SAME cursor (or none) that
// produced the page before this one.
export function previousPageHref(filters: PortalBillsFilters, cursorStack: string[]): string {
  return buildHref(filters, cursorStack.slice(0, -1));
}

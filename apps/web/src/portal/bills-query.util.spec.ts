import {
  currentCursor,
  nextPageHref,
  parseCursorStack,
  parseFilters,
  previousPageHref,
} from './bills-query.util';

describe('parseFilters', () => {
  it('reads each filter from search params', () => {
    expect(
      parseFilters({ dateFrom: '2026-08-01', dateTo: '2026-08-31', billType: 'TAX_INVOICE', source: 'DIRECT_API' }),
    ).toEqual({ dateFrom: '2026-08-01', dateTo: '2026-08-31', billType: 'TAX_INVOICE', source: 'DIRECT_API' });
  });

  it('treats missing/empty filters as undefined', () => {
    expect(parseFilters({})).toEqual({ dateFrom: undefined, dateTo: undefined, billType: undefined, source: undefined });
  });

  it('takes the first value if Next hands back an array', () => {
    expect(parseFilters({ billType: ['RECEIPT', 'TAX_INVOICE'] }).billType).toBe('RECEIPT');
  });
});

describe('cursor breadcrumb stack', () => {
  it('parses an empty stack when there is no c param (first page)', () => {
    expect(parseCursorStack({})).toEqual([]);
    expect(currentCursor(parseCursorStack({}))).toBeUndefined();
  });

  it('round-trips a single-cursor stack through the URL', () => {
    const href = nextPageHref({}, [], 'cursorA');
    expect(href).toBe('/portal/bills?c=cursorA');

    const parsed = parseCursorStack({ c: 'cursorA' });
    expect(parsed).toEqual(['cursorA']);
    expect(currentCursor(parsed)).toBe('cursorA');
  });

  it('forward paging appends to the stack, one cursor per page', () => {
    const afterPage2 = nextPageHref({}, ['cursorA'], 'cursorB');
    expect(afterPage2).toBe('/portal/bills?c=cursorA%2CcursorB');
    expect(parseCursorStack({ c: 'cursorA,cursorB' })).toEqual(['cursorA', 'cursorB']);
  });

  it('going back pops the last breadcrumb, landing on the SAME cursor used to reach the prior page', () => {
    const stack = ['cursorA', 'cursorB'];
    const back = previousPageHref({}, stack);
    expect(back).toBe('/portal/bills?c=cursorA');
    expect(parseCursorStack({ c: 'cursorA' })).toEqual(['cursorA']);
  });

  it('going back from page 2 to page 1 drops the c param entirely — same as the original first request', () => {
    const back = previousPageHref({}, ['cursorA']);
    expect(back).toBe('/portal/bills');
    expect(parseCursorStack({})).toEqual([]);
  });

  it('forward then back is a byte-identical round trip of the query string used for the original page', () => {
    const page1Href = '/portal/bills';
    const page2Href = nextPageHref({}, [], 'cursorA');
    const backToPage1Href = previousPageHref({}, parseCursorStack({ c: 'cursorA' }));
    expect(backToPage1Href).toBe(page1Href);
    expect(page2Href).toBe('/portal/bills?c=cursorA');
  });
});

describe('filters are preserved across pagination links', () => {
  it('keeps every filter param on next/previous links', () => {
    const filters = { billType: 'RECEIPT', source: 'PG_CALLBACK' };
    expect(nextPageHref(filters, [], 'x')).toBe('/portal/bills?billType=RECEIPT&source=PG_CALLBACK&c=x');
    expect(previousPageHref(filters, ['x', 'y'])).toBe('/portal/bills?billType=RECEIPT&source=PG_CALLBACK&c=x');
  });
});

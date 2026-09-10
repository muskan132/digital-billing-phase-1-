import {
  defaultBadgeLabel,
  extractServerError,
  partitionTemplates,
  PortalTemplateDefaults,
  PortalTemplateListItem,
} from './templates-list.util';

function item(overrides: Partial<PortalTemplateListItem>): PortalTemplateListItem {
  return {
    id: 'tpl',
    name: 'T',
    billType: 'RECEIPT',
    skeleton: 'MINIMALIST',
    version: 1,
    isDefault: false,
    isStarter: false,
    ...overrides,
  };
}

describe('partitionTemplates (D-68)', () => {
  it('splits on isStarter, preserving order within each group', () => {
    const items = [
      item({ id: 'a', isStarter: false }),
      item({ id: 's1', isStarter: true }),
      item({ id: 'b', isStarter: false }),
      item({ id: 's2', isStarter: true }),
    ];
    const { mine, starters } = partitionTemplates(items);
    expect(mine.map((t) => t.id)).toEqual(['a', 'b']);
    expect(starters.map((t) => t.id)).toEqual(['s1', 's2']);
  });

  it('handles all-starters and all-mine', () => {
    expect(partitionTemplates([item({ isStarter: true })]).mine).toEqual([]);
    expect(partitionTemplates([item({ isStarter: false })]).starters).toEqual([]);
    expect(partitionTemplates([])).toEqual({ mine: [], starters: [] });
  });
});

describe('defaultBadgeLabel (F-6 / D-60)', () => {
  const defaults: PortalTemplateDefaults = {
    receipt: { id: 'r1', name: 'Minimal Receipt' },
    taxInvoice: { id: 't1', name: 'Tax Invoice' },
  };

  it('labels the receipt default and the tax-invoice default distinctly', () => {
    expect(defaultBadgeLabel('r1', defaults)).toBe('Receipt default');
    expect(defaultBadgeLabel('t1', defaults)).toBe('Tax invoice default');
  });

  it('returns null for a non-default template, and when defaults are absent', () => {
    expect(defaultBadgeLabel('other', defaults)).toBeNull();
    expect(defaultBadgeLabel('r1', null)).toBeNull();
    expect(defaultBadgeLabel('x', { receipt: null, taxInvoice: null })).toBeNull();
  });
});

describe('extractServerError — the server NAMED error reaches the UI verbatim', () => {
  it('prefers the human message', () => {
    expect(
      extractServerError({ error_code: 'TEMPLATE_HAS_ISSUED_BILLS', message: 'This template has issued bills and cannot be deleted — archive it instead.' }, 422),
    ).toEqual({
      error_code: 'TEMPLATE_HAS_ISSUED_BILLS',
      message: 'This template has issued bills and cannot be deleted — archive it instead.',
    });
  });

  it('falls back to the error_code when there is no message', () => {
    expect(extractServerError({ error_code: 'CANNOT_ARCHIVE_DEFAULT_TEMPLATE' }, 422)).toEqual({
      error_code: 'CANNOT_ARCHIVE_DEFAULT_TEMPLATE',
      message: 'CANNOT_ARCHIVE_DEFAULT_TEMPLATE',
    });
  });

  it('never returns a bare generic when the server named the failure', () => {
    const { message } = extractServerError({ error_code: 'CANNOT_DELETE_DEFAULT_TEMPLATE', message: 'This is a current default template — choose a different default before deleting it.' }, 422);
    expect(message).not.toMatch(/failed|went wrong/i);
    expect(message).toContain('current default template');
  });

  it('degrades to a generic only when the body carries nothing usable', () => {
    expect(extractServerError(null, 500)).toEqual({ error_code: null, message: 'Request failed (HTTP 500).' });
    expect(extractServerError('<!doctype html>', 502)).toEqual({ error_code: null, message: 'Request failed (HTTP 502).' });
  });
});

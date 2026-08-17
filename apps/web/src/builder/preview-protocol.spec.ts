import { isPreviewMessage, PREVIEW_MESSAGE_TYPE } from './preview-protocol';

describe('isPreviewMessage', () => {
  it('accepts a well-formed preview message', () => {
    expect(isPreviewMessage({ type: PREVIEW_MESSAGE_TYPE, doc: {}, fixture: {} })).toBe(true);
  });

  it('rejects messages of a different type (e.g. the ready handshake)', () => {
    expect(isPreviewMessage({ type: 'digital-billing-preview-ready' })).toBe(false);
  });

  it('rejects non-object / null / undefined payloads without throwing', () => {
    expect(isPreviewMessage(null)).toBe(false);
    expect(isPreviewMessage(undefined)).toBe(false);
    expect(isPreviewMessage('a string')).toBe(false);
    expect(isPreviewMessage(42)).toBe(false);
  });

  it('rejects an object with no type key', () => {
    expect(isPreviewMessage({ doc: {}, fixture: {} })).toBe(false);
  });
});

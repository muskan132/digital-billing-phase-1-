// U-4 / D-34: the single message shape both the builder (sender) and the
// preview-frame route (receiver) agree on. F-1's fixtures already match
// BillSnapshot field-for-field (both modeled on the D-28 whitelist), so this
// reuses that type directly rather than inventing a parallel one.
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { BillSnapshot } from '../render/template-renderer';

export const PREVIEW_MESSAGE_TYPE = 'digital-billing-preview' as const;

export interface PreviewMessage {
  type: typeof PREVIEW_MESSAGE_TYPE;
  doc: LayoutSchemaV2;
  fixture: BillSnapshot;
}

export function isPreviewMessage(data: unknown): data is PreviewMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === PREVIEW_MESSAGE_TYPE;
}

// U-1: draft state for the template builder (D-37 — undo/redo in its cheap
// form only: a bounded snapshot stack, no command/inverse-operation model).
// `doc` is exactly a LayoutSchemaV2 — no wrapper shape — so U-4/X-1 can pass
// it straight to the shared renderer without a translation layer.
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';

const HISTORY_CAP = 50;

export interface BuilderState {
  doc: LayoutSchemaV2;
  history: LayoutSchemaV2[];
  future: LayoutSchemaV2[];
  // The doc as it was immediately before the CURRENT debounce burst started —
  // set on the first EDIT_DEBOUNCED of a burst, cleared (and turned into one
  // history entry) on FLUSH_DEBOUNCE. Coalesces N keystrokes into 1 undo step.
  pendingBase: LayoutSchemaV2 | null;
}

export type BuilderAction =
  | { type: 'LOAD'; doc: LayoutSchemaV2 }
  | { type: 'EDIT'; doc: LayoutSchemaV2 }
  | { type: 'EDIT_DEBOUNCED'; doc: LayoutSchemaV2 }
  | { type: 'FLUSH_DEBOUNCE' }
  | { type: 'UNDO' }
  | { type: 'REDO' };

export function initBuilderState(doc: LayoutSchemaV2): BuilderState {
  return { doc, history: [], future: [], pendingBase: null };
}

function pushHistory(history: LayoutSchemaV2[], entry: LayoutSchemaV2): LayoutSchemaV2[] {
  const next = [...history, entry];
  // Drop the OLDEST entries once over cap — undo should still reach back 50
  // steps from the current point, not lose the most recent ones.
  return next.length > HISTORY_CAP ? next.slice(next.length - HISTORY_CAP) : next;
}

export function builderReducer(state: BuilderState, action: BuilderAction): BuilderState {
  switch (action.type) {
    case 'LOAD':
      // A fresh load discards any in-progress draft/history entirely (D-37 —
      // no cross-session recovery, no false "you have unsaved changes" state).
      return initBuilderState(action.doc);

    case 'EDIT': {
      // Any pending debounce burst is folded in as its own history entry
      // first, so an immediate edit (e.g. a toggle) right after typing
      // doesn't silently discard the typed change's undo step.
      const base = state.pendingBase ?? state.doc;
      return {
        doc: action.doc,
        history: pushHistory(state.history, base),
        future: [],
        pendingBase: null,
      };
    }

    case 'EDIT_DEBOUNCED':
      // Live-updates doc for responsiveness; history isn't touched until
      // FLUSH_DEBOUNCE (dispatched by the hook after a pause in typing).
      return {
        ...state,
        doc: action.doc,
        pendingBase: state.pendingBase ?? state.doc,
        future: [],
      };

    case 'FLUSH_DEBOUNCE': {
      if (state.pendingBase === null) {
        return state; // nothing pending — not an error, just a no-op
      }
      return {
        ...state,
        history: pushHistory(state.history, state.pendingBase),
        pendingBase: null,
      };
    }

    case 'UNDO': {
      // Fold any pending debounce burst into history first, so undo's first
      // press always reverts the most recent COMPLETE edit, typed or not.
      const flushed = state.pendingBase !== null ? builderReducer(state, { type: 'FLUSH_DEBOUNCE' }) : state;
      if (flushed.history.length === 0) {
        return flushed;
      }
      const previous = flushed.history[flushed.history.length - 1];
      return {
        doc: previous,
        history: flushed.history.slice(0, -1),
        future: [...flushed.future, flushed.doc],
        pendingBase: null,
      };
    }

    case 'REDO': {
      if (state.future.length === 0) {
        return state;
      }
      const next = state.future[state.future.length - 1];
      return {
        doc: next,
        history: pushHistory(state.history, state.doc),
        future: state.future.slice(0, -1),
        pendingBase: null,
      };
    }

    default:
      return state;
  }
}

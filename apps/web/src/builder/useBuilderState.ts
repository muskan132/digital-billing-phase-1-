'use client';

// U-1: React-side wiring around builderReducer — the debounce timer and the
// Ctrl+Z/Ctrl+Shift+Z listener live here, kept out of the reducer so the
// reducer itself stays a pure, synchronously-testable function (D-37).
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { builderReducer, initBuilderState } from './builder-reducer';

const DEBOUNCE_MS = 400;

export function useBuilderState(initialDoc: LayoutSchemaV2) {
  const [state, dispatch] = useReducer(builderReducer, initialDoc, initBuilderState);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback((doc: LayoutSchemaV2) => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    dispatch({ type: 'LOAD', doc });
  }, []);

  // For discrete edits — toggles, reorders, add/remove (U-2/U-3's non-text actions).
  const edit = useCallback((doc: LayoutSchemaV2) => {
    dispatch({ type: 'EDIT', doc });
  }, []);

  // For text-field edits — coalesces a typing burst into one undo step (D-37).
  const editDebounced = useCallback((doc: LayoutSchemaV2) => {
    dispatch({ type: 'EDIT_DEBOUNCED', doc });
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
    }
    flushTimer.current = setTimeout(() => {
      dispatch({ type: 'FLUSH_DEBOUNCE' });
      flushTimer.current = null;
    }, DEBOUNCE_MS);
  }, []);

  const undo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatch({ type: 'REDO' }), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) {
        redo();
      } else {
        undo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  // Reload = fresh mount = fresh initBuilderState from the server-fetched doc.
  // No persistence anywhere in this hook (D-37) — nothing to clean up beyond the timer.
  useEffect(() => {
    return () => {
      if (flushTimer.current) {
        clearTimeout(flushTimer.current);
      }
    };
  }, []);

  return {
    doc: state.doc,
    canUndo: state.history.length > 0 || state.pendingBase !== null,
    canRedo: state.future.length > 0,
    load,
    edit,
    editDebounced,
    undo,
    redo,
  };
}

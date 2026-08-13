import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { builderReducer, BuilderState, initBuilderState } from './builder-reducer';

function doc(blocks: LayoutSchemaV2['blocks']): LayoutSchemaV2 {
  return { schemaVersion: 2, skeleton: 'MINIMALIST', blocks };
}

const ORIGINAL = doc([
  { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
  { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
]);

function withLabel(base: LayoutSchemaV2, label: string): LayoutSchemaV2 {
  return { ...base, blocks: base.blocks.map((b) => (b.id === 'blk_2' ? { ...b, props: { label } } : b)) };
}

describe('builderReducer', () => {
  it('LOAD sets doc and clears history/future/pendingBase', () => {
    const state = builderReducer(initBuilderState(doc([])), { type: 'LOAD', doc: ORIGINAL });
    expect(state).toEqual({ doc: ORIGINAL, history: [], future: [], pendingBase: null });
  });

  it('EDIT pushes the previous doc onto history', () => {
    const s0 = initBuilderState(ORIGINAL);
    const edited = withLabel(ORIGINAL, 'v1');
    const s1 = builderReducer(s0, { type: 'EDIT', doc: edited });

    expect(s1.doc).toBe(edited);
    expect(s1.history).toEqual([ORIGINAL]);
    expect(s1.future).toEqual([]);
  });

  it('5 edits then 5 undos returns exactly the original document', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    for (let i = 1; i <= 5; i++) {
      state = builderReducer(state, { type: 'EDIT', doc: withLabel(state.doc, `v${i}`) });
    }
    for (let i = 0; i < 5; i++) {
      state = builderReducer(state, { type: 'UNDO' });
    }
    expect(state.doc).toEqual(ORIGINAL);
    expect(state.history).toEqual([]);
  });

  it('redo replays undone edits back in order', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    const edits = [1, 2, 3, 4, 5].map((i) => withLabel(ORIGINAL, `v${i}`));
    for (const e of edits) {
      state = builderReducer(state, { type: 'EDIT', doc: e });
    }
    const afterEdits = state;

    for (let i = 0; i < 5; i++) {
      state = builderReducer(state, { type: 'UNDO' });
    }
    for (let i = 0; i < 5; i++) {
      state = builderReducer(state, { type: 'REDO' });
    }

    expect(state.doc).toEqual(afterEdits.doc);
    expect(state.history).toEqual(afterEdits.history);
    expect(state.future).toEqual([]);
  });

  it('a new EDIT after undo clears the redo stack', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    state = builderReducer(state, { type: 'EDIT', doc: withLabel(ORIGINAL, 'v1') });
    state = builderReducer(state, { type: 'UNDO' });
    expect(state.future).toHaveLength(1);

    state = builderReducer(state, { type: 'EDIT', doc: withLabel(ORIGINAL, 'branch') });
    expect(state.future).toEqual([]);
  });

  it('history is capped at 50 entries, dropping the oldest first', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    for (let i = 1; i <= 55; i++) {
      state = builderReducer(state, { type: 'EDIT', doc: withLabel(state.doc, `v${i}`) });
    }
    expect(state.history).toHaveLength(50);
    // The oldest surviving entry should be v4 (v1..v4-the-base entries for
    // edits 1-5 dropped), not the very first ORIGINAL doc.
    expect(state.history[0]).not.toEqual(ORIGINAL);
  });

  it('UNDO/REDO are no-ops at the boundaries, not errors', () => {
    const s0 = initBuilderState(ORIGINAL);
    expect(builderReducer(s0, { type: 'UNDO' })).toEqual(s0);
    expect(builderReducer(s0, { type: 'REDO' })).toEqual(s0);
  });

  it('EDIT_DEBOUNCED updates doc live but does not push a history entry until FLUSH_DEBOUNCE', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    state = builderReducer(state, { type: 'EDIT_DEBOUNCED', doc: withLabel(ORIGINAL, 'typing-1') });
    state = builderReducer(state, { type: 'EDIT_DEBOUNCED', doc: withLabel(ORIGINAL, 'typing-12') });
    state = builderReducer(state, { type: 'EDIT_DEBOUNCED', doc: withLabel(ORIGINAL, 'typing-123') });

    expect(state.doc).toEqual(withLabel(ORIGINAL, 'typing-123'));
    expect(state.history).toEqual([]); // no checkpoint yet — one burst, zero commits so far

    state = builderReducer(state, { type: 'FLUSH_DEBOUNCE' });
    expect(state.history).toEqual([ORIGINAL]); // the WHOLE burst collapses into one entry
    expect(state.pendingBase).toBeNull();
  });

  it('a single Ctrl+Z after a debounced text-edit burst undoes the whole burst, not one keystroke', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    state = builderReducer(state, { type: 'EDIT_DEBOUNCED', doc: withLabel(ORIGINAL, 'ty') });
    state = builderReducer(state, { type: 'EDIT_DEBOUNCED', doc: withLabel(ORIGINAL, 'typ') });
    state = builderReducer(state, { type: 'EDIT_DEBOUNCED', doc: withLabel(ORIGINAL, 'typi') });
    // No FLUSH_DEBOUNCE dispatched yet (as if the debounce timer hasn't fired) —
    // UNDO must still fold the pending burst in as one step, not lose it.
    state = builderReducer(state, { type: 'UNDO' });

    expect(state.doc).toEqual(ORIGINAL);
    expect(state.future).toEqual([withLabel(ORIGINAL, 'typi')]);
  });

  it('FLUSH_DEBOUNCE with nothing pending is a no-op', () => {
    const s0 = initBuilderState(ORIGINAL);
    expect(builderReducer(s0, { type: 'FLUSH_DEBOUNCE' })).toEqual(s0);
  });

  it('block ids survive an edit untouched — identity is preserved', () => {
    let state: BuilderState = initBuilderState(ORIGINAL);
    state = builderReducer(state, { type: 'EDIT', doc: withLabel(ORIGINAL, 'renamed') });

    expect(state.doc.blocks.map((b) => b.id)).toEqual(ORIGINAL.blocks.map((b) => b.id));
  });
});

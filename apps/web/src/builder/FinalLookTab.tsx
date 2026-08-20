'use client';

// U-4: the parent-side half of D-34's architecture. This component owns NO
// rendering logic of its own — it only fetches F-1's fixtures, lets the
// merchant pick one, and posts (doc, fixture) into the iframe on every
// change. All actual bill markup comes from the iframe at
// /demo/templates/preview-frame, which mounts the same renderTemplate/
// BillBlocks the public bill page uses.
import { useEffect, useRef, useState } from 'react';
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { BillSnapshot } from '../render/template-renderer';
import { PREVIEW_MESSAGE_TYPE } from './preview-protocol';

const API_ORIGIN = 'http://localhost:4000';

export interface FinalLookTabProps {
  doc: LayoutSchemaV2;
}

type FixturesState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; fixtures: Record<string, BillSnapshot> };

export function FinalLookTab({ doc }: FinalLookTabProps) {
  const [fixturesState, setFixturesState] = useState<FixturesState>({ status: 'loading' });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameReady = useRef(false);

  useEffect(() => {
    fetch(`${API_ORIGIN}/v1/fixtures`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Record<string, BillSnapshot>>;
      })
      .then((fixtures) => {
        setFixturesState({ status: 'ready', fixtures });
        setSelectedKey((prev) => prev ?? Object.keys(fixtures)[0] ?? null);
      })
      .catch(() => setFixturesState({ status: 'error' }));
  }, []);

  function post() {
    if (fixturesState.status !== 'ready' || !selectedKey || !frameReady.current) {
      return;
    }
    const fixture = fixturesState.fixtures[selectedKey];
    iframeRef.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE_TYPE, doc, fixture }, window.location.origin);
  }

  // Always call the CURRENT render's post() from the mount-only message
  // listener below, never a stale closure. Without this, the "ready" message
  // (which can arrive before the /v1/fixtures fetch resolves) would run the
  // post() captured at mount time — closed over fixturesState:'loading' and
  // selectedKey:null — and silently no-op, leaving the preview blank until
  // some later state change happened to fire post() again after frameReady
  // was already true.
  const postRef = useRef(post);
  postRef.current = post;

  // Re-post whenever the draft or the selected fixture changes — no network
  // call, just an in-browser postMessage (D-34).
  useEffect(() => {
    post();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selectedKey, fixturesState]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'digital-billing-preview-ready') {
        frameReady.current = true;
        postRef.current();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (fixturesState.status === 'loading') {
    return <p>Loading fixtures…</p>;
  }
  if (fixturesState.status === 'error') {
    return <p>Failed to load preview fixtures.</p>;
  }

  return (
    <div className="final-look-tab">
      <label>
        Fixture:
        <select value={selectedKey ?? ''} onChange={(e) => setSelectedKey(e.target.value)}>
          {Object.keys(fixturesState.fixtures).map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
      </label>

      <iframe
        ref={iframeRef}
        className="final-look-frame"
        src="/demo/templates/preview-frame"
        title="Bill preview"
        onLoad={() => {
          // The frame's own effect sends "ready" once its listener is attached
          // (handles the load-order race); this onLoad is a fallback for the
          // (rare) case that message arrives before this handler is wired.
          post();
        }}
      />
    </div>
  );
}

'use client';

// R-2 (D-69/D-79): the "Resend" control on the bill detail page. Rendered only
// when the bill has a FAILED broadcast, no PENDING one, and the viewer is
// MERCHANT_ADMIN (all decided server-side in page.tsx). POSTs to the local
// proxy route (session cookie + CSRF); a refusal shows the server's named
// error verbatim (RESEND_ALREADY_PENDING / NO_FAILED_BROADCAST).
import { useState } from 'react';
import { extractServerError } from '../../../../src/portal/templates-list.util';

type State = { status: 'idle' } | { status: 'sending' } | { status: 'error'; message: string };

export function ResendButton({ billId }: { billId: string }) {
  const [state, setState] = useState<State>({ status: 'idle' });

  async function resend() {
    setState({ status: 'sending' });
    try {
      const res = await fetch(`/portal/bills/${encodeURIComponent(billId)}/resend`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        setState({ status: 'error', message: extractServerError(json, res.status).message });
        return;
      }
      window.location.reload();
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  return (
    <div className="portal-bill-detail-resend">
      <button type="button" onClick={resend} disabled={state.status === 'sending'}>
        {state.status === 'sending' ? 'Re-queuing…' : 'Resend delivery'}
      </button>
      {state.status === 'error' && <p className="portal-bill-detail-resend-error">{state.message}</p>}
    </div>
  );
}

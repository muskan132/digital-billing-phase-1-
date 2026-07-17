'use client';

import { useState } from 'react';
import { Share2, Check } from 'lucide-react';

// Prop-free by design, same boundary as DownloadButton: the page above this component
// is a Server Component so the L-2 whitelist never crosses the client boundary (see V-2).
// This button must never receive bill/customer data — it only needs the current URL,
// which it reads itself from window.location. Local state below is UI-only (idle/copied/
// failed), never bill/customer data.
export function ShareButton() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ url });
      } catch {
        // User cancelled the share sheet — not an error.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      // Insecure context, permission denial, etc. — surface it instead of failing silently.
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <button type="button" onClick={handleShare} className="btn-share">
      {copyState === 'copied' ? <Check size={16} aria-hidden="true" /> : <Share2 size={16} aria-hidden="true" />}
      {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? "Couldn't copy — try again" : 'Share'}
    </button>
  );
}

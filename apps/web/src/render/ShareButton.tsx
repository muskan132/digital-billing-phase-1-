'use client';

import { useState } from 'react';
import { Share2, Check } from 'lucide-react';

// Prop-free by design, same boundary as DownloadButton: the page above this component
// is a Server Component so the L-2 whitelist never crosses the client boundary (see V-2).
// This button must never receive bill/customer data — it only needs the current URL,
// which it reads itself from window.location. Local state below is UI-only (a boolean),
// never bill/customer data.
export function ShareButton() {
  const [copied, setCopied] = useState(false);

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
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button type="button" onClick={handleShare} className="btn-share">
      {copied ? <Check size={16} aria-hidden="true" /> : <Share2 size={16} aria-hidden="true" />}
      {copied ? 'Copied' : 'Share'}
    </button>
  );
}

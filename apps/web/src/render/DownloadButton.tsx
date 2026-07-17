'use client';

import { Download } from 'lucide-react';

// Prop-free by design: the page above this component is a Server Component so the
// L-2 whitelist never crosses the client boundary (see V-2). window.print() only
// needs the DOM already rendered server-side — it must never receive bill/customer data.
export function DownloadButton() {
  return (
    <button type="button" onClick={() => window.print()} className="btn-download">
      <Download size={16} aria-hidden="true" />
      Download PDF
    </button>
  );
}

// D-34: an INDEPENDENT root layout (own <html>/<body>) — Next.js App Router route
// groups with their own layout.tsx get their own document, sharing nothing with
// app/(main)/layout.tsx. Imports ONLY bill.css, never globals.css — this is what
// makes "the frame document contains no builder CSS" structurally true rather than
// coincidentally true today. Never add anything else here; every future builder-chrome
// style belongs in globals.css (app/(main)), not here.
import '../bill.css';

export default function PreviewRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

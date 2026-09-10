import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import '../globals.css';
import { LogoutButton } from './LogoutButton';

// W-1: portal shell. middleware.ts is the auth gate (redirects to login with
// returnTo before this ever renders); this layout trusts that and only
// re-fetches /portal/me for the nav's own display data (merchant name,
// role) — sourced from the session via MerchantContext server-side, never a
// query param or client-side state. No business data here (H-1/W-2/W-3).
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? API_BASE_URL;
const SESSION_COOKIE = 'session';

interface PortalMe {
  merchantName: string;
  role: string;
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);

  // Should not happen — middleware already required a session cookie to
  // reach here. Falls back to login rather than rendering with no identity.
  if (!sessionCookie) {
    redirect(`${AUTH_BASE_URL}/auth/login?returnTo=%2Fportal`);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/portal/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` },
      cache: 'no-store',
    });
  } catch {
    redirect(`${AUTH_BASE_URL}/auth/login?returnTo=%2Fportal`);
  }

  if (!response.ok) {
    redirect(`${AUTH_BASE_URL}/auth/login?returnTo=%2Fportal`);
  }

  const me = (await response.json()) as PortalMe;

  return (
    <html lang="en">
      <body>
        <div className="portal-shell">
          <header className="portal-nav">
            <span className="portal-nav-brand">Digital Billing</span>
            <nav className="portal-nav-links">
              <a href="/portal">Dashboard</a>
              <a href="/portal/templates">Templates</a>
              <a href="/portal/bills">Bills</a>
            </nav>
            <div className="portal-nav-account">
              <span className="portal-nav-merchant">{me.merchantName}</span>
              <LogoutButton />
            </div>
          </header>
          <main className="portal-main">{children}</main>
        </div>
      </body>
    </html>
  );
}

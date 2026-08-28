'use client';

// W-1: posts to the Next route handler at /portal/logout (never the API
// directly — see app/portal/logout/route.ts), then does a full navigation
// so middleware re-runs, sees the now-cleared session cookie, and redirects
// to login itself. No login-URL knowledge needed here.
export function LogoutButton() {
  async function handleLogout() {
    await fetch('/portal/logout', { method: 'POST' });
    window.location.assign('/portal');
  }

  return (
    <button type="button" onClick={handleLogout} className="portal-logout-button">
      Log out
    </button>
  );
}

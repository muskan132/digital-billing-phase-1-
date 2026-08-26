// Manual Cookie header parsing — no cookie-parser dependency needed. Reading
// is the only thing Express's Response doesn't do natively; writing/clearing
// uses res.cookie()/res.clearCookie(), which are core Express, not middleware.
export function parseCookies(header: string | undefined): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) {
    return jar;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(value);
    } catch {
      jar[name] = value;
    }
  }
  return jar;
}

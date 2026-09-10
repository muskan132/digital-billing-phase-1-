// R-1: /portal/deliveries — broadcast status counts + the FAILED list. A pure
// server-rendered read (no actions — R-2's resend lives on the bill page); the
// failed rows link to /portal/bills/:id where that button is. Same
// server-to-server fetch pattern as every other portal page.
import { cookies } from 'next/headers';
import { isPortalDeliveriesResponse, retryLabel } from '../../../src/portal/deliveries.util';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

const CHANNEL_LABELS: Record<string, string> = { EMAIL: 'Email', SMS: 'SMS' };

export default async function PortalDeliveriesPage() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;

  let raw: unknown = null;
  try {
    const res = await fetch(`${API_BASE_URL}/portal/deliveries`, {
      cache: 'no-store',
      headers: session ? { cookie: `${SESSION_COOKIE}=${session}` } : {},
    });
    if (res.ok) raw = await res.json();
  } catch {
    raw = null;
  }

  if (!isPortalDeliveriesResponse(raw)) {
    return (
      <section className="portal-deliveries">
        <h1 className="portal-deliveries-title">Deliveries</h1>
        <p className="portal-deliveries-error">Something went wrong loading your delivery status.</p>
      </section>
    );
  }

  const { counts, maxAttempts, failed } = raw;

  return (
    <section className="portal-deliveries">
      <h1 className="portal-deliveries-title">Deliveries</h1>

      <div className="portal-deliveries-tiles">
        <div className="portal-deliveries-tile">
          <span className="portal-deliveries-tile-n">{counts.SENT}</span>
          <span className="portal-deliveries-tile-label">Sent</span>
        </div>
        <div className="portal-deliveries-tile">
          <span className="portal-deliveries-tile-n">{counts.PENDING}</span>
          <span className="portal-deliveries-tile-label">Pending</span>
        </div>
        <div className="portal-deliveries-tile portal-deliveries-tile--failed">
          <span className="portal-deliveries-tile-n">{counts.FAILED}</span>
          <span className="portal-deliveries-tile-label">Failed</span>
        </div>
      </div>

      <h2 className="portal-deliveries-section-title">Failed deliveries</h2>
      {failed.length === 0 ? (
        <p className="portal-deliveries-empty">No failed deliveries.</p>
      ) : (
        <table className="portal-deliveries-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Recipient</th>
              <th>Attempts</th>
              <th>Bill</th>
            </tr>
          </thead>
          <tbody>
            {failed.map((f, i) => {
              const label = retryLabel(f.attempts, maxAttempts);
              return (
                <tr key={i}>
                  <td>{CHANNEL_LABELS[f.channel] ?? f.channel}</td>
                  <td>{f.recipientMasked ?? '—'}</td>
                  <td className={label.exhausted ? 'portal-deliveries-exhausted' : undefined}>{label.text}</td>
                  <td>
                    {f.billId ? (
                      <a href={`/portal/bills/${encodeURIComponent(f.billId)}`}>View bill</a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {failed.length >= 200 && (
        <p className="portal-deliveries-empty">Showing the 200 most recent failed deliveries.</p>
      )}
    </section>
  );
}

// Static engagement placeholder the RETAIL QR_CODE block points to — a real,
// scannable destination, not a dead link. No data lookup: `code` is just the
// route segment, echoed back as plain text (never bill/customer data).
export default async function OfferPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  return (
    <div className="demo-panel">
      <div className="demo-section" style={{ textAlign: 'center' }}>
        <h1>Show this code at checkout</h1>
        <p style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '2px', margin: '16px 0' }}>{code}</p>
      </div>
    </div>
  );
}

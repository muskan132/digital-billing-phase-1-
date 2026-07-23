import { AMOUNT_UNAVAILABLE } from './template-renderer';

// Shared formatter per docs/UI_STYLE_v1.md ("Money renders from integer paise via a
// shared formatter — no ad hoc arithmetic in components") and D-2 (never float).
// Formats an integer-paise string into a "rupees.paise" display string using only
// BigInt arithmetic. Anything that isn't a valid integer-paise string (including the
// AMOUNT_UNAVAILABLE marker) is passed through unchanged rather than coerced.
export function formatPaise(paise: string): string {
  if (paise === AMOUNT_UNAVAILABLE || !/^-?\d+$/.test(paise)) {
    return paise;
  }

  const value = BigInt(paise);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const rupees = abs / BigInt(100);
  const remainder = (abs % BigInt(100)).toString().padStart(2, '0');

  return `${negative ? '-' : ''}${rupees.toString()}.${remainder}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
};

// Prefixes a currency symbol onto formatPaise's output for consistent display across
// both receipt skins. The AMOUNT_UNAVAILABLE marker is passed through unchanged — it's
// not a real amount, so it must never gain a currency prefix.
export function formatMoney(paise: string, currency: string): string {
  const formatted = formatPaise(paise);
  if (formatted === AMOUNT_UNAVAILABLE) {
    return formatted;
  }

  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${symbol}${formatted}`;
}

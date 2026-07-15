const RUPEES_PATTERN = /^\d+\.\d{1,2}$/;

export function rupeesToPaise(amount: string): bigint {
  if (!RUPEES_PATTERN.test(amount)) {
    throw new Error(`Invalid rupee amount: ${amount}`);
  }
  const [rupees, fraction] = amount.split('.');
  const paiseFraction = fraction.length === 1 ? fraction + '0' : fraction;
  return BigInt(rupees) * 100n + BigInt(paiseFraction);
}

const RUPEES_PATTERN = /^\d+\.\d{2}$/;

export function rupeesToPaise(amount: string): bigint {
  if (!RUPEES_PATTERN.test(amount)) {
    throw new Error(`Invalid rupee amount: ${amount}`);
  }
  const [rupees, fraction] = amount.split('.');
  return BigInt(rupees) * 100n + BigInt(fraction);
}

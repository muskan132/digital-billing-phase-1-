export function maskMobile(mobile: string | undefined): string {
  if (!mobile) return '(absent)';
  if (mobile.length <= 4) return '*'.repeat(mobile.length);
  return mobile.slice(0, 2) + '*'.repeat(mobile.length - 4) + mobile.slice(-2);
}

export function maskEmail(email: string | undefined): string {
  if (!email) return '(absent)';
  const [local, domain] = email.split('@');
  if (!domain) return '*'.repeat(email.length);
  const maskedLocal = local.length <= 1 ? '*' : local[0] + '*'.repeat(local.length - 1);
  return `${maskedLocal}@${domain}`;
}

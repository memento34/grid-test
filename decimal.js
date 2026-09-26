// Decimal bookkeeping: 18 fractional digits, no floating point quantity arithmetic.
export const SCALE = 10n ** 18n;
export function dec(value) {
  const m = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!m) throw new Error('Geçersiz ondalık: ' + String(value));
  const exponent = Number(m[4] || 0);
  if (Math.abs(exponent) > 100) throw new Error('Ondalık üs sınır dışında.');
  const digits = m[2] + (m[3] || '');
  const shift = 18 + exponent - (m[3] || '').length;
  let n = BigInt(digits);
  if (shift >= 0) n *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (n % divisor) throw new Error('18 ondalık basamaktan fazlası desteklenmiyor.');
    n /= divisor;
  }
  return m[1] === '-' ? -n : n;
}
export function str(n) {
  const sign = n < 0n ? '-' : ''; n = n < 0n ? -n : n;
  const fraction = (n % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return sign + (n / SCALE) + (fraction ? '.' + fraction : '');
}
export const add = (a, b) => str(dec(a) + dec(b));
export const sub = (a, b) => str(dec(a) - dec(b));
export const sum = values => str(values.reduce((n, v) => n + dec(v), 0n));
export function floorStep(value, step) { const d = dec(step); if (d <= 0n) throw new Error('Adım pozitif olmalı.'); return str(dec(value) / d * d); }
export function quantityFor(notional, price, ctVal, step) {
  return str((dec(notional) * SCALE * SCALE / (dec(price) * dec(ctVal))) / dec(step) * dec(step));
}
export function positive(value, name) {
  if (dec(value) <= 0n || !Number.isFinite(Number(value))) throw new Error(name + ' pozitif olmalı.');
  return Number(value);
}

function decimalParts(value) {
  const [mantissa, power = '0'] = String(value).split(/e/i);
  const places = (mantissa.split('.')[1] || '').length;
  return { coefficient: BigInt(mantissa.replace('.', '')), power: Number(power) - places };
}

export function sumDecimals(values) {
  if (values.some((value) => !Number.isFinite(value))) return values.reduce((sum, value) => sum + value, 0);
  let coefficient = 0n;
  let power = 0;
  for (const value of values) {
    const part = decimalParts(value);
    const nextPower = Math.min(power, part.power);
    coefficient = coefficient * 10n ** BigInt(power - nextPower)
      + part.coefficient * 10n ** BigInt(part.power - nextPower);
    power = nextPower;
  }
  return Number(`${coefficient}e${power}`);
}

export function decimalDifference(left, right) {
  return sumDecimals([left, -right]);
}

export function decimalProduct(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return left * right;
  const a = decimalParts(left);
  const b = decimalParts(right);
  return Number(`${a.coefficient * b.coefficient}e${a.power + b.power}`);
}

export function roundMoney(value) {
  if (!Number.isFinite(value)) return value;
  const part = decimalParts(value);
  if (part.power >= -2) return value;
  const divisor = 10n ** BigInt(-2 - part.power);
  const absolute = part.coefficient < 0n ? -part.coefficient : part.coefficient;
  const cents = absolute / divisor + (absolute % divisor * 2n >= divisor ? 1n : 0n);
  return Number(`${part.coefficient < 0n ? -cents : cents}e-2`);
}

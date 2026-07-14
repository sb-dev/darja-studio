export function parsePositiveInteger(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

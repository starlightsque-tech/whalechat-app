/** UUIDv4 generation that works on web, React Native and Node without deps. */
export function uuidv4(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();

  const bytes = new Uint8Array(16);
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable client id for optimistic records (distinct from server ids). */
export function clientId(prefix = 'tmp'): string {
  return `${prefix}_${uuidv4()}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

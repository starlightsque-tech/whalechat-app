export function nowIso(now: () => number = Date.now): string {
  return new Date(now()).toISOString();
}

export function isFresh(iso: string | null | undefined, ttlMs: number, now = Date.now()): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) && now - ts < ttlMs;
}

export function maxIso(a: string | null | undefined, b: string | null | undefined): string | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

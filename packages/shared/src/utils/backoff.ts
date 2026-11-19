export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  jitter?: boolean;
}

/** Exponential backoff with optional full jitter, capped. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1_000, factor = 2, maxMs = 5 * 60_000, jitter = true } = opts;
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt)));
  if (!jitter) return raw;
  return Math.floor(raw / 2 + Math.random() * (raw / 2));
}

export type FailureKind = 'retryable' | 'permanent' | 'conflict';

export class WhalechatError extends Error {
  readonly kind: FailureKind;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(message: string, kind: FailureKind = 'retryable', code = 'WC_ERROR', retryAfterMs?: number) {
    super(message);
    this.name = 'WhalechatError';
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export function classifyError(error: unknown): { kind: FailureKind; code: string; message: string; retryAfterMs?: number } {
  if (error instanceof WhalechatError) {
    return {
      kind: error.kind,
      code: error.code,
      message: error.message,
      retryAfterMs: error.retryAfterMs,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const offline = /network|offline|timeout|fetch failed|connection/i.test(message);
  return { kind: offline ? 'retryable' : 'permanent', code: 'UNKNOWN', message: message.slice(0, 300) };
}

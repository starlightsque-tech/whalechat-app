export class WhalechatError extends Error {
    kind;
    code;
    retryAfterMs;
    constructor(message, kind = 'retryable', code = 'WC_ERROR', retryAfterMs) {
        super(message);
        this.name = 'WhalechatError';
        this.kind = kind;
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}
export function classifyError(error) {
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
//# sourceMappingURL=errors.js.map
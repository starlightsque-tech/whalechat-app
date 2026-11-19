export type FailureKind = 'retryable' | 'permanent' | 'conflict';
export declare class WhalechatError extends Error {
    readonly kind: FailureKind;
    readonly code: string;
    readonly retryAfterMs?: number;
    constructor(message: string, kind?: FailureKind, code?: string, retryAfterMs?: number);
}
export declare function classifyError(error: unknown): {
    kind: FailureKind;
    code: string;
    message: string;
    retryAfterMs?: number;
};
//# sourceMappingURL=errors.d.ts.map
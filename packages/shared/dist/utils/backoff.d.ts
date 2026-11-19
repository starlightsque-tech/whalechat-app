export interface BackoffOptions {
    baseMs?: number;
    factor?: number;
    maxMs?: number;
    jitter?: boolean;
}
/** Exponential backoff with optional full jitter, capped. */
export declare function backoffDelay(attempt: number, opts?: BackoffOptions): number;
//# sourceMappingURL=backoff.d.ts.map
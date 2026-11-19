export function nowIso(now = Date.now) {
    return new Date(now()).toISOString();
}
export function isFresh(iso, ttlMs, now = Date.now()) {
    if (!iso)
        return false;
    const ts = Date.parse(iso);
    return Number.isFinite(ts) && now - ts < ttlMs;
}
export function maxIso(a, b) {
    if (!a)
        return b ?? undefined;
    if (!b)
        return a;
    return Date.parse(a) >= Date.parse(b) ? a : b;
}
//# sourceMappingURL=time.js.map
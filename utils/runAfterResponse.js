/**
 * Fire-and-forget after the HTTP response path — same pattern as asset approval setImmediate.
 * Does not change business flow; only moves slow side effects off the request.
 */
export function runAfterResponse(label, work) {
    setImmediate(() => {
        Promise.resolve()
            .then(work)
            .catch((err) => {
                console.error(`[runAfterResponse:${label}]`, err?.message || err);
            });
    });
}

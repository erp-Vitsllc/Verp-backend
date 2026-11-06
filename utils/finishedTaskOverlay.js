const FINISHED = new Set(["Completed", "Rejected", "Cancelled"]);

function finishRank(status) {
    if (status === "Completed") return 3;
    if (status === "Rejected") return 2;
    if (status === "Cancelled") return 1;
    return 0;
}

/**
 * The task row the details page shows, when the list's open-overlay map left it out.
 * Completed, rejected, and cancelled rows are dropped from that map, so a finished
 * Tools Request would stay "pending" on the list. A hidden duplicate is not used.
 */
export function finishedOverlayBySource(rows = [], hiddenIds = new Set()) {
    const hidden = hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds || []);
    const map = new Map();
    for (const row of rows || []) {
        const sourceId = String(row?.sourceDashboardActionId || "");
        if (!sourceId || hidden.has(String(row?._id || ""))) continue;
        const status = String(row?.status || "");
        if (!FINISHED.has(status)) continue;
        const current = map.get(sourceId);
        if (!current) {
            map.set(sourceId, row);
            continue;
        }
        const rankGap = finishRank(status) - finishRank(String(current.status || ""));
        if (rankGap > 0) {
            map.set(sourceId, row);
            continue;
        }
        if (rankGap < 0) continue;
        const nextTime = new Date(row.updatedAt || row.createdAt || 0).getTime();
        const prevTime = new Date(current.updatedAt || current.createdAt || 0).getTime();
        if (nextTime >= prevTime) map.set(sourceId, row);
    }
    return map;
}

/** Open task wins. Otherwise the finished task the details page already shows. */
export function overlayForListRow(actionId, openByAction, finishedByAction) {
    const id = String(actionId || "");
    return openByAction?.get(id) || finishedByAction?.get(id) || null;
}

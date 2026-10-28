/** The document name inside an expiry follow-up, without the expiry date. */
export function documentTaskLabel(extra1) {
    return String(extra1 || "")
        .trim()
        .replace(/^expiry follow-up required:\s*/i, "")
        .replace(/\s*\(exp:\s*[^)]+\)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

const HINT_SKIP = new Set(["system", "unassigned", "task manager", "workflow task"]);

function hintText(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Vehicle, asset, or employee text that can tell two copies of the same document apart. */
export function taskMatchHints(...values) {
    const hints = [];
    const seen = new Set();
    for (const value of values) {
        const text = hintText(value);
        if (text.length < 4 || HINT_SKIP.has(text) || seen.has(text)) continue;
        if (/^expiry follow-up required:/i.test(text)) continue;
        seen.add(text);
        hints.push(text);
    }
    return hints;
}

function hintsMatch(left = [], right = []) {
    return left.some((item) => right.some((other) => {
        if (item === other) return true;
        const shorter = item.length <= other.length ? item : other;
        const longer = item.length <= other.length ? other : item;
        return shorter.length >= 8 && longer.includes(shorter);
    }));
}

function assigneeIdsOf(...records) {
    const ids = [];
    for (const record of records) {
        for (const value of [record?.assignee, record?.assigneeEmpId, record?.assignedTo, record?.assignedToEmpId]) {
            const id = String(value || "").trim();
            if (id) ids.push(id);
        }
    }
    return ids;
}

function sameAssignee(leftIds, action) {
    const right = new Set(assigneeIdsOf(action));
    return leftIds.some((id) => right.has(id));
}

/**
 * An extra task row left behind after assign, reassign, or an expiry date change.
 * The live task stays. A different vehicle or document does not match.
 */
export function duplicateOverlayShouldClose({
    overlay,
    source = null,
    liveActions = [],
    sourceIsLive = false,
    sourceKey = "",
    liveKeys = new Set(),
} = {}) {
    if (!overlay) return false;
    if (["Completed", "Cancelled", "Rejected"].includes(String(overlay.status || ""))) return false;
    if (sourceIsLive) return false;
    if (sourceKey && liveKeys.has(sourceKey)) return true;

    const label = documentTaskLabel(overlay.taskName || source?.extra1);
    const followUp = /^expiry follow-up required:/i.test(
        `${overlay.taskName || ""} ${source?.extra1 || ""}`,
    );
    if (!followUp || !label) return false;

    const live = (liveActions || []).filter((action) => (
        /^expiry follow-up required:/i.test(String(action.extra1 || ""))
        && documentTaskLabel(action.extra1) === label
        && ["Pending", "On Hold"].includes(String(action.status || ""))
    ));
    if (!live.length) return false;

    const requestId = String(source?.requestId || "").trim();
    if (requestId && live.some((action) => String(action.requestId || "").trim() === requestId)) return true;

    const hints = taskMatchHints(
        overlay.description,
        source?.extra2,
        source?.subjectName,
        source?.subjectEmployeeId,
        ...(overlay.hints || []),
    );
    if (hints.length) {
        const hinted = live.filter((action) => hintsMatch(hints, taskMatchHints(
            action.extra2,
            action.subjectName,
            action.subjectEmployeeId,
            ...(action.hints || []),
        )));
        return hinted.length === 1;
    }

    if (live.length === 1) return true;

    const assignees = assigneeIdsOf(overlay, source);
    const day = String(overlay.day || "").trim();
    if (!assignees.length || !day) return false;
    const sameDay = live.filter((action) => String(action.day || "") === day && sameAssignee(assignees, action));
    return sameDay.length === 1;
}

/**
 * Which open copy to keep.
 * The task the user just assigned wins, then a reassigned copy, then the newest.
 */
export function chooseKeptDuplicate(rows = [], { reassignedIds = new Set(), preferId = "" } = {}) {
    let kept = null;
    for (const row of rows) {
        if (!row) continue;
        if (!kept) {
            kept = row;
            continue;
        }
        const rowPreferred = preferId && String(row._id) === String(preferId);
        const keptPreferred = preferId && String(kept._id) === String(preferId);
        if (rowPreferred !== keptPreferred) {
            if (rowPreferred) kept = row;
            continue;
        }
        const rowReassigned = reassignedIds.has(String(row._id));
        const keptReassigned = reassignedIds.has(String(kept._id));
        if (rowReassigned !== keptReassigned) {
            if (rowReassigned) kept = row;
            continue;
        }
        const rowTime = new Date(row.requestedDate || row.createdAt || row.updatedAt || 0).getTime();
        const keptTime = new Date(kept.requestedDate || kept.createdAt || kept.updatedAt || 0).getTime();
        if (rowTime >= keptTime) kept = row;
    }
    return kept;
}

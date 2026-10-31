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

function parsedMeta(extra3) {
    if (!extra3) return null;
    if (typeof extra3 === "object") return extra3;
    try {
        const parsed = JSON.parse(String(extra3));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function viewerRole(meta) {
    if (!meta) return "";
    const role = meta.activationViewerRole
        || meta.companyActivationViewerRole
        || meta.assetCreationViewerRole
        || meta.lossDamageViewerRole
        || "";
    return String(role).trim().toLowerCase();
}

/**
 * A second open job on the same record.
 * One vehicle can have two services, and the admin create-track stays beside the approval.
 * A profile can sit with HR and with the person who must fix it. Those are not approval copies.
 */
export function activityLane(requestType, extra3) {
    const type = String(requestType || "");
    const meta = parsedMeta(extra3);
    const role = viewerRole(meta);
    if (role && /activation|asset approval|asset loss damage/i.test(type)) return `role:${role}`;
    if (type === "Vehicle Service Request") {
        if (meta?.adminOfficerServiceTrack) return "admin-track";
        const serviceId = String(meta?.serviceRecordId || "").trim();
        if (serviceId) return `service:${serviceId}`;
        const oil = String(meta?.oilStage || "").trim();
        if (oil) return `oil:${oil}`;
        return "";
    }
    if (type === "Vehicle Disposition Request" || type === "Vehicle Inspection") {
        return String(extra3 || "").trim();
    }
    return "";
}

/** The stored extra3 that keeps a parallel job on its own dashboard row. */
export function activityExtra3Lock(requestType, extra3) {
    const raw = extra3 !== undefined && extra3 !== null ? String(extra3) : "";
    if (!raw) return "";
    const type = String(requestType || "");
    if (type === "Vehicle Disposition Request" || type === "Vehicle Inspection") return raw;
    if (type === "Vehicle Service Request" && activityLane(type, raw)) return raw;
    return "";
}

/**
 * One activity, one task.
 * HR, Accounts, and Management approvals of the same fine, loan, or advance share this key.
 * A different request, document, or parallel job does not.
 */
export function activityTaskKey(action, { system = false } = {}) {
    const type = String(action?.requestType || "");
    const requestId = String(action?.requestId || "").trim();
    const extra = documentTaskLabel(action?.extra1);
    if (system) {
        if (!requestId && !extra) return "";
        return `system|${type}|${requestId}|${extra}`;
    }
    if (/^(fine|group fine request)$/i.test(type)) {
        const id = String(action?.fineBaseId || "").trim() || requestId;
        return id ? `fine|${id}` : "";
    }
    if (requestId) {
        const lane = activityLane(type, action?.extra3);
        return lane ? `activity|${type}|${requestId}|${lane}` : `activity|${type}|${requestId}`;
    }
    const subject = String(action?.subjectName || action?.requestedByName || "").trim().toLowerCase();
    const assignee = String(action?.assignedTo || action?.assignedToEmpId || "");
    const detail = extra && extra !== type.toLowerCase() ? extra : "";
    if (detail) return `request|${type}|${subject}|${detail}`;
    if (subject || assignee) return `request|${type}|${subject}|${assignee}`;
    return "";
}

/**
 * The dashboard row that already belongs to this activity.
 * Rows should be newest first. The open approval wins, then the step just closed,
 * so the next approval continues that same task. A hold notice for someone else
 * stays put while an approval row exists.
 */
export function pickActivityRow(rows = []) {
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    return list.find((row) => row.status === "Pending")
        || list.find((row) => row.status === "Approved")
        || list.find((row) => row.status === "On Hold")
        || null;
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
/**
 * Which open copy to keep when one activity has more than one pending row.
 * A later approval step (a different person) wins over an older reassignment.
 * Two copies for the same person still keep the reassigned one.
 */
export function keepActivityCopy(rows = [], options = {}) {
    const holders = new Set(
        (rows || []).map((row) => String(row?.assignedTo || row?.assignedToEmpId || "")),
    );
    const reassignedIds = holders.size > 1 ? new Set() : options.reassignedIds;
    return chooseKeptDuplicate(rows, { ...options, reassignedIds });
}

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

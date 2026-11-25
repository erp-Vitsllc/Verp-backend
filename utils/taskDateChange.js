/**
 * Completion-date changes.
 * Requester applies the date and emails requester, assignee, and reassignee.
 * Assignee asks the requester to approve. Reassignee asks the assignee to approve.
 * A person who is the requester uses the requester path.
 * A person who is both assignee and reassignee uses the assignee path.
 */

export function dateChangeActorRole({ requester = false, assignee = false, reassignee = false } = {}) {
    if (requester) return "requester";
    if (reassignee && !assignee) return "reassignee";
    if (assignee) return "assignee";
    return "";
}

export function canDecideDateChange({ requester = false, assignee = false, requestRole = "" } = {}) {
    if (requestRole === "assignee") return Boolean(requester);
    if (requestRole === "reassignee") return Boolean(assignee);
    return false;
}

function uniqueAddresses(list) {
    return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

/** Company addresses for one step of a completion-date change. */
export function dateChangeMailTargets(event, parties = {}) {
    const requester = parties.requester;
    const assignee = parties.assignee;
    const reassignee = parties.reassignee;
    if (event === "requester-changed") return uniqueAddresses([requester, assignee, reassignee]);
    if (event === "assignee-requested") return uniqueAddresses([requester]);
    if (event === "reassignee-requested") return uniqueAddresses([assignee]);
    if (event === "assignee-approved") return uniqueAddresses([assignee, reassignee]);
    if (event === "reassignee-approved") return uniqueAddresses([requester, reassignee]);
    if (event === "assignee-rejected") return uniqueAddresses([assignee]);
    if (event === "reassignee-rejected") return uniqueAddresses([reassignee]);
    return [];
}

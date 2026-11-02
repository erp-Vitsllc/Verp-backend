/**
 * The task workflow list is the action history of that task.
 * Each point is something that already happened: requested, assigned,
 * reassigned, accepted, or rejected and returned. A rejection stays in the
 * list. Later role names such as Reportee or HR are not added before anyone acts.
 */

function clean(value) {
    return String(value || "").trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function named(value) {
    const text = clean(value);
    if (!text || text.toLowerCase() === "unassigned") return "";
    return text;
}

function same(left, right) {
    const a = named(left).toLowerCase();
    const b = named(right).toLowerCase();
    return Boolean(a && b && a === b);
}

function timeOf(value) {
    const time = new Date(value || 0).getTime();
    return Number.isNaN(time) ? 0 : time;
}

function isOpen(status) {
    return !["Completed", "Cancelled", "Rejected", "Closed", "Dismissed", "Approved"].includes(String(status || "Pending"));
}

export function parseReassignment(detail, actorName) {
    const text = String(detail || "");
    const fromTo = text.match(/reassigned from\s+(.+?)\s+to\s+(.+?)(?:\.|$)/i);
    if (fromTo) return { from: clean(fromTo[1]), to: clean(fromTo[2]) };
    const toOnly = text.match(/(?:reassigned to|assignee changed to|assigned to)\s+(.+?)(?:\.|$)/i);
    return { from: clean(actorName), to: toOnly ? clean(toOnly[1]) : "" };
}

function parseSentTo(detail) {
    const match = String(detail || "").match(/sent to\s+(.+?)(?:\.|$)/i);
    return match ? named(match[1]) : "";
}

function parseReturnedTo(detail) {
    const text = String(detail || "");
    const returned = text.match(/returned to\s+(.+?)(?:\.|$)/i);
    if (returned) return named(returned[1]);
    const again = text.match(/open again with\s+(.+?)(?:\.|$)/i);
    if (again) return named(again[1]);
    const closed = text.match(/closed\.\s+(.+?)\s+is the assignee/i);
    if (closed) return named(closed[1]);
    return "";
}

function rejectDetail(detail, returnedTo) {
    const back = returnedTo ? `Returned to ${returnedTo}` : "";
    const reason = String(detail || "")
        .replace(/^.+?\brejected this task\.?\s*/i, "")
        .replace(/^the status is rejected\.?\s*/i, "")
        .replace(/^rejected\.?\s*/i, "")
        .trim();
    if (back && reason && !/returned to/i.test(reason)) return `${back}. ${reason}`;
    if (back) return back;
    if (reason && reason.length <= 240 && !/^rejected$/i.test(reason)) return reason;
    return "Rejected";
}

const ACTION_EVENTS = new Set([
    "Created",
    "Assigned",
    "Reassigned",
    "Returned",
    "Rejected",
    "Approved",
    "Completed",
    "Closed",
    "Reopened",
    "Recalled",
    "Close Request",
    "Pending Review",
]);

function changeActionEvents(change) {
    if (!change?.stage) return [];
    const stage = String(change.stage);
    const reportee = named(change.reporteeName);
    const hr = named(change.hrName);
    const events = [];
    let order = 1;
    const pastReportee = stage === "pending_hr"
        || stage === "pending_requester"
        || stage === "approved"
        || (stage === "rejected" && Boolean(change.decidedAtHr));
    if (reportee && pastReportee) {
        events.push({
            event: "Approved",
            actorName: reportee,
            detail: hr ? `Accepted. Sent to ${hr}.` : "Accepted.",
            createdAt: change.decidedAtReportee || null,
            order: order++,
        });
    }
    if (hr && (stage === "pending_requester" || stage === "approved")) {
        events.push({
            event: "Approved",
            actorName: hr,
            detail: "Accepted.",
            createdAt: change.decidedAtHr || null,
            order: order++,
        });
    }
    if (stage === "rejected") {
        const byHr = Boolean(change.decidedAtHr);
        events.push({
            event: "Rejected",
            actorName: named(change.rejectedByName) || (byHr ? hr : reportee),
            detail: "Rejected",
            createdAt: (byHr ? change.decidedAtHr : change.decidedAtReportee) || null,
            order: order++,
        });
    }
    if (stage === "pending_requester") {
        const backTo = named(change.requestedByName);
        if (backTo) {
            events.push({
                event: "Assigned",
                actorName: hr,
                personName: backTo,
                detail: `Assigned to ${backTo}.`,
                createdAt: change.decidedAtHr || null,
                order: order++,
            });
        }
    }
    return events;
}

function firstHolder(events, change, originalAssigneeName, assigneeName) {
    const created = events.find((event) => event.event === "Created");
    if (created) {
        const to = parseReassignment(created.detail, created.actorName).to;
        if (named(to)) return named(to);
    }
    const reassigned = events.find((event) => event.event === "Reassigned");
    if (reassigned) {
        const from = parseReassignment(reassigned.detail, reassigned.actorName).from;
        if (named(from)) return named(from);
    }
    if (named(change?.reporteeName) && change?.stage) return named(change.reporteeName);
    if (named(originalAssigneeName)) return named(originalAssigneeName);
    return named(assigneeName);
}

function pushHolder(tracks, step) {
    const person = named(step.personName);
    if (!person) return "";
    const previous = [...tracks].reverse().find((item) => item.holder);
    if (previous && same(previous.personName, person) && previous.key === step.key) return person;
    tracks.push({ ...step, personName: person, holder: true, status: "Completed" });
    return person;
}

export function buildActionTracks({
    requesterName = "",
    assigneeName = "",
    originalAssigneeName = "",
    requestDate = null,
    status = "Pending",
    history = [],
    change = null,
} = {}) {
    const requester = named(requesterName) || "System";
    const open = isOpen(status);
    const tracks = [{
        key: "created",
        title: `Requested by ${requester}`,
        detail: "Task created",
        personName: requester.toLowerCase() === "system" ? "" : requester,
        at: requestDate || null,
        status: "Completed",
        holder: false,
    }];

    const historyEvents = (Array.isArray(history) ? history : [])
        .filter((item) => ACTION_EVENTS.has(item?.event))
        .map((item, index) => ({ ...item, order: index }));
    const decisionLogged = historyEvents.some((item) => item.event === "Approved" || item.event === "Rejected");
    const events = decisionLogged ? historyEvents : historyEvents.concat(changeActionEvents(change));
    events.sort((left, right) => (timeOf(left.createdAt) - timeOf(right.createdAt)) || ((left.order || 0) - (right.order || 0)));

    let holder = firstHolder(events, decisionLogged ? null : change, originalAssigneeName, assigneeName);
    if (holder) {
        tracks.push({
            key: "assigned",
            title: `Assigned to ${holder}`,
            detail: `From ${requester}`,
            personName: holder,
            at: requestDate || null,
            status: "Completed",
            holder: true,
        });
    }

    for (const event of events) {
        if (event.event === "Created") continue;
        if (event.event === "Reassigned" || event.event === "Assigned") {
            const hop = parseReassignment(event.detail, event.actorName);
            const to = named(event.personName) || named(hop.to);
            if (!to || same(holder, to)) continue;
            const from = named(hop.from) || holder;
            holder = pushHolder(tracks, {
                key: event.event === "Reassigned" ? "reassigned" : "assigned",
                title: event.event === "Reassigned" ? `Reassigned to ${to}` : `Assigned to ${to}`,
                detail: from ? `From ${from}` : `From ${requester}`,
                personName: to,
                at: event.createdAt || null,
            }) || holder;
            continue;
        }
        if (event.event === "Returned") {
            const to = parseReturnedTo(event.detail);
            if (!to) continue;
            holder = pushHolder(tracks, {
                key: "returned",
                title: `Returned to ${to}`,
                detail: named(event.actorName) ? `By ${named(event.actorName)}` : "Returned",
                personName: to,
                at: event.createdAt || null,
            }) || holder;
            continue;
        }
        if (event.event === "Rejected") {
            const actor = named(event.actorName) || holder || "the assignee";
            const returned = parseReturnedTo(event.detail);
            tracks.push({
                key: "rejected",
                title: `Rejected by ${actor}`,
                detail: rejectDetail(event.detail, returned),
                personName: actor.toLowerCase() === "the assignee" ? "" : actor,
                at: event.createdAt || null,
                status: "Rejected",
                holder: false,
            });
            if (returned && !same(holder, returned)) {
                holder = pushHolder(tracks, {
                    key: "returned",
                    title: `Returned to ${returned}`,
                    detail: `Rejected by ${actor}`,
                    personName: returned,
                    at: event.createdAt || null,
                }) || holder;
            }
            continue;
        }
        if (event.event === "Approved") {
            const actor = named(event.actorName) || holder || "the assignee";
            const sent = parseSentTo(event.detail);
            tracks.push({
                key: "accepted",
                title: `Accepted by ${actor}`,
                detail: sent ? `Sent to ${sent}` : "Accepted",
                personName: actor.toLowerCase() === "the assignee" ? "" : actor,
                at: event.createdAt || null,
                status: "Accepted",
                holder: false,
            });
            if (sent && !same(holder, sent)) {
                holder = pushHolder(tracks, {
                    key: "assigned",
                    title: `Assigned to ${sent}`,
                    detail: `Accepted by ${actor}`,
                    personName: sent,
                    at: event.createdAt || null,
                }) || holder;
            }
            continue;
        }
        if (event.event === "Reopened") {
            const actor = named(event.actorName) || "the requester";
            tracks.push({
                key: "reopened",
                title: `Reopened by ${actor}`,
                detail: "Task opened again",
                personName: named(event.actorName),
                at: event.createdAt || null,
                status: "Completed",
                holder: false,
            });
            continue;
        }
        if (event.event === "Recalled") {
            const actor = named(event.actorName) || "the assignee";
            tracks.push({
                key: "recalled",
                title: `Recalled by ${actor}`,
                detail: "Recalled",
                personName: named(event.actorName),
                at: event.createdAt || null,
                status: "Completed",
                holder: false,
            });
            continue;
        }
        if (event.event === "Completed" || event.event === "Closed" || event.event === "Close Request" || event.event === "Pending Review") {
            const actor = named(event.actorName) || "the assignee";
            const closed = event.event === "Closed";
            tracks.push({
                key: "completed",
                title: closed ? `Closed by ${actor}` : `Completed by ${actor}`,
                detail: event.event === "Pending Review" || event.event === "Close Request" ? "Sent for approval" : (closed ? "Closed" : "Completed"),
                personName: named(event.actorName),
                at: event.createdAt || null,
                status: "Completed",
                holder: false,
            });
        }
    }

    if (open && named(assigneeName)) {
        let lastHolder = null;
        for (let index = tracks.length - 1; index >= 0; index -= 1) {
            if (tracks[index].holder) {
                lastHolder = tracks[index];
                break;
            }
        }
        const last = tracks[tracks.length - 1];
        if (!lastHolder || !same(lastHolder.personName, assigneeName) || last?.key === "rejected") {
            const lastReject = [...tracks].reverse().find((step) => step.key === "rejected");
            if (lastReject && !/returned to/i.test(String(lastReject.detail || ""))) {
                lastReject.detail = rejectDetail(lastReject.detail, named(assigneeName));
            }
            const current = named(assigneeName);
            const returned = Boolean(lastReject);
            if (!same(lastHolder?.personName, current) || returned) {
                holder = pushHolder(tracks, {
                    key: returned ? "returned" : "assigned",
                    title: returned ? `Returned to ${current}` : `Assigned to ${current}`,
                    detail: returned ? `Rejected by ${named(lastReject.personName) || "the assignee"}` : `From ${requester}`,
                    personName: current,
                    at: null,
                }) || holder;
            }
        }
    }

    if (open) {
        let lastHolderIndex = -1;
        tracks.forEach((step, index) => {
            if (step.holder) lastHolderIndex = index;
        });
        if (lastHolderIndex >= 0) tracks[lastHolderIndex].status = "In Progress";
    }

    return tracks.map(({ holder: _holder, ...step }) => step);
}

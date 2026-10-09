import { assigneeAcceptChannel, loadLoginThroughForCheck } from './loginThrough.js';

export const ASSIGNMENT_REQUEST_MESSAGE = 'Assignment request';

/** Web, else app, else null. Does not use company email. */
export async function resolveAssigneeAcceptChannel(emp) {
    if (!emp) return null;
    const source = await loadLoginThroughForCheck(emp);
    return assigneeAcceptChannel(source);
}

/**
 * App-only assignees get an inbox row titled "Assignment request".
 * Web assignees keep the existing assignment / handover label.
 */
export function applyAppAssignmentRequestCopy(fields, channel) {
    if (channel !== 'app' || !fields || typeof fields !== 'object') return fields;
    let base = {};
    const raw = fields.extra3;
    if (raw && typeof raw === 'object') base = { ...raw };
    else if (typeof raw === 'string' && raw.trim()) {
        try {
            base = JSON.parse(raw);
        } catch {
            base = {};
        }
    }
    return {
        ...fields,
        extra2: ASSIGNMENT_REQUEST_MESSAGE,
        extra3: JSON.stringify({
            ...base,
            assignmentRequest: true,
            acceptChannel: 'app',
            message: ASSIGNMENT_REQUEST_MESSAGE,
        }),
    };
}

export async function assignmentInboxFieldsForActor(actor, fields) {
    const channel = await resolveAssigneeAcceptChannel(actor);
    return applyAppAssignmentRequestCopy(fields, channel);
}

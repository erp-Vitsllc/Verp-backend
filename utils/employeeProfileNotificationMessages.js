export function employeeProfileDisplayName(employee = {}) {
    return (
        `${employee.firstName || ''} ${employee.lastName || ''}`.trim() ||
        employee.employeeId ||
        'Employee'
    );
}

function employeeIdSuffix(employeeId = '') {
    const id = String(employeeId || '').trim();
    return id ? ` (${id})` : '';
}

export function buildProfileActivationPendingMessage({
    employeeName = 'Employee',
    employeeId = '',
    activationType = 'New Activation',
    submittedBy = '',
    pendingCards = [],
    reason = '',
} = {}) {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    const typeLabel =
        String(activationType || '').toLowerCase() === 'reactivation'
            ? 'reactivation'
            : 'new profile activation';
    const submitterPart = submittedBy ? `, submitted by ${submittedBy}` : '';
    let message = `Profile activation for ${name}${employeeIdSuffix(employeeId)} — ${typeLabel}${submitterPart}, is pending HR review.`;
    if (reason) message += ` Reason: ${String(reason).trim()}.`;
    if (Array.isArray(pendingCards) && pendingCards.length) {
        message += ` Changes requested: ${pendingCards.join(', ')}.`;
    }
    return message.replace(/\s+/g, ' ').trim();
}

export function buildProfileActivationHoldMessage({
    employeeName = 'Employee',
    employeeId = '',
    unapprovedCards = [],
} = {}) {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    const cards = (unapprovedCards || []).map((c) => String(c || '').trim()).filter(Boolean);
    const cardsPart = cards.length ? ` Update required for: ${cards.join(', ')}.` : '';
    return `Profile activation for ${name}${employeeIdSuffix(employeeId)} is on hold — please review HR feedback, complete the required updates,${cardsPart} and resubmit.`
        .replace(/\s+/g, ' ')
        .trim();
}

export function buildProfileActivationRejectedMessage({
    employeeName = 'Employee',
    employeeId = '',
} = {}) {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    return `Profile activation for ${name}${employeeIdSuffix(employeeId)} was rejected — review HR comments, update the profile, and resubmit for approval.`;
}

export function buildProfileActivationApprovedMessage({
    employeeName = 'Employee',
    employeeId = '',
} = {}) {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    return `Profile activation for ${name}${employeeIdSuffix(employeeId)} was approved — the profile is now live and active.`;
}

export function buildProfileActivationSubmittedOutcomeMessage({
    employeeName = 'Employee',
    employeeId = '',
    status = 'Pending',
} = {}) {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    const normalized = String(status || 'Pending').trim();
    if (normalized === 'Approved') {
        return buildProfileActivationApprovedMessage({ employeeName: name, employeeId });
    }
    if (normalized === 'Rejected') {
        return buildProfileActivationRejectedMessage({ employeeName: name, employeeId });
    }
    if (normalized === 'On Hold') {
        return buildProfileActivationHoldMessage({ employeeName: name, employeeId });
    }
    return `Your profile activation request for ${name}${employeeIdSuffix(employeeId)} has been submitted and is awaiting HR review.`;
}

export function buildProfileIncompleteMessage({
    employeeName = 'Employee',
    employeeId = '',
} = {}) {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    return `Profile incomplete for ${name}${employeeIdSuffix(employeeId)} — please complete all mandatory profile cards to reach 100%.`;
}

export function buildProfileActivationEntityLine(employeeName = 'Employee', employeeId = '') {
    const name = String(employeeName || 'Employee').trim() || 'Employee';
    const id = String(employeeId || '').trim();
    return id ? `${name} (${id})` : name;
}

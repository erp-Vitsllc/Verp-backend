import { getDepartmentHOD } from './getDepartmentHOD.js';

export function vehicleServiceActorName(emp) {
    const name = `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim();
    return name || emp?.employeeId || 'you';
}

function requesterText(value) {
    return String(value || '').trim().replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Inbox titles such as "Mechanical Work pending with NESMI — Schedule" are not people. */
export function isVehicleServicePendingTitle(name) {
    return /\bpending with\b/i.test(requesterText(name));
}

/** A person who requested the work. System labels and workflow titles are not names. */
export function personRequesterName(name) {
    const base = requesterText(name);
    if (!base || base.toLowerCase() === 'system') return '';
    if (isVehicleServicePendingTitle(base)) return '';
    return base;
}

function remarkObject(service) {
    if (service?.remark && typeof service.remark === 'object') return service.remark;
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

/** The employee who created or submitted this service, when that name was stored. */
export function requesterNameFromService(service) {
    const remark = remarkObject(service);
    const fromRemark = personRequesterName(remark.requestedByName) || personRequesterName(remark.createdByName);
    if (fromRemark) return fromRemark;
    const requestedBy = service?.requestedBy;
    if (requestedBy && typeof requestedBy === 'object') {
        const name = personRequesterName(
            requestedBy.name || [requestedBy.firstName, requestedBy.lastName].filter(Boolean).join(' '),
        );
        if (name) return name;
    }
    return '';
}

export function vehicleServicePendingTitle(serviceType, personName, stage = '') {
    const type = String(serviceType || 'Service').trim() || 'Service';
    const name = String(personName || 'you').trim() || 'you';
    const st = String(stage || '').trim();
    const base = `${type} pending with ${name}`;
    return st ? `${base} — ${st}` : base;
}

export function vehicleServicePendingBody(serviceType, stage, { completeTrack = false } = {}) {
    const type = String(serviceType || 'Service').trim() || 'Service';
    const st = String(stage || 'Created').trim() || 'Created';
    if (completeTrack) {
        return `You have Complete Service pending. Current stage: ${st}. Please complete it to continue this ${type}.`;
    }
    return `You have ${st} pending. Please complete it to continue this ${type}.`;
}

export function vehicleServicePendingCopy(serviceType, personName, stage, options = {}) {
    const stageLabel = String(stage || 'Created').trim() || 'Created';
    const extra1 = vehicleServicePendingTitle(serviceType, personName, stageLabel);
    const extra2 = vehicleServicePendingBody(serviceType, stage, options);
    return {
        extra1,
        extra2,
        actionLabel: extra1,
        detailLine: extra2,
        stageLabel,
    };
}

export function inferVehicleServicePendingStage(...parts) {
    const t = parts.map((p) => String(p || '')).join(' ').toLowerCase();
    if (!t.trim()) return 'Created';
    if (/\bmake payment\b/.test(t) || /accounts billing/.test(t) || /zoho bill/.test(t)) return 'Make Payment';
    if (/zoho expense/.test(t)) return 'Zoho Expense';
    if (/accounts approve|awaiting accounts/.test(t)) return 'Accounts Approve';
    if (/ready to service/.test(t)) return 'Ready to Service';
    if (/\bon service\b/.test(t)) return 'On Service';
    if (/complete service/.test(t)) return 'Complete Service';
    if (/hr approval|awaiting hr/.test(t)) return 'HR Approval';
    if (/schedule|garage|reschedule|accounts hold|hold reminder|hold follow/.test(t)) return 'Schedule';
    if (/created|service due|initiated/.test(t)) return 'Created';
    return 'Created';
}

/**
 * Inbox + email copy for a vehicle service pending row.
 * Admin Officer uses the create-to-complete track wording.
 */
export async function applyVehicleServiceNotificationCopy({
    recipient,
    serviceType,
    pendingStage = '',
    extra2 = '',
    actionLabel = '',
    stageLabel = '',
}) {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const completeTrack = Boolean(
        adminOfficer?._id && recipient?._id && String(recipient._id) === String(adminOfficer._id),
    );
    const stage =
        String(pendingStage || '').trim() ||
        inferVehicleServicePendingStage(extra2, actionLabel, stageLabel);
    return vehicleServicePendingCopy(
        serviceType,
        vehicleServiceActorName(recipient),
        stage,
        { completeTrack },
    );
}

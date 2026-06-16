/**
 * On Service / On Leave are independent boolean flags — not mixed into asset.status.
 * Legacy rows may still have status "On Leave" / "Service"; helpers accept both until migrated.
 */

/** Maximum total leave / parking duration (initial + extensions). */
export const MAX_ASSET_LEAVE_DAYS = 40;

/** Maximum total service duration (initial request + extensions). */
export const MAX_ASSET_SERVICE_DAYS = 30;

export const normalizeAssetStatusKey = (status) => String(status || '').toLowerCase().trim();

const LEGACY_SERVICE_STATUSES = new Set([
    'service',
    'on service',
    'waiting for service',
    'maintenance',
]);

const LEGACY_LEAVE_STATUS = 'on leave';

export const isLegacyLeaveStatus = (status) =>
    normalizeAssetStatusKey(status) === LEGACY_LEAVE_STATUS;

export const isLegacyServiceStatus = (status) =>
    LEGACY_SERVICE_STATUSES.has(normalizeAssetStatusKey(status));

/** Asset is actively on leave / parking. */
export const isLeaveActive = (item) => {
    if (!item) return false;
    if (item.onLeaveActive === true) return true;
    return isLegacyLeaveStatus(item.status);
};

/** Asset is actively on service (tools or fleet operational window). */
export const isServiceActive = (item) => {
    if (!item) return false;
    if (item.onServiceActive === true) return true;
    return isLegacyServiceStatus(item.status);
};

/** @deprecated Use isLeaveActive(item) — kept for gradual migration */
export const isParkingStatus = (status) => isLegacyLeaveStatus(status);

/** @deprecated Use isServiceActive(item) — kept for gradual migration */
export const isServiceOperationalStatus = (statusOrItem) => {
    if (statusOrItem && typeof statusOrItem === 'object' && !Array.isArray(statusOrItem)) {
        return isServiceActive(statusOrItem);
    }
    return isLegacyServiceStatus(statusOrItem);
};

export const hasActiveParkingContext = (item) => isLeaveActive(item);

export const snapshotParkingFields = (item) => ({
    onLeaveActive: item?.onLeaveActive === true,
    onLeaveStartDate: item?.onLeaveStartDate ?? null,
    onLeaveEndDate: item?.onLeaveEndDate ?? null,
    onLeaveDuration: item?.onLeaveDuration ?? null,
    parkingExtendedDays: item?.parkingExtendedDays ?? 0,
    parkingReminderSentAt: item?.parkingReminderSentAt ?? null,
    parkingDurationCompleteSentAt: item?.parkingDurationCompleteSentAt ?? null,
});

export const restoreParkingFields = (item, snapshot) => {
    if (!snapshot) return;
    if (snapshot.onLeaveActive != null) item.onLeaveActive = !!snapshot.onLeaveActive;
    item.onLeaveStartDate = snapshot.onLeaveStartDate ?? null;
    item.onLeaveEndDate = snapshot.onLeaveEndDate ?? null;
    item.onLeaveDuration = snapshot.onLeaveDuration ?? null;
    item.parkingExtendedDays = snapshot.parkingExtendedDays ?? 0;
    item.parkingReminderSentAt = snapshot.parkingReminderSentAt ?? null;
    item.parkingDurationCompleteSentAt = snapshot.parkingDurationCompleteSentAt ?? null;
};

export const clearParkingFlags = (item) => {
    if (!item) return;
    item.onLeaveActive = false;
    item.onLeaveStartDate = null;
    item.onLeaveEndDate = null;
    item.onLeaveDuration = null;
    item.parkingExtendedDays = 0;
    item.parkingReminderSentAt = null;
    item.parkingDurationCompleteSentAt = null;
};

/** Clear leftover parking dates when onLeaveActive is already false (post on-duty heal). */
export const healStaleParkingFields = (item) => {
    if (!item || item.onLeaveActive === true || isLegacyLeaveStatus(item.status)) {
        return false;
    }
    const hasStale =
        item.onLeaveEndDate != null ||
        item.onLeaveStartDate != null ||
        (item.onLeaveDuration != null && item.onLeaveDuration !== '') ||
        Number(item.parkingExtendedDays || 0) > 0;
    if (!hasStale) return false;

    item.onLeaveStartDate = null;
    item.onLeaveEndDate = null;
    item.onLeaveDuration = null;
    item.parkingExtendedDays = 0;
    item.parkingReminderSentAt = null;
    item.parkingDurationCompleteSentAt = null;
    return true;
};

export const clearServiceFlag = (item) => {
    if (!item) return;
    item.onServiceActive = false;
};

/**
 * On Duty from leave: clear onLeave and all parking dates — onServiceActive unchanged.
 */
export const applyOnDutyFromLeaveState = (item) => {
    const originalDuration = item.onLeaveDuration;
    clearParkingFlags(item);

    if (!item?.assignedTo && !item?.assignedCompany) {
        item.status = 'Unassigned';
        return { ok: true, path: 'leave', originalDuration, directUnassigned: true };
    }

    item.status = 'Assigned';
    return { ok: true, path: 'leave', originalDuration };
};

/** Employee-assigned assets need owner confirmation before On Duty. */
export const requiresOwnerOnDutyApproval = (item) => {
    if (!item) return false;
    const assigneeOid = item.assignedTo?._id || item.assignedTo;
    return !!assigneeOid && item.assignedToType !== 'Company';
};

/**
 * Live / return from service: clear onService only — onLeaveActive unchanged.
 */
export const applyOnDutyFromServiceState = (item, serviceRecord = null) => {
    item.onServiceActive = false;
    item.status = resolveBaseAssignmentStatus(item);

    if (serviceRecord && serviceRecord.durationCompleteSentAt == null) {
        serviceRecord.durationCompleteSentAt = new Date();
    }

    return { ok: true, path: 'service' };
};

export const resolveOnDutyPath = (item) => {
    if (item?.onServiceActive === true) return 'service';
    if (item?.onLeaveActive === true) return 'leave';
    return null;
};

export const resolveBaseAssignmentStatus = (item) =>
    item?.assignedTo || item?.assignedCompany ? 'Assigned' : 'Unassigned';

/**
 * After service Return: clear onService only — onLeaveActive unchanged.
 */
export const applyPostServiceOperationalState = (item, serviceRecord) => {
    item.onServiceActive = false;
    item.status = resolveBaseAssignmentStatus(item);
    if (serviceRecord && serviceRecord.durationCompleteSentAt == null) {
        serviceRecord.durationCompleteSentAt = new Date();
    }
    return item.status;
};

/** @deprecated alias */
export const resolvePostServiceStatus = applyPostServiceOperationalState;

export const applyParkingLeaveStatus = (item, leaveDays) => {
    if (isLeaveActive(item)) return false;
    if (!leaveDays) return false;

    const start = new Date();
    const end = new Date(start);
    end.setDate(end.getDate() + leaveDays);

    item.onLeaveActive = true;
    item.onLeaveStartDate = start;
    item.onLeaveDuration = leaveDays;
    item.onLeaveEndDate = end;
    item.parkingExtendedDays = 0;
    item.parkingReminderSentAt = null;
    item.parkingDurationCompleteSentAt = null;

    if (item.assignedTo || item.assignedCompany) {
        item.status = 'Assigned';
    }

    return true;
};

export const applyServiceActiveState = (item, statusBeforeService = null) => {
    const wasOnLeave =
        item.onLeaveActive === true ||
        isLegacyLeaveStatus(statusBeforeService) ||
        isLegacyLeaveStatus(item.status);
    item.onServiceActive = true;
    if (wasOnLeave) {
        item.onLeaveActive = true;
    }
    const prev = statusBeforeService ?? item.status;
    if (item.assignedTo || item.assignedCompany) {
        item.status = 'Assigned';
    } else if (!['Pending', 'Draft', 'Unassigned'].includes(String(item.status || ''))) {
        item.status = resolveBaseAssignmentStatus(item);
    }
    return prev;
};

export const applyAcceptedAssignmentState = (item, acceptedByEmpObjectId, options = {}) => {
    const { preserveParking = false, preserveService = false } = options;

    if (preserveParking) {
        item.onLeaveActive = true;
        item.status = 'Assigned';
    } else if (preserveService) {
        item.onServiceActive = true;
        item.status = 'Assigned';
    } else {
        item.status = 'Assigned';
    }

    item.acceptanceStatus = 'Accepted';
    item.actionRequiredBy = null;
    item.acceptedBy = acceptedByEmpObjectId;

    if (!preserveParking && item.assignmentType === 'Temporary' && item.assignedDays) {
        const parsedDays = Number(item.assignedDays);
        const start = new Date();
        const end = new Date(start);
        end.setDate(end.getDate() + parsedDays);
        item.assignedDate = start;
        item.temporaryEndDate = end;
        item.temporaryReminderSentAt = null;
        item.temporaryExpiredSentAt = null;
    }
};

/** One-time normalize legacy status strings into flags (mutates item). */
export const migrateLegacyOperationalFlags = (item) => {
    if (!item) return item;

    if (isLegacyLeaveStatus(item.status)) {
        item.onLeaveActive = true;
        item.status = resolveBaseAssignmentStatus(item);
    }

    if (isLegacyServiceStatus(item.status)) {
        item.onServiceActive = true;
        if (item.assignedTo || item.assignedCompany) {
            item.status = 'Assigned';
        } else if (normalizeAssetStatusKey(item.status) !== 'unassigned') {
            item.status = resolveBaseAssignmentStatus(item);
        }
    }

    return item;
};

export const onLeaveQueryFilter = () => ({
    $or: [{ onLeaveActive: true }, { status: { $regex: /^on\s+leave$/i } }],
});

export const onServiceQueryFilter = () => ({
    $or: [{ onServiceActive: true }, { status: { $regex: /^(service|on\s+service)$/i } }],
});

/** AC Parking / On Service profile tabs — strict flag only (no legacy status). */
export const onLeaveActiveOnlyQueryFilter = () => ({ onLeaveActive: true });

export const onServiceActiveOnlyQueryFilter = () => ({ onServiceActive: true });

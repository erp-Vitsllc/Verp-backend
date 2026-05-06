const toPlain = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
};

const strId = (v) => (v == null ? '' : String(v));

const FOLDER_MARKERS = [
    'company-documents',
    'employee-documents',
    'asset-invoices',
    'asset-photos',
    'profile-pictures',
    'signatures',
    'rewards',
    'fines',
];

const normalizeAttachmentKeyForCompare = (value) => {
    if (typeof value !== 'string' || !value.trim()) return '';
    const noQuery = value.split('?')[0].trim();
    const lower = noQuery.toLowerCase();
    for (const folder of FOLDER_MARKERS) {
        const idx = lower.indexOf(folder);
        if (idx !== -1) return noQuery.slice(idx).toLowerCase();
    }
    return noQuery.toLowerCase();
};

const normalizeOwnerForCompare = (owner) => {
    const o = toPlain(owner || {}) || {};
    const out = { ...o };

    // Ignore volatile/non-business fields in diff checks.
    delete out.createdAt;
    delete out.updatedAt;
    delete out.__v;

    const normalizeAttachmentAt = (obj, key) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj[key] == null) return;
        obj[key] = normalizeAttachmentKeyForCompare(obj[key]);
    };

    normalizeAttachmentAt(out, 'attachment');
    if (out.passport && typeof out.passport === 'object') normalizeAttachmentAt(out.passport, 'attachment');
    if (out.visa && typeof out.visa === 'object') normalizeAttachmentAt(out.visa, 'attachment');
    if (out.emiratesId && typeof out.emiratesId === 'object') normalizeAttachmentAt(out.emiratesId, 'attachment');
    if (out.medical && typeof out.medical === 'object') normalizeAttachmentAt(out.medical, 'attachment');
    if (out.drivingLicense && typeof out.drivingLicense === 'object') normalizeAttachmentAt(out.drivingLicense, 'attachment');
    if (out.labourCard && typeof out.labourCard === 'object') normalizeAttachmentAt(out.labourCard, 'attachment');

    return out;
};

const ownerIdentityKey = (owner) => {
    const o = normalizeOwnerForCompare(owner);
    const name = String(o?.name || '').trim().toLowerCase();
    const nationality = String(o?.nationality || '').trim().toLowerCase();
    const share = String(o?.sharePercentage || '').trim().toLowerCase();
    const passportNo = String(o?.passport?.number || '').trim().toLowerCase();
    const visaNo = String(o?.visa?.number || '').trim().toLowerCase();
    const emiratesNo = String(o?.emiratesId?.number || '').trim().toLowerCase();
    const labourNo = String(o?.labourCard?.number || '').trim().toLowerCase();
    return [name, nationality, share, passportNo, visaNo, emiratesNo, labourNo].join('|');
};

const sameJson = (a, b) => {
    try {
        return JSON.stringify(toPlain(a)) === JSON.stringify(toPlain(b));
    } catch {
        return false;
    }
};

const buildArchiveRowFromOwner = (owner, { archiveReason, archivedAt, previousOwnerId, replacedByName }) => {
    const o = toPlain(owner || {}) || {};
    return {
        archivedAt: archivedAt || new Date(),
        archiveReason: archiveReason || 'Replaced',
        previousOwnerId: previousOwnerId || '',
        replacedByName: replacedByName || '',
        ...o,
    };
};

/**
 * Build owner archive rows when `owners` array is updated.
 * - If an existing owner (by _id) is modified → archive previous as Replaced
 * - If an owner is removed → archive previous as Deleted
 *
 * @param {object} beforeCompany
 * @param {object} updateData
 * @returns {Array<object>} archive rows to append to Company.oldOwners
 */
export const archiveSupersededCompanyOwners = (beforeCompany = {}, updateData = {}) => {
    if (!Object.prototype.hasOwnProperty.call(updateData || {}, 'owners')) return [];

    const prev = Array.isArray(beforeCompany?.owners) ? beforeCompany.owners : [];
    const next = Array.isArray(updateData?.owners) ? updateData.owners : [];

    const prevById = new Map();
    const prevByIdentity = new Map();
    prev.forEach((o) => {
        const id = strId(o?._id);
        if (id) prevById.set(id, o);
        const key = ownerIdentityKey(o);
        if (key && !prevByIdentity.has(key)) prevByIdentity.set(key, o);
    });

    const nextIds = new Set(
        next
            .map((o) => strId(o?._id))
            .filter(Boolean)
    );
    const nextIdentityKeys = new Set(next.map((o) => ownerIdentityKey(o)).filter(Boolean));

    const archivedAt = new Date();
    const archives = [];

    const existingArchives = Array.isArray(beforeCompany?.oldOwners) ? beforeCompany.oldOwners : [];

    const hasExistingArchive = (ownerSnapshot, { archiveReason, previousOwnerId, replacedByName }) => {
        const snapshotNorm = normalizeOwnerForCompare(ownerSnapshot);
        const snapshotKey = ownerIdentityKey(ownerSnapshot);
        return existingArchives.some((row) => {
            if (String(row?.archiveReason || '') !== String(archiveReason || '')) return false;
            if (strId(row?.replacedByName) !== strId(replacedByName || '')) return false;
            const strictIdMatch = strId(row?.previousOwnerId) === strId(previousOwnerId);
            const sameSnapshot =
                sameJson(normalizeOwnerForCompare(row), snapshotNorm) ||
                (snapshotKey && ownerIdentityKey(row) === snapshotKey);
            if (!sameSnapshot) return false;
            // Keep strict behavior when IDs are available, but allow snapshot fallback for ID churn.
            if (strId(previousOwnerId)) return strictIdMatch;
            return true;
        });
    };

    // Modified owners (same _id exists in both arrays)
    next.forEach((o) => {
        const id = strId(o?._id);
        if (!id) return;
        let prevOwner = prevById.get(id);
        if (!prevOwner) {
            // Fallback when UI payload regenerates owner IDs but the owner is the same person/doc set.
            prevOwner = prevByIdentity.get(ownerIdentityKey(o));
        }
        if (!prevOwner) return;
        if (!sameJson(normalizeOwnerForCompare(prevOwner), normalizeOwnerForCompare(o))) {
            const replacedByName = strId(o?.name);
            if (
                hasExistingArchive(prevOwner, {
                    archiveReason: 'Replaced',
                    previousOwnerId: id,
                    replacedByName,
                })
            ) {
                return;
            }
            archives.push(
                buildArchiveRowFromOwner(prevOwner, {
                    archiveReason: 'Replaced',
                    archivedAt,
                    previousOwnerId: id,
                    replacedByName,
                }),
            );
        }
    });

    // Deleted owners
    prev.forEach((o) => {
        const id = strId(o?._id);
        if (!id) return;
        if (nextIds.has(id)) return;
        // Treat same owner identity in next payload as the same row (handles _id churn on renew/edit).
        if (nextIdentityKeys.has(ownerIdentityKey(o))) return;
        if (
            hasExistingArchive(o, {
                archiveReason: 'Deleted',
                previousOwnerId: id,
                replacedByName: '',
            })
        ) {
            return;
        }
        archives.push(
            buildArchiveRowFromOwner(o, {
                archiveReason: 'Deleted',
                archivedAt,
                previousOwnerId: id,
            }),
        );
    });

    return archives;
};


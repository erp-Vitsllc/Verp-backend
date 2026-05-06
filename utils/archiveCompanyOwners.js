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
    prev.forEach((o) => {
        const id = strId(o?._id);
        if (id) prevById.set(id, o);
    });

    const nextIds = new Set(
        next
            .map((o) => strId(o?._id))
            .filter(Boolean)
    );

    const archivedAt = new Date();
    const archives = [];

    // Modified owners (same _id exists in both arrays)
    next.forEach((o) => {
        const id = strId(o?._id);
        if (!id) return;
        const prevOwner = prevById.get(id);
        if (!prevOwner) return;
        if (!sameJson(prevOwner, o)) {
            archives.push(
                buildArchiveRowFromOwner(prevOwner, {
                    archiveReason: 'Replaced',
                    archivedAt,
                    previousOwnerId: id,
                    replacedByName: strId(o?.name),
                }),
            );
        }
    });

    // Deleted owners
    prev.forEach((o) => {
        const id = strId(o?._id);
        if (!id) return;
        if (nextIds.has(id)) return;
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


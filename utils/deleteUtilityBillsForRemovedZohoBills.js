function cleanIds(ids) {
    return [
        ...new Set(
            (Array.isArray(ids) ? ids : [])
                .map((id) => String(id || '').trim())
                .filter(Boolean),
        ),
    ];
}

/**
 * ERP utility bills are sensitive finance records.
 * Never auto-delete them when a Zoho bill is void, missing from a refresh, or dropped from cache.
 * Manual delete in ERP (creator before Zoho / admin) is the only allowed remove path.
 */
export async function deleteUtilityBillsForRemovedZohoBills(zohoBillIds = []) {
    const ids = cleanIds(zohoBillIds);
    if (ids.length) {
        console.warn(
            `[ZohoSync] skipped auto-delete of ${ids.length} ERP utility bill(s) ` +
                `(Zoho bill gone/void). Bills stay in MongoDB.`,
        );
    }
    return { deleted: 0, billIds: [], skipped: ids };
}

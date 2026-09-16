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
 * Accounts → Bills Refresh used to delete matching ERP utility bills.
 * That path is permanently disabled. Refresh may only update the Zoho cache.
 */
export async function deleteUtilityBillsForRemovedZohoBills(zohoBillIds = []) {
    const ids = cleanIds(zohoBillIds);
    if (ids.length) {
        console.warn(
            `[ZohoSync] Refresh will not delete ERP utility bills ` +
                `(${ids.length} Zoho id(s) ignored).`,
        );
    }
    return { deleted: 0, billIds: [], skipped: ids };
}

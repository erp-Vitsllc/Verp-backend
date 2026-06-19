import Fine from '../models/Fine.js';

const FINE_PDF_FIELDS =
    'fineId fineType category description assetId assetObjectId assetPurchaseDate assetDepreciationAmount ' +
    'assetPurchaseCost fineAmount totalFineAmount serviceCharge employeeAmount companyAmount responsibleFor ' +
    'payableDuration monthStart originalMonthStart sourceOfIncome awardedDate createdAt assignedEmployees ' +
    'hrApprovedBy accountsApprovedBy managerApprovedBy approvedBy';

function fineBaseId(fineId) {
    if (!fineId || typeof fineId !== 'string') return '';
    const parts = fineId.split('-');
    return parts.length > 3 ? parts.slice(0, 3).join('-') : fineId;
}

/**
 * Load the complete fine record for PDF generation (amounts, fineId, description).
 * For group fines, picks the sibling document for the assigned employee.
 */
export async function loadFineRecordForAssetLossPdf(fine, assignedEmployeeId) {
    if (!fine) return null;

    let record = null;

    if (fine._id) {
        record = await Fine.findById(fine._id).select(FINE_PDF_FIELDS).lean();
    }
    if (!record && fine.fineId) {
        record = await Fine.findOne({ fineId: fine.fineId }).select(FINE_PDF_FIELDS).lean();
    }

    if (assignedEmployeeId) {
        const baseId = fineBaseId(record?.fineId || fine.fineId);
        if (baseId) {
            const sibling = await Fine.findOne({
                fineId: new RegExp(`^${baseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-[A-Z0-9]+)?$`, 'i'),
                'assignedEmployees.employeeId': assignedEmployeeId,
            })
                .select(FINE_PDF_FIELDS)
                .lean();
            if (sibling) record = sibling;
        }
    }

    if (record) {
        return { ...fine, ...record };
    }

    return typeof fine.toObject === 'function' ? fine.toObject() : { ...fine };
}

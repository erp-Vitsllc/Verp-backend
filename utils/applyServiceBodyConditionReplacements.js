import mongoose from 'mongoose';
import AssetHistory from '../models/AssetHistory.js';
import { persistStoredAttachmentValue, normalizeS3Key } from './s3Upload.js';

const BODY_CONDITION_KEYS = [
    'frontView',
    'backView',
    'frontRightCorner',
    'backRightCorner',
    'frontLeftCorner',
    'backLeftCorner',
    'frontRightDoor',
    'backRightDoor',
    'frontLeftDoor',
    'backLeftDoor',
    'frontInsideView',
    'backInsideView',
    'frontDashBoard',
    'carTopView',
];

const BODY_CONDITION_KEY_SET = new Set(BODY_CONDITION_KEYS);

const HANDOVER_HISTORY_ACTIONS = ['Assigned', 'Accepted', 'Transfer', 'ControllerHandover'];
const VEHICLE_INSPECTION_HANDOVER_KIND = 'vehicle_inspection';

function isInspectionHandoverHistoryRecord(record) {
    if (!record) return false;
    if (String(record?.details?.handoverKind || '').trim() === VEHICLE_INSPECTION_HANDOVER_KIND) {
        return true;
    }
    return record?.details?.firstInspection === true;
}

function isInspectionWorkflowActive(asset) {
    const status = String(asset?.vehicleInspectionStatus || '').toLowerCase();
    return status === 'draft' || status === 'pending_hr';
}

function asObjectId(value) {
    if (!value) return null;
    if (value instanceof mongoose.Types.ObjectId) return value;
    const raw = typeof value === 'object' && value._id != null ? value._id : value;
    const str = String(raw || '').trim();
    if (!str || str.startsWith('live-') || !mongoose.Types.ObjectId.isValid(str)) return null;
    return new mongoose.Types.ObjectId(str);
}

function resolveBodyConditionSource(entry) {
    const candidates = [
        entry?.details?.bodyConditionReport,
        entry?.details?.bodyCondition,
        entry?.bodyConditionReport,
    ];
    return candidates.find((item) => item && typeof item === 'object') || null;
}

function hasPhotoValue(value) {
    if (!value) return false;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return Boolean(trimmed && trimmed !== 'undefined' && trimmed !== 'null');
    }
    if (typeof value === 'object') {
        return Boolean(value.url || value.publicId || value.path || value.data || value.image);
    }
    return false;
}

/** True when a history row has a usable body-condition report (photos, comments, or completed flag). */
export function hasBodyConditionReportData(entry) {
    if (!entry) return false;
    if (entry?.details?.bodyConditionCompleted === true) return true;

    const source = resolveBodyConditionSource(entry);
    if (!source) return false;

    return BODY_CONDITION_KEYS.some((key) => {
        const block = source[key];
        if (!block || typeof block !== 'object') {
            return hasPhotoValue(source[`${key}Photo`]) || Boolean(String(source[`${key}Comment`] || '').trim());
        }
        return (
            hasPhotoValue(block.photo || block.image || block.attachment) ||
            Boolean(String(block.comment || block.notes || '').trim())
        );
    });
}

async function loadHistoryIfBodyCondition(historyId) {
    const id = asObjectId(historyId);
    if (!id) return null;
    const row = await AssetHistory.findById(id).exec();
    if (!row || !hasBodyConditionReportData(row)) return null;
    return row;
}

/**
 * Resolve the latest handover body-condition history for a vehicle.
 * Prefer the open fleet handover, then the latest non-inspection assignment report.
 * Only prefer the linked inspection history while inspection is still in draft/pending_hr —
 * after approval that ID stays set and must not steal service photo replacements from the
 * assignment Body Condition Report the UI shows.
 */
export async function findLatestBodyConditionHistoryRecord(assetOrId) {
    const looksLikeAssetDoc =
        Boolean(assetOrId) &&
        typeof assetOrId === 'object' &&
        !(assetOrId instanceof mongoose.Types.ObjectId) &&
        (assetOrId._id != null ||
            assetOrId.id != null ||
            assetOrId.vehicleInspectionHandoverHistoryId != null ||
            assetOrId.pendingActionDetails != null ||
            Array.isArray(assetOrId.services));

    const asset = looksLikeAssetDoc ? assetOrId : null;
    const assetId = asObjectId(asset?._id || asset?.id || assetOrId);
    if (!assetId) return null;

    const openHandoverIds = [
        asset?.pendingActionDetails?.vehicleHandoverFlow?.historyId,
        asset?.pendingActionDetails?.historyId,
    ];

    for (const preferredId of openHandoverIds) {
        const preferred = await loadHistoryIfBodyCondition(preferredId);
        if (preferred && String(preferred.assetId) === String(assetId)) {
            return preferred;
        }
    }

    // While inspection is actively in progress, update that linked report.
    if (isInspectionWorkflowActive(asset)) {
        const inspection = await loadHistoryIfBodyCondition(asset?.vehicleInspectionHandoverHistoryId);
        if (inspection && String(inspection.assetId) === String(assetId)) {
            return inspection;
        }
    }

    // Targeted search: handover/inspection rows that already store body condition.
    const handoverRows = await AssetHistory.find({
        assetId,
        action: { $in: HANDOVER_HISTORY_ACTIONS },
        $or: [
            { 'details.bodyConditionCompleted': true },
            { 'details.bodyConditionReport': { $exists: true, $ne: null } },
            { 'details.bodyCondition': { $exists: true, $ne: null } },
        ],
    })
        .sort({ createdAt: -1, _id: -1 })
        .limit(80)
        .exec();

    // Prefer fleet assignment / return handovers over a completed inspection baseline.
    const fromFleet = handoverRows.find(
        (row) => hasBodyConditionReportData(row) && !isInspectionHandoverHistoryRecord(row),
    );
    if (fromFleet) return fromFleet;

    const fromHandover = handoverRows.find((row) => hasBodyConditionReportData(row));
    if (fromHandover) return fromHandover;

    // Approved inspection may still be the only body-condition report on the vehicle.
    if (!isInspectionWorkflowActive(asset)) {
        const inspection = await loadHistoryIfBodyCondition(asset?.vehicleInspectionHandoverHistoryId);
        if (inspection && String(inspection.assetId) === String(assetId)) {
            return inspection;
        }
    }

    // Fallback: scan more history in case action typing differs.
    const recentRows = await AssetHistory.find({ assetId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(200)
        .exec();

    const fromRecentFleet = recentRows.find(
        (row) => hasBodyConditionReportData(row) && !isInspectionHandoverHistoryRecord(row),
    );
    if (fromRecentFleet) return fromRecentFleet;

    return recentRows.find((row) => hasBodyConditionReportData(row)) || null;
}

function parseServiceRemark(service) {
    if (!service?.remark) return {};
    if (typeof service.remark === 'object' && !Array.isArray(service.remark)) return { ...service.remark };
    try {
        const parsed = JSON.parse(service.remark);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function isMappedConditionImage(img) {
    const key = String(img?.bodyPartKey || '').trim();
    return Boolean(key && BODY_CONDITION_KEY_SET.has(key) && (img?.data || img?.url || img?.photo));
}

/**
 * Build mapped replacement images from this request plus saved service remark URLs.
 * Request images win per body part (may still include base64 `data`).
 */
export function resolveMappedNewConditionImages({ requestImages = [], service = null } = {}) {
    const byKey = new Map();

    const remark = parseServiceRemark(service);
    const fromRemark = Array.isArray(remark.newConditionImages) ? remark.newConditionImages : [];
    for (const img of fromRemark) {
        if (!isMappedConditionImage(img)) continue;
        byKey.set(String(img.bodyPartKey).trim(), img);
    }

    for (const img of Array.isArray(requestImages) ? requestImages : []) {
        if (!isMappedConditionImage(img)) continue;
        byKey.set(String(img.bodyPartKey).trim(), img);
    }

    return [...byKey.values()];
}

/**
 * Replace mapped body-part photos on the latest handover body-condition report.
 * Marks rows with replacedByService so the UI can show orange (no fine path).
 */
export async function applyServiceBodyConditionReplacements(asset, {
    images = [],
    serviceTypeLabel = '',
    serviceId = '',
    historyId = '',
} = {}) {
    const replacements = (Array.isArray(images) ? images : []).filter(isMappedConditionImage);
    if (!replacements.length) return { updated: 0, historyId: null };

    const record = historyId
        ? await loadHistoryIfBodyCondition(historyId)
        : await findLatestBodyConditionHistoryRecord(asset);
    if (!record) {
        throw new Error(
            'No handover body condition report found to replace. Complete a handover body condition first.',
        );
    }
    if (String(record.assetId) !== String(asset._id || asset.id)) {
        throw new Error('Assignment does not belong to this vehicle.');
    }

    const existing =
        record.details?.bodyConditionReport && typeof record.details.bodyConditionReport === 'object'
            ? { ...record.details.bodyConditionReport }
            : record.details?.bodyCondition && typeof record.details.bodyCondition === 'object'
              ? { ...record.details.bodyCondition }
              : {};

    const usedKeys = new Set();
    const label = String(serviceTypeLabel || 'Service').trim() || 'Service';
    const comment = `Updated from ${label} completion`;

    for (const img of replacements) {
        const key = String(img.bodyPartKey).trim();
        if (usedKeys.has(key)) {
            throw new Error(`Body part "${key}" can only be selected once.`);
        }
        usedKeys.add(key);

        let photo = img.photo || img.url || null;
        if (img.data) {
            photo = await persistStoredAttachmentValue(
                img.data.startsWith?.('data:')
                    ? img.data
                    : `data:${img.mimeType || 'image/jpeg'};base64,${img.data}`,
                'asset-history',
                `${key}-body-condition-service`,
            );
            if (typeof photo === 'string' && photo.startsWith('http')) {
                photo = normalizeS3Key(photo) || photo;
            }
        } else if (typeof photo === 'string' && photo.startsWith('http')) {
            photo = normalizeS3Key(photo) || photo;
        }

        if (!photo) {
            throw new Error(`Missing photo data for body part "${key}".`);
        }

        const prevRow = existing[key] && typeof existing[key] === 'object' ? existing[key] : {};
        // Keep the photo that was on Assign/Inspection before this Complete upload
        // so Compare can show Previous vs New on the same last row.
        const priorPhoto = prevRow.photo ?? prevRow.image ?? prevRow.attachment ?? null;
        const serviceBaselinePhoto = hasPhotoValue(prevRow.serviceBaselinePhoto)
            ? prevRow.serviceBaselinePhoto
            : hasPhotoValue(priorPhoto)
              ? priorPhoto
              : undefined;

        existing[key] = {
            ...prevRow,
            comment: String(prevRow.comment || '').trim() || comment,
            photo,
            photoSource: 'new',
            userSelected: true,
            replacedByService: true,
            replacedByServiceType: label,
            replacedByServiceId: serviceId ? String(serviceId) : undefined,
            replacedByServiceAt: new Date().toISOString(),
            ...(serviceBaselinePhoto ? { serviceBaselinePhoto } : {}),
        };
    }

    const detailsBase =
        record.details && typeof record.details === 'object' ? { ...record.details } : {};
    detailsBase.bodyConditionReport = existing;
    detailsBase.bodyConditionCompleted = true;
    record.details = detailsBase;
    record.markModified('details');
    await record.save();

    return { updated: usedKeys.size, historyId: String(record._id) };
}

/**
 * Re-apply mapped new-condition photos from a completed service remark onto the
 * current fleet handover body-condition report (recovery / re-sync).
 */
export async function syncServiceNewConditionImagesToHandover(asset, serviceId, {
    serviceTypeLabel = '',
} = {}) {
    const service = asset?.services?.id?.(serviceId);
    if (!service) {
        throw new Error('Service record not found');
    }

    const mappedImages = resolveMappedNewConditionImages({ service });
    if (!mappedImages.length) {
        throw new Error(
            'No mapped new condition photos found. Complete the service with Replace to body parts selected.',
        );
    }

    const label =
        String(serviceTypeLabel || service.serviceType || '').trim() || 'Service';

    return applyServiceBodyConditionReplacements(asset, {
        images: mappedImages,
        serviceTypeLabel: label,
        serviceId,
    });
}

async function persistQueuedPhoto(img, bodyPartKey) {
    let photo = img.photo || img.url || null;
    if (img.data) {
        photo = await persistStoredAttachmentValue(
            img.data.startsWith?.('data:')
                ? img.data
                : `data:${img.mimeType || 'image/jpeg'};base64,${img.data}`,
            'asset-history',
            `${bodyPartKey}-body-condition-service-pending`,
        );
        if (typeof photo === 'string' && photo.startsWith('http')) {
            photo = normalizeS3Key(photo) || photo;
        }
    } else if (typeof photo === 'string' && photo.startsWith('http')) {
        photo = normalizeS3Key(photo) || photo;
    }
    return photo;
}

/**
 * Store new-condition photos for HR review on the current assignment.
 * Does not replace live body-condition photos until HR approves.
 */
export async function queuePendingServicePhotoReview(asset, {
    images = [],
    serviceTypeLabel = '',
    serviceId = '',
} = {}) {
    const replacements = (Array.isArray(images) ? images : []).filter(isMappedConditionImage);
    if (!replacements.length) return { queued: 0, historyId: null };

    const record = await findLatestBodyConditionHistoryRecord(asset);
    if (!record) {
        throw new Error(
            'No handover body condition report found to review. Complete a handover body condition first.',
        );
    }

    const queuedImages = [];
    const usedKeys = new Set();
    for (const img of replacements) {
        const key = String(img.bodyPartKey).trim();
        if (usedKeys.has(key)) {
            throw new Error(`Body part "${key}" can only be selected once.`);
        }
        usedKeys.add(key);
        const photo = await persistQueuedPhoto(img, key);
        if (!photo) {
            throw new Error(`Missing photo data for body part "${key}".`);
        }
        queuedImages.push({
            bodyPartKey: key,
            photo,
            name: img.name || `${key}.jpg`,
            mimeType: img.mimeType || 'image/jpeg',
        });
    }

    const detailsBase =
        record.details && typeof record.details === 'object' ? { ...record.details } : {};
    detailsBase.pendingServicePhotoReview = {
        status: 'pending',
        serviceId: serviceId ? String(serviceId) : '',
        serviceTypeLabel: String(serviceTypeLabel || 'Service').trim() || 'Service',
        images: queuedImages,
        requestedAt: new Date().toISOString(),
    };
    record.details = detailsBase;
    record.markModified('details');
    await record.save();

    return {
        queued: queuedImages.length,
        historyId: String(record._id),
        images: queuedImages,
    };
}

export function readPendingServicePhotoReview(historyEntry) {
    const pending = historyEntry?.details?.pendingServicePhotoReview;
    if (!pending || typeof pending !== 'object') return null;
    if (String(pending.status || '').toLowerCase() !== 'pending') return null;
    if (!Array.isArray(pending.images) || !pending.images.length) return null;
    return pending;
}

/**
 * HR approve: replace assignment photos. Reject: keep the previous images.
 */
export async function resolvePendingServicePhotoReview(asset, historyId, { approve = true, actorName = '' } = {}) {
    const record = await loadHistoryIfBodyCondition(historyId);
    if (!record) throw new Error('Assignment body condition report not found.');
    if (String(record.assetId) !== String(asset._id || asset.id)) {
        throw new Error('Assignment does not belong to this vehicle.');
    }

    const pending = record.details?.pendingServicePhotoReview;
    if (!pending || String(pending.status || '').toLowerCase() !== 'pending') {
        throw new Error('No pending assignment photo review.');
    }

    const serviceId = String(pending.serviceId || '').trim();
    const serviceTypeLabel = String(pending.serviceTypeLabel || 'Service').trim() || 'Service';

    if (approve) {
        await applyServiceBodyConditionReplacements(asset, {
            images: pending.images || [],
            serviceTypeLabel,
            serviceId,
            historyId: String(record._id),
        });
        const fresh = await AssetHistory.findById(record._id).exec();
        if (fresh) {
            const details =
                fresh.details && typeof fresh.details === 'object' ? { ...fresh.details } : {};
            details.pendingServicePhotoReview = {
                ...pending,
                status: 'approved',
                resolvedAt: new Date().toISOString(),
                resolvedByName: actorName || '',
            };
            fresh.details = details;
            fresh.markModified('details');
            await fresh.save();
        }
        return { action: 'approved', historyId: String(record._id) };
    }

    const details = record.details && typeof record.details === 'object' ? { ...record.details } : {};
    details.pendingServicePhotoReview = {
        ...pending,
        status: 'rejected',
        resolvedAt: new Date().toISOString(),
        resolvedByName: actorName || '',
    };
    record.details = details;
    record.markModified('details');
    await record.save();
    return { action: 'rejected', historyId: String(record._id) };
}

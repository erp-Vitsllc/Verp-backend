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
 * Resolve the latest handover/inspection body-condition history for a vehicle.
 * Prefers linked inspection / open handover IDs, then handover-action rows (not only the
 * newest 40 history events — service/comment spam used to hide the real report).
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

    const preferredIds = [
        asset?.vehicleInspectionHandoverHistoryId,
        asset?.pendingActionDetails?.vehicleHandoverFlow?.historyId,
        asset?.pendingActionDetails?.historyId,
    ];

    for (const preferredId of preferredIds) {
        const preferred = await loadHistoryIfBodyCondition(preferredId);
        if (preferred && String(preferred.assetId) === String(assetId)) {
            return preferred;
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

    const fromHandover = handoverRows.find((row) => hasBodyConditionReportData(row));
    if (fromHandover) return fromHandover;

    // Fallback: scan more history in case action typing differs.
    const recentRows = await AssetHistory.find({ assetId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(200)
        .exec();

    return recentRows.find((row) => hasBodyConditionReportData(row)) || null;
}

/**
 * Replace mapped body-part photos on the latest handover body-condition report.
 * Marks rows with replacedByService so the UI can show orange (no fine path).
 */
export async function applyServiceBodyConditionReplacements(asset, {
    images = [],
    serviceTypeLabel = '',
    serviceId = '',
} = {}) {
    const replacements = (Array.isArray(images) ? images : []).filter((img) => {
        const key = String(img?.bodyPartKey || '').trim();
        return key && BODY_CONDITION_KEY_SET.has(key) && (img?.data || img?.url || img?.photo);
    });
    if (!replacements.length) return { updated: 0, historyId: null };

    const record = await findLatestBodyConditionHistoryRecord(asset);
    if (!record) {
        throw new Error(
            'No handover body condition report found to replace. Complete a handover body condition first.',
        );
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

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

function hasBodyConditionReportData(entry) {
    const source =
        entry?.details?.bodyConditionReport ||
        entry?.details?.bodyCondition ||
        entry?.bodyConditionReport ||
        null;
    if (!source || typeof source !== 'object') return false;
    return BODY_CONDITION_KEYS.some((key) => {
        const block = source[key];
        if (!block || typeof block !== 'object') {
            return Boolean(source[`${key}Photo`]);
        }
        return Boolean(block.photo || block.image || block.attachment);
    });
}

export async function findLatestBodyConditionHistoryRecord(assetId) {
    if (!assetId) return null;
    const rows = await AssetHistory.find({ assetId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(40)
        .exec();
    return rows.find((row) => hasBodyConditionReportData(row)) || null;
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

    const record = await findLatestBodyConditionHistoryRecord(asset?._id || asset?.id);
    if (!record) {
        throw new Error(
            'No handover body condition report found to replace. Complete a handover body condition first.',
        );
    }

    const existing =
        record.details?.bodyConditionReport && typeof record.details.bodyConditionReport === 'object'
            ? { ...record.details.bodyConditionReport }
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
    record.details = detailsBase;
    record.markModified('details');
    await record.save();

    return { updated: usedKeys.size, historyId: String(record._id) };
}

import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import { uploadDocumentToS3 } from './s3Upload.js';

const RECEIVER_ASSESSMENT_KEYS = [
    'spareTyre',
    'toolsKit',
    'scissorJack',
    'firstAidKit',
    'fireExtinguisher',
];

const FLEET_HANDOVER_ACTIONS = new Set(['Assigned', 'Accepted', 'Transfer', 'ControllerHandover']);

function entryTimestamp(entry) {
    const value = entry?.createdAt || entry?.date;
    const parsed = value ? new Date(Date.parse(value)) : 0;
    return Number.isNaN(parsed) ? 0 : parsed;
}

function isPriorHandoverReportSourceEntry(entry) {
    if (!entry) return false;
    return FLEET_HANDOVER_ACTIONS.has(String(entry?.action || '').trim());
}

function resolveAssessmentSource(historyEntry) {
    const candidates = [
        historyEntry?.details?.receiverAssessment,
        historyEntry?.details?.vehicleAssessmentReportByReceiver,
        historyEntry?.receiverAssessment,
        historyEntry?.details?.receiverAssessmentReport,
    ];
    return candidates.find((item) => item && typeof item === 'object') || null;
}

function pickAssessmentBlock(source, key) {
    if (!source || typeof source !== 'object') return { present: null, photo: null };
    const nested = source[key];
    if (nested && typeof nested === 'object') {
        return {
            present:
                nested.present === true ? true : nested.present === false ? false : null,
            photo: nested.photo ?? nested.image ?? nested.attachment ?? null,
            amount: nested.amount ?? null,
        };
    }
    return {
        present: nested === true ? true : nested === false ? false : null,
        photo: source[`${key}Photo`] ?? source[`${key}Image`] ?? null,
        amount: source[`${key}Amount`] ?? null,
    };
}

function normalizePhotoKey(photo) {
    if (!photo) return '';
    if (typeof photo === 'string') {
        const trimmed = photo.trim();
        if (trimmed.startsWith('data:')) return trimmed.slice(0, 120);
        return trimmed.split('?')[0];
    }
    if (typeof photo === 'object') {
        const nested = photo.url || photo.publicId || photo.path || photo.data || '';
        return normalizePhotoKey(nested);
    }
    return '';
}

function photosDiffer(previousPhoto, currentPhoto) {
    const prevKey = normalizePhotoKey(previousPhoto);
    const currKey = normalizePhotoKey(currentPhoto);
    if (!prevKey && !currKey) return false;
    if (!prevKey || !currKey) return true;
    return prevKey !== currKey;
}

function presentValueChanged(previousPresent, currentPresent) {
    if (previousPresent === currentPresent) return false;
    return (
        (previousPresent === true || previousPresent === false) &&
        (currentPresent === true || currentPresent === false)
    );
}

function assessmentChangedVsPrevious(currentMerged, previousSource) {
    if (!previousSource) return false;
    return RECEIVER_ASSESSMENT_KEYS.some((key) => {
        const current = pickAssessmentBlock(currentMerged, key);
        const previous = pickAssessmentBlock(previousSource, key);
        return (
            photosDiffer(previous.photo, current.photo) ||
            presentValueChanged(previous.present, current.present)
        );
    });
}

function findPreviousAssessmentHandoverEntry(assetHistory, currentHistoryId) {
    if (!Array.isArray(assetHistory) || !currentHistoryId) return null;

    const currentId = String(currentHistoryId);
    const current = assetHistory.find((row) => String(row?._id) === currentId);
    const currentTs = entryTimestamp(current);

    const candidates = assetHistory
        .filter((row) => {
            if (!row?._id || String(row._id) === currentId) return false;
            if (!isPriorHandoverReportSourceEntry(row)) return false;
            if (!resolveAssessmentSource(row)) return false;
            if (!currentTs) return true;
            const rowTs = entryTimestamp(row);
            if (rowTs < currentTs) return true;
            if (rowTs > currentTs) return false;
            return String(row._id) < currentId;
        })
        .sort((a, b) => {
            const diff = entryTimestamp(b) - entryTimestamp(a);
            if (diff !== 0) return diff;
            return String(b?._id || '').localeCompare(String(a?._id || ''));
        });

    return candidates[0] || null;
}

async function persistAssessmentPhoto(photo) {
    if (!photo) return null;
    if (typeof photo === 'string' && photo.startsWith('data:image')) {
        const uploadResult = await uploadDocumentToS3(photo, 'asset-accessories');
        return uploadResult.publicId;
    }
    return photo;
}

async function buildStoredEntryFromAssessment(merged, historyId) {
    const entry = {
        createdAt: new Date(),
        sourceHistoryId: historyId,
        kind: 'assignment_change',
    };

    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const row = merged[key];
        if (!row || typeof row !== 'object') continue;
        const present =
            row.present === true ? true : row.present === false ? false : null;
        let photo = present === true ? row.photo || null : null;
        if (photo) {
            photo = await persistAssessmentPhoto(photo);
        }
        const amount =
            row.amount != null && row.amount !== '' && Number.isFinite(Number(row.amount))
                ? Number(row.amount)
                : null;
        entry[key] = { present, photo, amount };
    }

    return entry;
}

export async function syncVehicleAccessoriesListOnAssessmentComplete(historyRecord, mergedAssessment) {
    if (!historyRecord?.assetId || !historyRecord?._id || !mergedAssessment) return;

    const historyId = historyRecord._id;
    const asset = await AssetItem.findById(historyRecord.assetId);
    if (!asset) return;

    const historyList = await AssetHistory.find({ assetId: historyRecord.assetId })
        .select('action createdAt date details')
        .lean();

    const previousEntry = findPreviousAssessmentHandoverEntry(historyList, historyId);
    const previousSource = previousEntry ? resolveAssessmentSource(previousEntry) : null;

    if (!previousSource) return;
    if (!assessmentChangedVsPrevious(mergedAssessment, previousSource)) return;

    const existing = Array.isArray(asset.vehicleAccessoriesListEntries)
        ? asset.vehicleAccessoriesListEntries
        : [];
    const alreadyStored = existing.some(
        (row) => String(row?.sourceHistoryId || '') === String(historyId),
    );
    if (alreadyStored) return;

    const storedEntry = await buildStoredEntryFromAssessment(mergedAssessment, historyId);
    asset.vehicleAccessoriesListEntries = [...existing, storedEntry];
    asset.markModified('vehicleAccessoriesListEntries');
    await asset.save();
}

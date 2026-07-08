import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import { normalizeS3Key, uploadDocumentToS3 } from './s3Upload.js';

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
    if (!source || typeof source !== 'object') return { present: null, photo: null, amount: null };
    const nested = source[key];
    if (nested && typeof nested === 'object') {
        const present =
            nested.present === true ? true : nested.present === false ? false : nested.photo ? true : null;
        return {
            present,
            photo: nested.photo ?? nested.image ?? nested.attachment ?? null,
            amount: nested.amount ?? null,
        };
    }
    const photo = source[`${key}Photo`] ?? source[`${key}Image`] ?? null;
    const present =
        nested === true ? true : nested === false ? false : photo ? true : null;
    return {
        present,
        photo,
        amount: source[`${key}Amount`] ?? null,
    };
}

function storedEntryHasAssessmentData(entry) {
    if (!entry || typeof entry !== 'object') return false;
    return RECEIVER_ASSESSMENT_KEYS.some((key) => {
        const block = pickAssessmentBlock(entry, key);
        return block.present === true || block.present === false || Boolean(block.photo);
    });
}

function findPreviousAccessoriesListBaselineEntry(asset, currentHistoryId = '') {
    const entries = Array.isArray(asset?.vehicleAccessoriesListEntries)
        ? asset.vehicleAccessoriesListEntries
        : [];
    if (!entries.length) return null;

    const currentId = String(currentHistoryId || '');
    const ranked = [...entries].sort((a, b) => {
        const diff = entryTimestamp(b) - entryTimestamp(a);
        if (diff !== 0) return diff;
        return String(b?._id || '').localeCompare(String(a?._id || ''));
    });

    for (const entry of ranked) {
        const kind = String(entry?.kind || 'manual');
        const sourceId = String(entry?.sourceHistoryId || '');
        if (kind === 'assignment_change' && sourceId && sourceId === currentId) continue;
        if (storedEntryHasAssessmentData(entry)) return entry;
    }

    return null;
}

function buildPreviousSourceFromStoredEntry(entry) {
    if (!entry) return null;
    const source = {};
    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const block = pickAssessmentBlock(entry, key);
        if (block.present === true || block.present === false || block.photo) {
            source[key] = {
                present: block.present,
                photo: block.photo,
                amount: block.amount,
            };
        }
    }
    return Object.keys(source).length ? source : null;
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
    const { any } = computeAssessmentChangeMap(currentMerged, previousSource);
    return any;
}

function computeAssessmentChangeMap(currentMerged, previousSource) {
    const changedByKey = {};
    let any = false;

    if (!previousSource) {
        return { any: false, changedByKey };
    }

    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const current = pickAssessmentBlock(currentMerged, key);
        const previous = pickAssessmentBlock(previousSource, key);
        const itemChanged =
            photosDiffer(previous.photo, current.photo) ||
            presentValueChanged(previous.present, current.present);
        changedByKey[key] = itemChanged;
        if (itemChanged) any = true;
    }

    return { any, changedByKey };
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

async function persistAccessoriesListPhotoRef(photo) {
    if (!photo) return null;
    if (typeof photo === 'string' && photo.startsWith('data:image')) {
        const uploadResult = await uploadDocumentToS3(photo, 'asset-accessories');
        return uploadResult.publicId;
    }
    if (typeof photo === 'string') {
        const normalized = normalizeS3Key(photo);
        if (normalized) return normalized;
        if (photo.startsWith('http')) return null;
        return photo.trim() || null;
    }
    return photo;
}

export async function signVehicleAccessoriesListEntries(entries, signFileUrl) {
    if (!Array.isArray(entries) || typeof signFileUrl !== 'function') return entries;

    return Promise.all(
        entries.map(async (entry) => {
            if (!entry || typeof entry !== 'object') return entry;
            const next = { ...entry };

            for (const key of RECEIVER_ASSESSMENT_KEYS) {
                const row = entry[key];
                if (!row || typeof row !== 'object') continue;

                let photo = row.photo ?? null;
                if (photo && typeof photo === 'string') {
                    const trimmed = photo.trim();
                    if (trimmed.startsWith('data:')) {
                        next[key] = { ...row, photo: trimmed };
                        continue;
                    }
                    const storageKey = normalizeS3Key(trimmed) || trimmed;
                    const signed = await signFileUrl(storageKey);
                    next[key] = { ...row, photo: signed || trimmed };
                    continue;
                }

                next[key] = { ...row };
            }

            return next;
        }),
    );
}

async function persistAssessmentPhoto(photo) {
    return persistAccessoriesListPhotoRef(photo);
}

async function buildStoredEntryFromAssessment(merged, historyId, changedByKey = {}) {
    const entry = {
        createdAt: new Date(),
        sourceHistoryId: historyId,
        kind: 'assignment_change',
        changedByKey: { ...changedByKey },
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
    let previousSource = previousEntry ? resolveAssessmentSource(previousEntry) : null;
    if (!previousSource) {
        const storedBaseline = findPreviousAccessoriesListBaselineEntry(asset, historyId);
        previousSource = buildPreviousSourceFromStoredEntry(storedBaseline);
    }

    const { any: hasChanges, changedByKey } = computeAssessmentChangeMap(
        mergedAssessment,
        previousSource,
    );

    if (!previousSource || !hasChanges) return;

    const existingIdx = (asset.vehicleAccessoriesListEntries || []).findIndex(
        (row) => String(row?.sourceHistoryId || '') === String(historyId),
    );

    const storedEntry = await buildStoredEntryFromAssessment(
        mergedAssessment,
        historyId,
        changedByKey,
    );

    if (existingIdx >= 0) {
        const subdoc = asset.vehicleAccessoriesListEntries[existingIdx];
        Object.entries(storedEntry).forEach(([key, value]) => {
            subdoc[key] = value;
        });
    } else {
        if (!Array.isArray(asset.vehicleAccessoriesListEntries)) {
            asset.vehicleAccessoriesListEntries = [];
        }
        asset.vehicleAccessoriesListEntries.push(storedEntry);
    }
    asset.markModified('vehicleAccessoriesListEntries');
    await asset.save();
}

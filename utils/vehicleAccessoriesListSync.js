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
        if (currentId && sourceId && sourceId === currentId) continue;
        if (kind === 'live_accessories') continue;
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

export function photosDiffer(previousPhoto, currentPhoto) {
    const prevKey = normalizePhotoKey(previousPhoto);
    const currKey = normalizePhotoKey(currentPhoto);
    if (!prevKey && !currKey) return false;
    if (!prevKey || !currKey) return true;
    return prevKey !== currKey;
}

export function presentValueChanged(previousPresent, currentPresent) {
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

async function signAccessoryPhotoValue(photo, signFileUrl) {
    if (!photo) return photo;

    if (typeof photo === 'string') {
        const trimmed = photo.trim();
        if (!trimmed) return photo;
        if (trimmed.startsWith('data:')) return trimmed;
        if (trimmed.startsWith('http')) {
            const storageKey = normalizeS3Key(trimmed);
            if (storageKey) {
                const signed = await signFileUrl(storageKey);
                return signed || trimmed;
            }
            return trimmed;
        }
        const storageKey = normalizeS3Key(trimmed) || trimmed;
        const signed = await signFileUrl(storageKey);
        return signed || trimmed;
    }

    if (typeof photo === 'object' && !Array.isArray(photo)) {
        const ref = photo.publicId || photo.path || photo.url;
        if (!ref) return photo;
        const storageKey = normalizeS3Key(String(ref));
        if (storageKey) {
            const signed = await signFileUrl(storageKey);
            if (signed) return signed;
        }
        if (typeof photo.url === 'string' && photo.url.trim().startsWith('http')) {
            return photo.url.trim();
        }
        if (typeof ref === 'string' && ref.trim().startsWith('http')) {
            return ref.trim();
        }
        return storageKey || photo;
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

                const signedPhoto = await signAccessoryPhotoValue(row.photo ?? null, signFileUrl);
                next[key] = { ...row, photo: signedPhoto };
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
    // Accessories list updates are deferred until HR approval — see applyPendingHandoverAccessoriesToVehicleList.
    return { deferred: true };
}

const BODY_CONDITION_KEYS_FOR_HR = [
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

function resolveBodyConditionSource(historyEntry) {
    const candidates = [
        historyEntry?.details?.bodyConditionReport,
        historyEntry?.details?.bodyCondition,
        historyEntry?.bodyConditionReport,
    ];
    return candidates.find((item) => item && typeof item === 'object') || null;
}

function pickBodyConditionBlock(source, key) {
    if (!source || typeof source !== 'object') {
        return { comment: '', photo: null, photoSource: null };
    }
    const block = source[key];
    if (!block || typeof block !== 'object') {
        return {
            comment: String(source[`${key}Comment`] || '').trim(),
            photo: source[`${key}Photo`] ?? null,
            photoSource: null,
        };
    }
    return {
        comment: String(block.comment ?? block.notes ?? '').trim(),
        photo: block.photo ?? block.image ?? block.attachment ?? null,
        photoSource:
            block.photoSource === 'previous' || block.photoSource === 'new'
                ? block.photoSource
                : null,
    };
}

function bodyConditionEntryHasData(entry) {
    const source = resolveBodyConditionSource(entry);
    if (!source) return false;
    return BODY_CONDITION_KEYS_FOR_HR.some((key) => {
        const block = pickBodyConditionBlock(source, key);
        return Boolean(block.photo) || Boolean(block.comment);
    });
}

function accessoryItemChangedVsBaseline(baseline, current) {
    const currPresent =
        current.present === true ? true : current.present === false ? false : current.photo ? true : null;
    if (currPresent !== true && currPresent !== false) return false;

    const basePresent =
        baseline.present === true ? true : baseline.present === false ? false : baseline.photo ? true : null;
    const hasBaseline = basePresent === true || basePresent === false || Boolean(baseline.photo);
    if (!hasBaseline) return false;
    if (basePresent !== currPresent) return true;
    if (currPresent === true) {
        return photosDiffer(baseline.photo, current.photo);
    }
    return false;
}

/**
 * Build accessories baseline matching the assign-page CHANGED/OK badges:
 * committed list entries (not live overlays), excluding the active handover's own snapshots.
 */
function buildCommittedAccessoriesBaseline(asset, currentHistoryId = '') {
    const entries = Array.isArray(asset?.vehicleAccessoriesListEntries)
        ? asset.vehicleAccessoriesListEntries
        : [];
    const currentId = String(currentHistoryId || '');
    const ranked = [...entries].sort((a, b) => {
        const diff = entryTimestamp(b) - entryTimestamp(a);
        if (diff !== 0) return diff;
        return String(b?._id || '').localeCompare(String(a?._id || ''));
    });

    // Oldest → newest so later committed rows overwrite earlier ones per key.
    const chronological = [...ranked].reverse();
    const blocksByKey = {};

    for (const entry of chronological) {
        const kind = String(entry?.kind || 'manual');
        const sourceId = String(entry?.sourceHistoryId || '');
        if (currentId && sourceId && sourceId === currentId) continue;
        if (kind === 'replaced_live') continue;
        if (kind === 'live_accessories') continue;
        if (!storedEntryHasAssessmentData(entry)) continue;

        for (const key of RECEIVER_ASSESSMENT_KEYS) {
            const block = pickAssessmentBlock(entry, key);
            if (block.present === true || block.present === false || block.photo) {
                blocksByKey[key] = block;
            }
        }
    }

    return blocksByKey;
}

function accessoriesHaveHandoverChanges(historyRecord, asset, previousAssessmentEntry = null) {
    const currentSource = resolveAssessmentSource(historyRecord);
    if (!currentSource) return false;

    const currentId = historyRecord?._id?.toString?.() || String(historyRecord?._id || '');
    const listBaseline = buildCommittedAccessoriesBaseline(asset, currentId);
    const previousSource = previousAssessmentEntry
        ? resolveAssessmentSource(previousAssessmentEntry)
        : null;

    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const current = pickAssessmentBlock(currentSource, key);
        let baseline = listBaseline[key] || { present: null, photo: null };
        const hasListBaseline =
            baseline.present === true || baseline.present === false || Boolean(baseline.photo);
        if (!hasListBaseline && previousSource) {
            baseline = pickAssessmentBlock(previousSource, key);
        }
        if (accessoryItemChangedVsBaseline(baseline, current)) return true;
    }
    return false;
}

function bodyConditionHasHandoverChanges(historyRecord, previousBodyEntry = null) {
    if (!previousBodyEntry || !bodyConditionEntryHasData(previousBodyEntry)) return false;

    const currentSource = resolveBodyConditionSource(historyRecord);
    const previousSource = resolveBodyConditionSource(previousBodyEntry);
    if (!currentSource || !previousSource) return false;

    for (const key of BODY_CONDITION_KEYS_FOR_HR) {
        const current = pickBodyConditionBlock(currentSource, key);
        const previous = pickBodyConditionBlock(previousSource, key);
        const hasPreviousBaseline = Boolean(previous.photo) || Boolean(previous.comment);
        if (!hasPreviousBaseline) continue;

        // Explicit "previous image" is not an HR change. Comments alone do not require HR.
        if (current.photoSource === 'previous') continue;
        if (photosDiffer(previous.photo, current.photo)) return true;
    }
    return false;
}

async function findPreviousBodyConditionHistoryEntry(assetId, currentHistoryId) {
    if (!assetId || !currentHistoryId) return null;

    const current = await AssetHistory.findById(currentHistoryId).select('createdAt date').lean();
    const beforeDate = current?.createdAt || current?.date;

    const filter = {
        assetId,
        action: { $in: [...FLEET_HANDOVER_ACTIONS] },
        _id: { $ne: currentHistoryId },
    };
    if (beforeDate) filter.createdAt = { $lt: beforeDate };

    const rows = await AssetHistory.find(filter)
        .sort({ createdAt: -1 })
        .select('details bodyConditionReport action createdAt date')
        .limit(40)
        .lean();

    for (const row of rows) {
        if (bodyConditionEntryHasData(row)) return row;
    }
    return null;
}

async function findPreviousAssessmentHistoryEntry(assetId, currentHistoryId) {
    if (!assetId || !currentHistoryId) return null;

    const current = await AssetHistory.findById(currentHistoryId).select('createdAt date').lean();
    const beforeDate = current?.createdAt || current?.date;

    const filter = {
        assetId,
        action: { $in: [...FLEET_HANDOVER_ACTIONS] },
        _id: { $ne: currentHistoryId },
    };
    if (beforeDate) filter.createdAt = { $lt: beforeDate };

    const rows = await AssetHistory.find(filter)
        .sort({ createdAt: -1 })
        .select('details receiverAssessment action createdAt date')
        .limit(40)
        .lean();

    for (const row of rows) {
        if (resolveAssessmentSource(row)) return row;
    }
    return null;
}

/**
 * HR approval is required only when accessories or body-condition images/presence
 * differ from the previous/committed baseline. Identical reports skip HR.
 */
export async function handoverRequiresHrApproval(historyRecord, asset) {
    if (!historyRecord || !asset) return true;

    const currentId = historyRecord?._id?.toString?.() || String(historyRecord?._id || '');
    const assetId = asset?._id || historyRecord?.assetId;

    const [previousAssessment, previousBody] = await Promise.all([
        findPreviousAssessmentHistoryEntry(assetId, currentId),
        findPreviousBodyConditionHistoryEntry(assetId, currentId),
    ]);

    if (accessoriesHaveHandoverChanges(historyRecord, asset, previousAssessment)) {
        return true;
    }
    if (bodyConditionHasHandoverChanges(historyRecord, previousBody)) {
        return true;
    }
    return false;
}

function findLatestLiveAccessoriesEntry(asset) {
    const entries = Array.isArray(asset?.vehicleAccessoriesListEntries)
        ? asset.vehicleAccessoriesListEntries
        : [];
    const liveEntries = entries.filter((entry) => String(entry?.kind || '') === 'live_accessories');
    if (!liveEntries.length) return null;
    return [...liveEntries].sort((a, b) => {
        const aTs = new Date(a?.createdAt || 0).getTime();
        const bTs = new Date(b?.createdAt || 0).getTime();
        if (bTs !== aTs) return bTs - aTs;
        return String(b?._id || '').localeCompare(String(a?._id || ''));
    })[0];
}

function liveRowHasArchiveableState(row = {}) {
    return row.present === true || row.present === false || Boolean(row.photo);
}

function shouldArchiveLiveRowForPendingApply(previousRow = {}, nextRow = {}) {
    if (!liveRowHasArchiveableState(previousRow)) return false;
    if (nextRow.present === false && previousRow.present !== false) return true;
    return (
        photosDiffer(previousRow.photo, nextRow.photo) ||
        presentValueChanged(previousRow.present, nextRow.present)
    );
}

function assessmentRowDiffers(previousRow = {}, nextRow = {}) {
    return (
        photosDiffer(previousRow.photo, nextRow.photo) ||
        presentValueChanged(previousRow.present, nextRow.present)
    );
}

async function buildReplacedLiveEntry(accessoryKey, row, historyId) {
    let photo = row.present === true ? row.photo || null : null;
    if (photo) {
        photo = await persistAssessmentPhoto(photo);
    }
    const entry = {
        createdAt: new Date(),
        kind: 'replaced_live',
        replacedKey: accessoryKey,
        changedByKey: { [accessoryKey]: true },
    };
    if (historyId) entry.sourceHistoryId = historyId;
    entry[accessoryKey] = {
        present: row.present === false ? false : true,
        photo,
        amount:
            row.amount != null && row.amount !== '' && Number.isFinite(Number(row.amount))
                ? Number(row.amount)
                : null,
    };
    return entry;
}

async function buildLiveAccessoriesEntryFromForm(liveForm, historyId) {
    const entry = {
        createdAt: new Date(),
        kind: 'live_accessories',
    };
    if (historyId) entry.sourceHistoryId = historyId;

    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const row = liveForm[key];
        if (!row || typeof row !== 'object') continue;
        const present =
            row.present === true ? true : row.present === false ? false : null;
        if (present !== true && present !== false) continue;
        let photo = present === true ? row.photo || null : null;
        if (present === true && !photo) continue;
        if (photo) {
            photo = await persistAssessmentPhoto(photo);
        }
        entry[key] = {
            present,
            photo: present === true ? photo : null,
            amount:
                row.amount != null && row.amount !== '' && Number.isFinite(Number(row.amount))
                    ? Number(row.amount)
                    : null,
        };
    }

    return entry;
}

/** Build temp change log vs current live list (stored on history until HR approves). */
export async function buildPendingAccessoriesChanges(asset, mergedAssessment) {
    if (!asset || !mergedAssessment || typeof mergedAssessment !== 'object') return [];

    const liveEntry = findLatestLiveAccessoriesEntry(asset);
    const changes = [];

    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const pending = pickAssessmentBlock(mergedAssessment, key);
        const current = liveEntry ? pickAssessmentBlock(liveEntry, key) : { present: null, photo: null };
        if (!assessmentRowDiffers(current, pending)) continue;

        let nextPhoto = pending.present === true ? pending.photo || null : null;
        if (nextPhoto) {
            nextPhoto = await persistAssessmentPhoto(nextPhoto);
        }

        changes.push({
            key,
            previousPresent: current.present ?? null,
            previousPhoto: current.photo ?? null,
            nextPresent: pending.present === true ? true : pending.present === false ? false : null,
            nextPhoto,
            updatedAt: new Date(),
        });
    }

    return changes;
}

/**
 * After HR approves handover/inspection, apply pending receiverAssessment to vehicle accessories list.
 * Changed live items move prior values to replaced_live (Old Accessories).
 */
export async function applyPendingHandoverAccessoriesToVehicleList(historyRecord) {
    if (!historyRecord?.assetId || !historyRecord?._id) {
        return { applied: false };
    }

    const details = historyRecord.details || {};
    if (details.pendingAccessoriesApplied === true) {
        return { applied: false, alreadyApplied: true };
    }

    const mergedAssessment = resolveAssessmentSource(historyRecord);
    if (!mergedAssessment || typeof mergedAssessment !== 'object') {
        return { applied: false };
    }

    const asset = await AssetItem.findById(historyRecord.assetId);
    if (!asset) {
        return { applied: false };
    }

    const historyId = historyRecord._id;
    const liveEntry = findLatestLiveAccessoriesEntry(asset);
    const currentLiveByKey = Object.fromEntries(
        RECEIVER_ASSESSMENT_KEYS.map((key) => [
            key,
            liveEntry ? pickAssessmentBlock(liveEntry, key) : { present: null, photo: null, amount: null },
        ]),
    );

    let nextEntries = (Array.isArray(asset.vehicleAccessoriesListEntries)
        ? asset.vehicleAccessoriesListEntries
        : []
    ).filter((entry) => String(entry?.kind || '') !== 'live_accessories');

    const newLiveForm = {};
    let anyListChange = false;

    for (const key of RECEIVER_ASSESSMENT_KEYS) {
        const pending = pickAssessmentBlock(mergedAssessment, key);
        if (typeof pending.present !== 'boolean') {
            const current = currentLiveByKey[key];
            if (current.present === true && current.photo) {
                newLiveForm[key] = { present: true, photo: current.photo, amount: current.amount };
            } else if (current.present === false) {
                newLiveForm[key] = { present: false, photo: null, amount: null };
            }
            continue;
        }

        const normalizedPending = {
            present: pending.present,
            photo: pending.present === true ? pending.photo || null : null,
            amount: pending.amount ?? null,
        };

        const current = currentLiveByKey[key] || { present: null, photo: null, amount: null };

        if (!assessmentRowDiffers(current, normalizedPending)) {
            if (current.present === true && current.photo) {
                newLiveForm[key] = { present: true, photo: current.photo, amount: current.amount };
            } else if (current.present === false) {
                newLiveForm[key] = { present: false, photo: null, amount: null };
            }
            continue;
        }

        anyListChange = true;

        if (shouldArchiveLiveRowForPendingApply(current, normalizedPending)) {
            nextEntries.push(await buildReplacedLiveEntry(key, current, historyId));
        }

        if (normalizedPending.present === true && normalizedPending.photo) {
            newLiveForm[key] = {
                present: true,
                photo: normalizedPending.photo,
                amount: normalizedPending.amount,
            };
        } else if (normalizedPending.present === false) {
            newLiveForm[key] = { present: false, photo: null, amount: null };
        }
    }

    const hasLiveRows = RECEIVER_ASSESSMENT_KEYS.some((key) => {
        const row = newLiveForm[key];
        return row && (row.present === true || row.present === false);
    });

    if (anyListChange && hasLiveRows) {
        nextEntries.push(await buildLiveAccessoriesEntryFromForm(newLiveForm, historyId));
        asset.vehicleAccessoriesListEntries = nextEntries;
        asset.markModified('vehicleAccessoriesListEntries');
        await asset.save();
    }

    await AssetHistory.updateOne(
        { _id: historyId },
        {
            $set: {
                'details.pendingAccessoriesApplied': true,
                'details.pendingAccessoriesAppliedAt': new Date(),
            },
            $unset: { 'details.pendingAccessoriesChanges': 1 },
        },
    );

    return { applied: anyListChange && hasLiveRows };
}

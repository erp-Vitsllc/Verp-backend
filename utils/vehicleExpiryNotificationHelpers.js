import DashboardAction from '../models/DashboardAction.js';
import AssetItem from '../models/AssetItem.js';
import {
    buildVehicleExpiryDocumentLabel,
    collectVehicleExpiryDocuments,
    isFleetVehicleAsset,
    isVehicleDocumentArchived,
    resolveVehicleExpiryFocusCard,
    resolveVehicleExpiryTab,
    vehicleExpiryLabelForDocType,
    vehicleExpiryLabelsForSection,
    VEHICLE_EXPIRY_DOC_LABELS,
} from './vehicleExpiryScanUtils.js';
import { cleanupVehicleExpiryNotificationsByLabels, VEHICLE_EXPIRY_REQUEST_TYPE } from './cleanupVehicleExpiryNotifications.js';
import { formatExpiryDateLabel } from './processDocumentExpiryReminders.js';
import { getDaysUntil, isExpiryHrTaskDueForDoc } from './documentExpiryReminderStages.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { isNotificationEnabledForType } from './notificationEmailPermission.js';

function extractExpiryLabel(extra1) {
    const raw = String(extra1 || '').trim();
    const prefix = 'Expiry follow-up required:';
    if (!raw.toLowerCase().startsWith(prefix.toLowerCase())) return '';
    return raw
        .slice(prefix.length)
        .replace(/\s*\(Exp:\s*[^)]+\)\s*$/i, '')
        .trim();
}

function expiryText(extra1) {
    const match = String(extra1 || '').match(/\(Exp:\s*([^)]+)\)/i);
    return match ? match[1].trim().toLowerCase() : '';
}

function docMatchesReminder(doc, label, expText) {
    const docLabel = buildVehicleExpiryDocumentLabel(doc);
    if (!docLabel || docLabel.toLowerCase() !== label) return false;
    if (!doc?.expiryDate || !expText) return false;
    return formatExpiryDateLabel(doc.expiryDate).trim().toLowerCase() === expText;
}

/** Same extra1 string the daily vehicle expiry job stores on DashboardAction. */
export function buildVehicleExpiryFollowUpExtra1(doc) {
    const label = doc?.label || 'Document';
    const expLabel = formatExpiryDateLabel(doc?.expiryDate);
    return `Expiry follow-up required: ${label}${expLabel ? ` (Exp: ${expLabel})` : ''}`;
}

/**
 * extra1 values for live cards that are still inside the HR window (≤10 days or overdue).
 * A renewed card with a later date is not included, so the old reminder is stale.
 */
export function collectLiveDueVehicleExpiryExtra1(asset) {
    const due = new Set();
    for (const doc of collectVehicleExpiryDocuments(asset)) {
        if (!isExpiryHrTaskDueForDoc(getDaysUntil(doc.expiryDate))) continue;
        due.add(buildVehicleExpiryFollowUpExtra1(doc));
    }
    return due;
}

export function isLiveVehicleExpiryExtra1(asset, extra1) {
    return collectLiveDueVehicleExpiryExtra1(asset).has(String(extra1 || '').trim());
}

/** True when this reminder's card was renewed or marked Not Renewed, and no live card remains on that date. */
function documentExpiryReminderIsClosed(asset, extra1) {
    const label = extractExpiryLabel(extra1).toLowerCase();
    const exp = expiryText(extra1);
    if (!asset || !label || !exp) return false;
    const matching = (asset.documents || []).filter((doc) => docMatchesReminder(doc, label, exp));
    if (!matching.length) return false;
    return matching.every((doc) => isVehicleDocumentArchived(doc));
}

function reminderMatchesRemovedDocument(asset, extra1, removedDocs = []) {
    const label = extractExpiryLabel(extra1).toLowerCase();
    const exp = expiryText(extra1);
    if (!label || !exp) return false;
    const removedHit = (removedDocs || []).some((doc) => docMatchesReminder(doc, label, exp));
    if (!removedHit) return false;
    const liveLeft = (asset?.documents || []).some(
        (doc) => docMatchesReminder(doc, label, exp) && !isVehicleDocumentArchived(doc),
    );
    return !liveLeft;
}

export async function clearVehicleExpiryNotificationsForSection(asset, sectionId) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return;
    const labels = vehicleExpiryLabelsForSection(sectionId);
    if (!labels.length) return;
    await cleanupVehicleExpiryNotificationsByLabels({
        assetMongoId: asset._id,
        labels,
    });
}

export async function clearVehicleExpiryNotificationsForDocument(asset, docOrType) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return;
    let label = null;
    if (typeof docOrType === 'string') {
        label = vehicleExpiryLabelForDocType(docOrType);
    } else if (docOrType && typeof docOrType === 'object') {
        label = buildVehicleExpiryDocumentLabel(docOrType);
    }
    if (!label) return;
    await cleanupVehicleExpiryNotificationsByLabels({
        assetMongoId: asset._id,
        labels: [label],
    });
}

/** Remove pending vehicle expiry reminders that no longer match a live due card. */
export async function deleteStaleVehicleExpiryNotifications(asset) {
    if (!asset?._id) return;
    const liveDue = collectLiveDueVehicleExpiryExtra1(asset);
    const pending = await DashboardAction.find({
        requestId: asset._id,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
    })
        .select('_id extra1')
        .lean();

    const staleIds = pending
        .filter((row) => !liveDue.has(String(row?.extra1 || '').trim()))
        .map((row) => row._id);

    if (staleIds.length) {
        await DashboardAction.deleteMany({ _id: { $in: staleIds } });
    }
}

/**
 * Create the follow-up task for each live card still inside the window, when that
 * exact reminder is not already pending. Does not send email.
 */
export async function ensureLiveDueVehicleExpiryNotifications(asset, hrUser = null) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return [];
    const notifyOk = await isNotificationEnabledForType(VEHICLE_EXPIRY_REQUEST_TYPE);
    if (!notifyOk) return [];

    const hr = hrUser || (await getDepartmentHOD('hr'));
    if (!hr?._id) return [];

    const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
    const created = [];
    for (const doc of collectVehicleExpiryDocuments(asset)) {
        const days = getDaysUntil(doc.expiryDate);
        if (!isExpiryHrTaskDueForDoc(days)) continue;
        const extra1 = buildVehicleExpiryFollowUpExtra1(doc);
        const already = await DashboardAction.findOne({
            requestId: asset._id,
            requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
            status: 'Pending',
            extra1,
        })
            .select('_id')
            .lean();
        if (already) continue;

        const extra3 = JSON.stringify({
            activationSubject: 'vehicle',
            vehicleMongoId: String(asset._id),
            vehicleDocType: doc.docType,
            focusCard: resolveVehicleExpiryFocusCard(doc.docType),
            vehicleTab: resolveVehicleExpiryTab(doc.docType),
        });
        const row = await DashboardAction.create({
            assignedTo: hr._id,
            ...(hr.employeeId ? { assignedToEmpId: hr.employeeId } : {}),
            requestId: asset._id,
            requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
            status: 'Pending',
            subjectEmployeeId: asset.assetId || '',
            subjectName: asset.name || 'Vehicle',
            requestedByName: 'System',
            extra1,
            extra2: vehicleLabel,
            extra3,
        });
        created.push(row.toObject());
    }
    return created;
}

/** After renew, edit, or not-renew: drop reminders for cards that are no longer due, then keep the ones that are. */
export async function reconcileVehicleExpiryNotifications(asset) {
    if (!asset?._id) return [];
    await deleteStaleVehicleExpiryNotifications(asset);
    return ensureLiveDueVehicleExpiryNotifications(asset);
}

/** Drop an expiry task after that document card was marked Not Renewed. */
export async function clearStaleVehicleWarrantyExpiryNotifications(asset) {
    if (!asset?._id || !isFleetVehicleAsset(asset)) return;

    const pending = await DashboardAction.find({
        requestId: asset._id,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
        extra1: { $regex: /^Expiry follow-up required:/i },
    })
        .select('_id extra1')
        .lean();

    const staleIds = pending
        .filter((row) => documentExpiryReminderIsClosed(asset, row?.extra1))
        .map((row) => row._id);

    if (staleIds.length) {
        await DashboardAction.deleteMany({ _id: { $in: staleIds } });
    }
}

/** Drop the expiry reminder for a document that was deleted, when no live card remains on that date. */
export async function clearVehicleExpiryNotificationsForRemovedDocuments(asset, removedDocs = []) {
    if (!asset?._id || !isFleetVehicleAsset(asset) || !removedDocs?.length) return;

    const pending = await DashboardAction.find({
        requestId: asset._id,
        requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
        status: 'Pending',
        extra1: { $regex: /^Expiry follow-up required:/i },
    })
        .select('_id extra1')
        .lean();

    const staleIds = pending
        .filter((row) => reminderMatchesRemovedDocument(asset, row?.extra1, removedDocs))
        .map((row) => row._id);

    if (staleIds.length) {
        await DashboardAction.deleteMany({ _id: { $in: staleIds } });
    }
}

async function restoreMissingLiveWarrantyExpiryReminders(existingRows = []) {
    const notifyOk = await isNotificationEnabledForType(VEHICLE_EXPIRY_REQUEST_TYPE);
    if (!notifyOk) return [];

    const hr = await getDepartmentHOD('hr');
    if (!hr?._id) return [];

    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 10);
    horizon.setHours(23, 59, 59, 999);

    const assets = await AssetItem.find({
        vehicleProfileActivationStatus: 'active',
        documents: {
            $elemMatch: {
                type: { $regex: /^warranty$/i },
                expiryDate: { $ne: null, $lte: horizon },
            },
        },
    })
        .select(
            'assetId name plateNumber vehicleBrand vehicleProfileActivationStatus vehicleDispositionStatus documents typeId',
        )
        .populate('typeId', 'name')
        .lean();

    const present = new Set(
        (existingRows || [])
            .filter((row) => row?.requestType === VEHICLE_EXPIRY_REQUEST_TYPE)
            .map((row) => `${String(row.requestId || '')}|${String(row.extra1 || '').trim()}`),
    );

    const created = [];
    for (const asset of assets) {
        if (!isFleetVehicleAsset(asset)) continue;
        const vehicleLabel = `${asset.name || 'Vehicle'} (${asset.assetId || asset._id})`;
        for (const doc of collectVehicleExpiryDocuments(asset)) {
            if (doc.docType !== 'warranty') continue;
            const days = getDaysUntil(doc.expiryDate);
            if (!isExpiryHrTaskDueForDoc(days)) continue;
            const extra1 = buildVehicleExpiryFollowUpExtra1({
                label: doc.label || VEHICLE_EXPIRY_DOC_LABELS.warranty,
                expiryDate: doc.expiryDate,
            });
            const key = `${String(asset._id)}|${extra1}`;
            if (present.has(key)) continue;

            const already = await DashboardAction.findOne({
                requestId: asset._id,
                requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
                status: 'Pending',
                extra1,
            })
                .select('_id requestId requestType status extra1 extra2 extra3 assignedTo requestedDate subjectName subjectEmployeeId requestedByName')
                .lean();
            if (already) {
                present.add(key);
                continue;
            }

            const extra3 = JSON.stringify({
                activationSubject: 'vehicle',
                vehicleMongoId: String(asset._id),
                vehicleDocType: doc.docType,
                focusCard: resolveVehicleExpiryFocusCard(doc.docType),
                vehicleTab: resolveVehicleExpiryTab(doc.docType),
            });
            const row = await DashboardAction.create({
                assignedTo: hr._id,
                ...(hr.employeeId ? { assignedToEmpId: hr.employeeId } : {}),
                requestId: asset._id,
                requestType: VEHICLE_EXPIRY_REQUEST_TYPE,
                status: 'Pending',
                subjectEmployeeId: asset.assetId || '',
                subjectName: asset.name || 'Vehicle',
                requestedByName: 'System',
                extra1,
                extra2: vehicleLabel,
                extra3,
            });
            present.add(key);
            created.push(row.toObject());
        }
    }
    return created;
}

/**
 * Drop vehicle expiry reminders whose card was renewed, edited, or not renewed
 * and is no longer inside the HR window. Legacy rows that only store the vehicle
 * name are removed too. A card that is still due keeps (or regains) its reminder.
 */
export async function dropStaleVehicleWarrantyExpiryInboxRows(rows = []) {
    const vehicleRows = (rows || []).filter(
        (row) => row?.requestType === VEHICLE_EXPIRY_REQUEST_TYPE,
    );

    const assetIds = [...new Set(vehicleRows.map((row) => String(row.requestId || '')).filter(Boolean))];
    const assets = assetIds.length
        ? await AssetItem.find({ _id: { $in: assetIds } })
              .select(
                  'assetId name plateNumber vehicleBrand vehicleProfileActivationStatus vehicleDispositionStatus documents typeId',
              )
              .populate('typeId', 'name')
              .lean()
        : [];
    const byId = new Map(assets.map((asset) => [String(asset._id), asset]));

    const staleIds = [];
    const assetsToEnsure = [];
    const seenAsset = new Set();
    for (const row of vehicleRows) {
        const asset = byId.get(String(row.requestId || ''));
        const liveDue = asset ? collectLiveDueVehicleExpiryExtra1(asset) : new Set();
        if (liveDue.has(String(row?.extra1 || '').trim())) continue;
        staleIds.push(row._id);
        const assetKey = asset ? String(asset._id) : '';
        if (asset && assetKey && !seenAsset.has(assetKey)) {
            seenAsset.add(assetKey);
            assetsToEnsure.push(asset);
        }
    }

    let kept = rows;
    if (staleIds.length) {
        await DashboardAction.deleteMany({ _id: { $in: staleIds } });
        const stale = new Set(staleIds.map((id) => String(id)));
        kept = rows.filter((row) => !stale.has(String(row?._id)));
    }

    if (assetsToEnsure.length) {
        try {
            const hr = await getDepartmentHOD('hr');
            const createdForViewer = [];
            for (const asset of assetsToEnsure) {
                const assigneeIds = new Set(
                    vehicleRows
                        .filter((row) => String(row.requestId || '') === String(asset._id))
                        .map((row) => String(row.assignedTo || '')),
                );
                const made = await ensureLiveDueVehicleExpiryNotifications(asset, hr);
                for (const row of made) {
                    if (assigneeIds.has(String(row.assignedTo || ''))) createdForViewer.push(row);
                }
            }
            if (createdForViewer.length) kept = [...kept, ...createdForViewer];
        } catch (err) {
            console.error('[vehicle expiry] ensure live reminders:', err?.message || err);
        }
    }

    try {
        await restoreMissingLiveWarrantyExpiryReminders(kept);
    } catch (err) {
        console.error('[warranty expiry] restore live reminders:', err?.message || err);
    }
    return kept;
}

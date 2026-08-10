/**
 * Mark vehicle garage / oil / car-wash service remarks Paid when the linked
 * Zoho bill is settled via Payments Made (or live Zoho status = paid).
 */
import AssetItem from '../models/AssetItem.js';
import ZohoBill from '../models/ZohoBill.js';
import { fetchBillById } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { isZohoBillFullyPaid } from './markUtilityVendorBillsPaidFromZoho.js';

const clean = (value, fallback = '') => {
    const text = String(value ?? '').trim();
    return text || fallback;
};

/** Skip live Zoho GETs for bills that 404'd across all orgs (avoids stalling detail reloads). */
const MISSING_ZOHO_BILL_TTL_MS = 15 * 60 * 1000;
const missingZohoBillUntil = new Map();

function isMissingZohoBillCached(zohoBillId) {
    const id = clean(zohoBillId);
    if (!id) return false;
    const until = missingZohoBillUntil.get(id);
    if (!until) return false;
    if (Date.now() > until) {
        missingZohoBillUntil.delete(id);
        return false;
    }
    return true;
}

function markZohoBillMissing(zohoBillId) {
    const id = clean(zohoBillId);
    if (!id) return;
    missingZohoBillUntil.set(id, Date.now() + MISSING_ZOHO_BILL_TTL_MS);
    if (missingZohoBillUntil.size > 500) {
        const oldest = missingZohoBillUntil.keys().next().value;
        missingZohoBillUntil.delete(oldest);
    }
}

function parseRemark(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return { ...raw };
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function serializeRemark(obj) {
    try {
        return JSON.stringify(obj || {});
    } catch {
        return '{}';
    }
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All Zoho bill ids linked on a vehicle service remark (top-level + zohoBills[]). */
export function collectServiceRemarkZohoBillIds(remark = {}) {
    const ids = new Set();
    const push = (value) => {
        const id = clean(value);
        if (id) ids.add(id);
    };
    push(remark?.zohoBillId);
    for (const row of Array.isArray(remark?.zohoBills) ? remark.zohoBills : []) {
        push(row?.zohoBillId || row?.bill_id || row?.billId);
    }
    return [...ids];
}

function remarkLinksZohoBillId(remark, zohoBillId) {
    const target = clean(zohoBillId);
    if (!target) return false;
    return collectServiceRemarkZohoBillIds(remark).includes(target);
}

function stampZohoBillRowPaid(row, zohoBillStatus = 'paid') {
    return {
        ...row,
        zohoBillStatus: zohoBillStatus || 'paid',
        status: zohoBillStatus || 'paid',
    };
}

function stampServicePaid(remark, { zohoPaymentId = '', zohoBillStatus = 'paid', zohoBillId = '' } = {}) {
    const next = { ...remark };
    next.zohoPaymentStatus = 'paid';
    next.zohoBillStatus = zohoBillStatus || 'paid';
    next.zohoPaidAt = new Date().toISOString();
    if (zohoPaymentId) next.zohoPaymentId = zohoPaymentId;
    if (String(next.carWashPaymentStatus || '').trim()) {
        next.carWashPaymentStatus = 'paid';
    }
    if (String(next.billingStatus || '').trim()) {
        // Keep billed; payment settlement is zohoPaymentStatus / zohoBillStatus.
        if (String(next.billingStatus).toLowerCase() !== 'paid') {
            next.billingStatus = 'billed';
        }
    }
    const target = clean(zohoBillId);
    if (Array.isArray(next.zohoBills) && next.zohoBills.length) {
        next.zohoBills = next.zohoBills.map((row) => {
            const rowId = clean(row?.zohoBillId || row?.bill_id || row?.billId);
            if (target && rowId && rowId !== target) return row;
            if (!rowId) return row;
            return stampZohoBillRowPaid(row, zohoBillStatus || 'paid');
        });
    }
    return next;
}

function stampServiceUnpaid(remark) {
    const next = { ...remark };
    next.zohoPaymentStatus = 'unpaid';
    if (String(next.zohoBillStatus || '').toLowerCase() === 'paid') {
        next.zohoBillStatus = 'open';
    }
    if (String(next.carWashPaymentStatus || '').toLowerCase() === 'paid') {
        next.carWashPaymentStatus = 'billed';
    }
    delete next.zohoPaidAt;
    return next;
}

function collectZohoBillIds({ body = {}, payload = {}, zohoPayment = {} } = {}) {
    const ids = new Set();
    const push = (value) => {
        const id = clean(value);
        if (id) ids.add(id);
    };
    const billLists = [
        body.bills,
        payload.bills,
        zohoPayment.bills,
        body.applied_bills,
        body.appliedBills,
    ];
    for (const list of billLists) {
        for (const bill of Array.isArray(list) ? list : []) {
            push(bill?.bill_id || bill?.billId || bill?.zohoBillId);
        }
    }
    for (const id of [].concat(body.zohoBillIds || [], body.zohoBillId || [])) {
        push(id);
    }
    return [...ids];
}

/**
 * After Zoho vendor payment Save as Paid — flip matching vehicle services to Paid.
 */
export async function markVehicleGarageServicesPaidFromZohoPayment({
    body = {},
    payload = {},
    zohoPayment = {},
} = {}) {
    const zohoBillIds = collectZohoBillIds({ body, payload, zohoPayment });
    if (!zohoBillIds.length) return { updatedCount: 0 };

    const zohoPaymentId = clean(
        zohoPayment.payment_id || zohoPayment.vendorpayment_id || zohoPayment.id,
    );

    let updatedCount = 0;
    for (const zohoBillId of zohoBillIds) {
        const assets = await AssetItem.find({
            'services.remark': { $regex: escapeRegex(zohoBillId) },
        }).select('services');
        for (const asset of assets) {
            let dirty = false;
            for (const svc of asset.services || []) {
                const remark = parseRemark(svc.remark);
                if (!remarkLinksZohoBillId(remark, zohoBillId)) continue;

                const billIds = collectServiceRemarkZohoBillIds(remark);
                const multi = Array.isArray(remark.zohoBills) ? remark.zohoBills : [];
                let nextRemark = stampServicePaid(remark, {
                    zohoPaymentId,
                    zohoBillStatus: 'paid',
                    zohoBillId,
                });

                // Multi-bill: only mark whole service Paid when every linked bill is paid.
                if (multi.length > 1 || billIds.length > 1) {
                    const paidIds = new Set(
                        (Array.isArray(nextRemark.zohoBills) ? nextRemark.zohoBills : [])
                            .filter((row) => {
                                const st = clean(row?.zohoBillStatus || row?.status).toLowerCase();
                                return st === 'paid';
                            })
                            .map((row) => clean(row?.zohoBillId || row?.bill_id || row?.billId))
                            .filter(Boolean),
                    );
                    // Also count this payment's bill.
                    paidIds.add(zohoBillId);
                    const allPaid = billIds.every((id) => paidIds.has(id));
                    if (!allPaid) {
                        nextRemark.zohoPaymentStatus = 'unpaid';
                        nextRemark.zohoBillStatus = 'open';
                        delete nextRemark.zohoPaidAt;
                    }
                }

                if (
                    String(remark.zohoPaymentStatus || '').toLowerCase() ===
                        String(nextRemark.zohoPaymentStatus || '').toLowerCase() &&
                    String(remark.zohoBillStatus || '').toLowerCase() ===
                        String(nextRemark.zohoBillStatus || '').toLowerCase() &&
                    JSON.stringify(remark.zohoBills || []) === JSON.stringify(nextRemark.zohoBills || [])
                ) {
                    continue;
                }

                svc.remark = serializeRemark(nextRemark);
                dirty = true;
                updatedCount += 1;
            }
            if (dirty) await asset.save();
        }
    }

    if (updatedCount) {
        console.log(
            `[markVehicleGarageServicesPaidFromZoho] Marked ${updatedCount} service(s) from Zoho bill payment` +
                (zohoPaymentId ? ` (payment ${zohoPaymentId})` : ''),
        );
    }
    return { updatedCount };
}

/**
 * When Zoho bills sync (or a single bill is upserted as paid), flip matching services.
 */
export async function markVehicleGarageServicesPaidFromZohoBillIds(zohoBillIds = [], extras = {}) {
    const ids = [...new Set((Array.isArray(zohoBillIds) ? zohoBillIds : []).map(clean).filter(Boolean))];
    if (!ids.length) return { updatedCount: 0 };
    return markVehicleGarageServicesPaidFromZohoPayment({
        body: { zohoBillIds: ids },
        payload: {},
        zohoPayment: extras.zohoPayment || {},
    });
}

/**
 * On vehicle detail load: sync Paid / Not Paid from Zoho for services that have zohoBillId(s).
 * @param {object} assetDoc
 * @param {{ fetchLive?: boolean | 'unpaidOnly' }} [options]
 *   - true: live-fetch every linked bill (can starve Zoho if used on every page load)
 *   - false: use ZohoBill cache only
 *   - 'unpaidOnly': live-fetch only when service is not already Paid (heals Zoho-paid / ERP-stale)
 */
export async function syncVehicleServicePaymentStatusFromZoho(assetDoc, { fetchLive = true } = {}) {
    if (!assetDoc?.services?.length) return { updatedCount: 0, checked: 0 };

    const orgFallbacks = [
        ...new Set(
            [
                process.env.ZOHO_ORGANIZATION_ID,
                process.env.ZOHO_ORGANIZATION_ID_NNIT,
                process.env.ZOHO_ORGANIZATION_ID_VEGA,
            ]
                .map((id) => clean(id))
                .filter(Boolean),
        ),
    ];

    async function fetchZohoBillLive(zohoId, preferredOrgId) {
        if (isMissingZohoBillCached(zohoId)) return null;
        const orgTries = [...new Set([clean(preferredOrgId), ...orgFallbacks].filter(Boolean))];
        const attempts = orgTries.length ? orgTries : [''];
        for (const orgId of attempts) {
            try {
                const live = await withZohoOrganization(orgId || null, () => fetchBillById(zohoId));
                if (live) return live;
            } catch {
                /* try next org */
            }
        }
        markZohoBillMissing(zohoId);
        return null;
    }

    let updatedCount = 0;
    let checked = 0;
    let dirty = false;

    for (const svc of assetDoc.services || []) {
        const remark = parseRemark(svc.remark);
        const billIds = collectServiceRemarkZohoBillIds(remark);
        if (!billIds.length) continue;
        if (String(remark.amountMode || '').toLowerCase() === 'warranty') continue;
        checked += 1;

        const currentlyPaid = String(remark.zohoPaymentStatus || '').toLowerCase() === 'paid';
        const shouldFetchLive =
            fetchLive === true || (fetchLive === 'unpaidOnly' && !currentlyPaid);

        const paidByBillId = {};
        const statusByBillId = {};

        for (const zohoBillId of billIds) {
            let zohoBill = null;
            const cached = await ZohoBill.findOne({ zohoBillId })
                .select('status balance total zohoBillId organizationId')
                .lean();

            if (shouldFetchLive) {
                try {
                    const live = await fetchZohoBillLive(
                        zohoBillId,
                        remark.zohoOrganizationId || cached?.organizationId,
                    );
                    if (live) {
                        zohoBill = live;
                        try {
                            await upsertZohoBillFromApi(live);
                        } catch {
                            /* optional */
                        }
                    }
                } catch {
                    /* fall through to cache */
                }
            }
            if (!zohoBill && cached) zohoBill = cached;
            if (!zohoBill) {
                paidByBillId[zohoBillId] = false;
                continue;
            }
            const paid = isZohoBillFullyPaid(zohoBill);
            paidByBillId[zohoBillId] = paid;
            statusByBillId[zohoBillId] = clean(zohoBill.status || (paid ? 'paid' : 'open')).toLowerCase();
        }

        const known = billIds.filter((id) => paidByBillId[id] != null);
        if (!known.length) continue;

        const allPaid = known.length === billIds.length && known.every((id) => paidByBillId[id]);
        const anyPaid = known.some((id) => paidByBillId[id]);

        let nextRemark = { ...remark };
        if (Array.isArray(nextRemark.zohoBills) && nextRemark.zohoBills.length) {
            nextRemark.zohoBills = nextRemark.zohoBills.map((row) => {
                const rowId = clean(row?.zohoBillId || row?.bill_id || row?.billId);
                if (!rowId || statusByBillId[rowId] == null) return row;
                return {
                    ...row,
                    zohoBillStatus: statusByBillId[rowId],
                    status: statusByBillId[rowId],
                };
            });
        }

        if (allPaid && !currentlyPaid) {
            nextRemark = stampServicePaid(nextRemark, {
                zohoBillStatus: statusByBillId[billIds[0]] || 'paid',
            });
            svc.remark = serializeRemark(nextRemark);
            dirty = true;
            updatedCount += 1;
        } else if (!allPaid && currentlyPaid) {
            nextRemark = stampServiceUnpaid(nextRemark);
            svc.remark = serializeRemark(nextRemark);
            dirty = true;
            updatedCount += 1;
        } else if (allPaid && currentlyPaid) {
            const liveStatus = statusByBillId[billIds[0]] || 'paid';
            if (liveStatus && liveStatus !== String(remark.zohoBillStatus || '').toLowerCase()) {
                nextRemark.zohoBillStatus = liveStatus;
                svc.remark = serializeRemark(nextRemark);
                dirty = true;
                updatedCount += 1;
            } else if (
                JSON.stringify(remark.zohoBills || []) !== JSON.stringify(nextRemark.zohoBills || [])
            ) {
                svc.remark = serializeRemark(nextRemark);
                dirty = true;
                updatedCount += 1;
            }
        } else if (anyPaid || Object.keys(statusByBillId).length) {
            // Reflect open/partial bill statuses on remark without flipping Paid.
            const topStatus = statusByBillId[billIds[0]];
            if (
                topStatus &&
                topStatus !== String(remark.zohoBillStatus || '').toLowerCase()
            ) {
                nextRemark.zohoBillStatus = topStatus;
            }
            if (
                JSON.stringify(remark.zohoBills || []) !== JSON.stringify(nextRemark.zohoBills || []) ||
                nextRemark.zohoBillStatus !== remark.zohoBillStatus
            ) {
                svc.remark = serializeRemark(nextRemark);
                dirty = true;
                updatedCount += 1;
            }
        }
    }

    if (dirty && typeof assetDoc.save === 'function') {
        await assetDoc.save();
    }

    return { updatedCount, checked };
}

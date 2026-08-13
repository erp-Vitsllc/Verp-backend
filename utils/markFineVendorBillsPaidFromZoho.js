import Fine from '../models/Fine.js';
import ZohoBill from '../models/ZohoBill.js';
import { isZohoBillFullyPaid } from './markUtilityVendorBillsPaidFromZoho.js';
import { finalizeFineVendorPayment } from './finalizeFineVendorPayment.js';
import { fetchBillById } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

const missingZohoBillCache = new Map();
const MISSING_TTL_MS = 5 * 60 * 1000;

function isMissingZohoBillCached(zohoBillId) {
    const id = clean(zohoBillId);
    if (!id) return true;
    const until = missingZohoBillCache.get(id);
    if (!until) return false;
    if (Date.now() > until) {
        missingZohoBillCache.delete(id);
        return false;
    }
    return true;
}

function markZohoBillMissing(zohoBillId) {
    const id = clean(zohoBillId);
    if (!id) return;
    missingZohoBillCache.set(id, Date.now() + MISSING_TTL_MS);
}

function orgFallbackIds(preferredOrgId = '') {
    return [
        ...new Set(
            [
                clean(preferredOrgId),
                process.env.ZOHO_ORGANIZATION_ID,
                process.env.ZOHO_ORGANIZATION_ID_NNIT,
                process.env.ZOHO_ORGANIZATION_ID_VEGA,
            ]
                .map((id) => clean(id))
                .filter(Boolean),
        ),
    ];
}

async function fetchZohoBillLive(zohoBillId, preferredOrgId = '') {
    if (isMissingZohoBillCached(zohoBillId)) return null;
    const attempts = orgFallbackIds(preferredOrgId);
    const orgTries = attempts.length ? attempts : [''];
    for (const orgId of orgTries) {
        try {
            const live = await withZohoOrganization(orgId || null, () => fetchBillById(zohoBillId));
            if (live) return live;
        } catch {
            /* try next org */
        }
    }
    markZohoBillMissing(zohoBillId);
    return null;
}

function collectZohoBillIds({ body = {}, payload = {}, zohoPayment = {} } = {}) {
    const ids = new Set();
    const push = (v) => {
        const id = clean(v);
        if (id) ids.add(id);
    };

    for (const bill of [].concat(body.bills || [], payload.bills || [], zohoPayment.bills || [])) {
        push(bill?.bill_id || bill?.billId || bill?.zohoBillId);
    }
    for (const id of [].concat(body.zohoBillIds || [], body.zohoBillId || [], payload.zohoBillIds || [])) {
        push(id);
    }
    return [...ids];
}

async function resolveZohoBillPaid(zohoBillId, preferredOrgId, { fetchLive = false } = {}) {
    const id = clean(zohoBillId);
    if (!id) return { paid: null, zohoBill: null };

    let zohoBill = await ZohoBill.findOne({ zohoBillId: id })
        .select('status balance total zohoBillId organizationId')
        .lean();

    const cachePaid = isZohoBillFullyPaid(zohoBill);
    const shouldFetchLive =
        fetchLive === true || (fetchLive === 'unpaidOnly' && !cachePaid);

    if (shouldFetchLive) {
        try {
            const live = await fetchZohoBillLive(
                id,
                preferredOrgId || zohoBill?.organizationId,
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
            /* keep cache */
        }
    }

    if (!zohoBill) return { paid: null, zohoBill: null };
    return { paid: isZohoBillFullyPaid(zohoBill), zohoBill };
}

async function stampFineVendorBillPaid(fineId, extras = {}) {
    await finalizeFineVendorPayment({
        fineMongoId: String(fineId),
        zohoPayment: {
            payment_id: clean(extras.zohoVendorPaymentId),
            payment_number: clean(extras.zohoVendorPaymentNumber),
            amount: extras.fineAmount,
            organization_id: clean(extras.zohoOrganizationId),
        },
        userId: extras.userId || null,
    });
}

async function stampFineVendorBillNotPaid(fineId) {
    await Fine.updateOne(
        { _id: fineId },
        {
            $set: {
                vendorBillStatus: 'Pending',
                vendorBillPaidAt: null,
            },
        },
    );
}

/**
 * After Zoho Payments Made settles bill(s): mark matching Fine vendorBillStatus = Paid.
 */
export async function markFineVendorBillsPaidFromZohoPayment({
    body = {},
    payload = {},
    zohoPayment = {},
    userId = null,
} = {}) {
    const zohoBillIds = collectZohoBillIds({ body, payload, zohoPayment });
    if (!zohoBillIds.length) return { updatedCount: 0 };

    const fines = await Fine.find({
        zohoBillId: { $in: zohoBillIds },
        vendorBillStatus: { $ne: 'Paid' },
    }).select('_id');

    let updatedCount = 0;
    for (const row of fines) {
        try {
            await finalizeFineVendorPayment({
                fineMongoId: String(row._id),
                zohoPayment,
                paidThroughAccountId:
                    payload.paid_through_account_id ||
                    body.paid_through_account_id ||
                    body.paidThroughAccountId ||
                    '',
                paidThroughAccountName:
                    body.paid_through_account_name ||
                    body.paidThroughAccountName ||
                    '',
                paymentMode: payload.payment_mode || body.payment_mode || '',
                userId,
            });
            updatedCount += 1;
        } catch (err) {
            console.warn(
                '[markFineVendorBillsPaidFromZohoPayment]',
                String(row._id),
                err?.message || err,
            );
        }
    }
    return { updatedCount };
}

/**
 * Sync one Fine Paid to Vendor from Zoho bill (Paid / Not Paid).
 * @param {object} fineDoc lean or mongoose doc
 * @param {{ fetchLive?: boolean | 'unpaidOnly' }} [options]
 */
export async function syncFineVendorBillStatusFromZoho(fineDoc, { fetchLive = false } = {}) {
    if (!fineDoc?._id) return { updated: false, paid: null };
    const zohoBillId = clean(fineDoc.zohoBillId);
    if (!zohoBillId) return { updated: false, paid: null };

    const currentlyPaid = String(fineDoc.vendorBillStatus || '').toLowerCase() === 'paid';
    const { paid } = await resolveZohoBillPaid(zohoBillId, fineDoc.zohoOrganizationId, {
        fetchLive,
    });

    // Unknown (no cache / live miss) — leave as-is.
    if (paid == null) return { updated: false, paid: null };

    if (paid && !currentlyPaid) {
        await stampFineVendorBillPaid(fineDoc._id, {
            zohoVendorPaymentId: fineDoc.zohoVendorPaymentId,
            zohoVendorPaymentNumber: fineDoc.zohoVendorPaymentNumber,
            fineAmount: fineDoc.fineAmount,
            zohoOrganizationId: fineDoc.zohoOrganizationId,
        });
        fineDoc.vendorBillStatus = 'Paid';
        fineDoc.vendorBillPaidAt = new Date();
        return { updated: true, paid: true };
    }

    if (!paid && currentlyPaid) {
        await stampFineVendorBillNotPaid(fineDoc._id);
        fineDoc.vendorBillStatus = 'Pending';
        fineDoc.vendorBillPaidAt = null;
        return { updated: true, paid: false };
    }

    // Already correct — still expose paid flag for UI.
    return { updated: false, paid };
}

/**
 * Batch sync Paid to Vendor for a fine list (refresh / getFines).
 * Uses ZohoBill cache; live-fetches unpaidOnly when requested.
 */
export async function syncFineListVendorBillStatusFromZoho(
    fines = [],
    { fetchLive = 'unpaidOnly' } = {},
) {
    const list = Array.isArray(fines) ? fines : [];
    const withBill = list.filter((f) => clean(f?.zohoBillId) && f?._id);
    if (!withBill.length) return { updatedCount: 0, checked: 0 };

    let updatedCount = 0;
    let checked = 0;

    // Group by bill id to avoid duplicate Zoho fetches.
    const byBillId = new Map();
    for (const fine of withBill) {
        const billId = clean(fine.zohoBillId);
        if (!byBillId.has(billId)) byBillId.set(billId, []);
        byBillId.get(billId).push(fine);
    }

    for (const [zohoBillId, group] of byBillId.entries()) {
        checked += group.length;
        const anyUnpaid = group.some(
            (f) => String(f.vendorBillStatus || '').toLowerCase() !== 'paid',
        );
        const liveMode =
            fetchLive === true
                ? true
                : fetchLive === 'unpaidOnly'
                  ? anyUnpaid
                      ? 'unpaidOnly'
                      : false
                  : false;

        const preferredOrg = group.find((f) => clean(f.zohoOrganizationId))?.zohoOrganizationId;
        const { paid } = await resolveZohoBillPaid(zohoBillId, preferredOrg, {
            fetchLive: liveMode,
        });
        if (paid == null) continue;

        for (const fine of group) {
            const currentlyPaid = String(fine.vendorBillStatus || '').toLowerCase() === 'paid';
            if (paid && !currentlyPaid) {
                try {
                    // List path: stamp status only (fast). Party expenses finalize on detail/payment.
                    const now = new Date();
                    await Fine.updateOne(
                        { _id: fine._id, vendorBillStatus: { $ne: 'Paid' } },
                        { $set: { vendorBillStatus: 'Paid', vendorBillPaidAt: now } },
                    );
                    fine.vendorBillStatus = 'Paid';
                    fine.vendorBillPaidAt = now;
                    updatedCount += 1;
                } catch (err) {
                    console.warn(
                        '[syncFineListVendorBillStatusFromZoho] mark Paid failed:',
                        String(fine._id),
                        err?.message || err,
                    );
                }
            } else if (!paid && currentlyPaid) {
                try {
                    await stampFineVendorBillNotPaid(fine._id);
                    fine.vendorBillStatus = 'Pending';
                    fine.vendorBillPaidAt = null;
                    updatedCount += 1;
                } catch (err) {
                    console.warn(
                        '[syncFineListVendorBillStatusFromZoho] mark Not Paid failed:',
                        String(fine._id),
                        err?.message || err,
                    );
                }
            }
        }
    }

    return { updatedCount, checked };
}

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

function stampServicePaid(remark, { zohoPaymentId = '', zohoBillStatus = 'paid' } = {}) {
    const next = { ...remark };
    next.zohoPaymentStatus = 'paid';
    next.zohoBillStatus = zohoBillStatus || 'paid';
    next.zohoPaidAt = new Date().toISOString();
    if (zohoPaymentId) next.zohoPaymentId = zohoPaymentId;
    // Keep billingStatus as billed (bill created); payment settlement is zohoPaymentStatus.
    if (String(next.carWashPaymentStatus || '').trim()) {
        next.carWashPaymentStatus = 'paid';
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
                if (clean(remark.zohoBillId) !== zohoBillId) continue;
                if (String(remark.zohoPaymentStatus || '').toLowerCase() === 'paid') continue;
                svc.remark = serializeRemark(
                    stampServicePaid(remark, { zohoPaymentId, zohoBillStatus: 'paid' }),
                );
                dirty = true;
                updatedCount += 1;
            }
            if (dirty) await asset.save();
        }
    }

    if (updatedCount) {
        console.log(
            `[markVehicleGarageServicesPaidFromZoho] Marked ${updatedCount} service(s) Paid` +
                (zohoPaymentId ? ` (payment ${zohoPaymentId})` : ''),
        );
    }
    return { updatedCount };
}

/**
 * On vehicle detail load: sync Paid / Not Paid from Zoho for services that have zohoBillId.
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
        return null;
    }

    let updatedCount = 0;
    let checked = 0;
    let dirty = false;

    for (const svc of assetDoc.services || []) {
        const remark = parseRemark(svc.remark);
        const zohoBillId = clean(remark.zohoBillId);
        if (!zohoBillId) continue;
        if (String(remark.amountMode || '').toLowerCase() === 'warranty') continue;
        checked += 1;

        let zohoBill = null;
        const cached = await ZohoBill.findOne({ zohoBillId })
            .select('status balance total zohoBillId organizationId')
            .lean();

        if (fetchLive) {
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
        if (!zohoBill) continue;

        const paid = isZohoBillFullyPaid(zohoBill);
        const currentlyPaid = String(remark.zohoPaymentStatus || '').toLowerCase() === 'paid';

        if (paid && !currentlyPaid) {
            svc.remark = serializeRemark(
                stampServicePaid(remark, {
                    zohoBillStatus: clean(zohoBill.status || 'paid') || 'paid',
                }),
            );
            dirty = true;
            updatedCount += 1;
        } else if (!paid && currentlyPaid) {
            svc.remark = serializeRemark(stampServiceUnpaid(remark));
            dirty = true;
            updatedCount += 1;
        } else if (paid && currentlyPaid) {
            const liveStatus = clean(zohoBill.status).toLowerCase();
            if (liveStatus && liveStatus !== String(remark.zohoBillStatus || '').toLowerCase()) {
                remark.zohoBillStatus = liveStatus;
                svc.remark = serializeRemark(remark);
                dirty = true;
            }
        }
    }

    if (dirty && typeof assetDoc.save === 'function') {
        await assetDoc.save();
    }

    return { updatedCount, checked };
}

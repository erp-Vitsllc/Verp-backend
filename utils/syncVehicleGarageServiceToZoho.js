import {
    createBill,
    fetchBillById,
    getZohoOrganizationId,
    markBillAsOpen,
    uploadBillAttachment,
} from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoVendorIdByProvider } from './syncUtilityBillToZoho.js';
import { downloadS3ObjectBytes } from './s3Upload.js';

function parseRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : 0;
}

function resolveAmount(service, remark) {
    return (
        money(remark.garageBillAmount) ||
        money(remark.hrReviewCompanyPay) ||
        money(remark.hrReviewApprovedAmount) ||
        money(service?.value) ||
        money(remark.approvedAmount) ||
        0
    );
}

function guessMimeFromName(name) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.pdf')) return 'application/pdf';
    return 'application/pdf';
}

function sanitizeZohoBillNumber(value) {
    return String(value || '')
        .trim()
        .replace(/[^\w-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 45);
}

function garageBillPrefix(serviceTypeLabel = '') {
    const label = String(serviceTypeLabel || '').trim().toLowerCase();
    if (label.includes('tire')) return 'TIRE';
    if (label.includes('mechanical') || label.includes('mech')) return 'MECH';
    if (label.includes('body')) return 'BODY';
    if (label.includes('accident')) return 'ACCD';
    if (label.includes('oil')) return 'OIL';
    if (label.includes('wash') || label.includes('car wash')) return 'WASH';
    return 'VHCL';
}

/**
 * VEGA org uses manual bill numbers (same as Fine / Utility).
 * Omitting bill_number → Zoho: "Invalid value passed for bill_number".
 */
function buildGarageZohoBillNumber({ asset, service, serviceTypeLabel = '' } = {}) {
    const prefix = garageBillPrefix(serviceTypeLabel || service?.serviceType);
    const assetId = sanitizeZohoBillNumber(asset?.assetId || '');
    const serviceKey = String(service?._id || '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(-8)
        .toUpperCase();
    const stamp = Date.now().toString(36).toUpperCase().slice(-4);

    const candidates = [
        assetId && serviceKey ? `${prefix}-${assetId}-${serviceKey}` : '',
        assetId ? `${prefix}-${assetId}-${stamp}` : '',
        serviceKey ? `${prefix}-${serviceKey}-${stamp}` : '',
        `${prefix}-${stamp}${String(Date.now()).slice(-6)}`,
    ];

    for (const raw of candidates) {
        const num = sanitizeZohoBillNumber(raw);
        if (num) return num;
    }
    return sanitizeZohoBillNumber(`VHCL-${Date.now()}`) || `VHCL${Date.now()}`;
}

async function buildAttachmentFromService(service, remark) {
    // Prefer dedicated garage bill attachment — never overwrite Quote 1 (service.attachment).
    const key = String(
        remark.garageAttachmentUrl || remark.garageBillAttachmentUrl || '',
    ).trim();
    if (!key) return null;
    const name =
        String(remark.garageAttachmentName || '').trim() ||
        key.split('/').pop() ||
        'garage-attachment.pdf';
    try {
        if (key.startsWith('http://') || key.startsWith('https://')) {
            const res = await fetch(key);
            if (!res.ok) return null;
            const buffer = Buffer.from(await res.arrayBuffer());
            return {
                buffer,
                filename: name,
                mimeType: guessMimeFromName(name),
            };
        }
        const buffer = await downloadS3ObjectBytes(key);
        if (!buffer?.length) return null;
        return {
            buffer,
            filename: name,
            mimeType: guessMimeFromName(name),
        };
    } catch (err) {
        console.warn('[GarageZoho] attachment download failed:', err?.message || err);
        return null;
    }
}

/**
 * After Accounts approves garage details — create Zoho Bill:
 * Vendor = Garage Name, Account = Pay Account, Amount from service, optional attachment.
 */
export async function syncVehicleGarageServiceToZoho({
    asset,
    service,
    serviceTypeLabel = '',
    organizationId = '',
} = {}) {
    if (!service) {
        return { ok: false, message: 'Service record is required.' };
    }

    const remark = parseRemark(service);
    if (String(remark.zohoBillId || '').trim()) {
        return {
            ok: true,
            skipped: true,
            billId: String(remark.zohoBillId).trim(),
            message: 'Zoho bill already linked for this garage service.',
        };
    }

    const garageName = String(remark.garageName || remark.vendorName || '').trim();
    const payAccountId = String(
        remark.payAccountId || remark.garagePayAccountId || '',
    ).trim();
    const amount = resolveAmount(service, remark);

    if (!garageName) {
        return { ok: false, message: 'Garage name (vendor) is required for Zoho bill.' };
    }
    if (!payAccountId) {
        return { ok: false, message: 'Pay Account is required for Zoho bill.' };
    }
    if (!(amount > 0)) {
        return { ok: false, message: 'Bill amount must be greater than 0.' };
    }

    const orgId = String(organizationId || '').trim() || getZohoOrganizationId();
    const label = String(serviceTypeLabel || service.serviceType || 'Vehicle Service').trim();
    const plate = [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
    const assetId = String(asset?.assetId || asset?._id || '').trim();
    const today = new Date().toISOString().slice(0, 10);

    try {
        const result = await withZohoOrganization(orgId, async () => {
            let vendorId = String(remark.zohoVendorId || '').trim();
            if (!vendorId) {
                vendorId = await resolveZohoVendorIdByProvider(garageName, orgId);
            }
            if (!vendorId) {
                throw new Error(
                    `Zoho vendor not found for garage "${garageName}". Add/sync the vendor in Zoho Books.`,
                );
            }

            const description = [
                label,
                assetId,
                plate ? `(${plate})` : '',
                garageName,
            ]
                .filter(Boolean)
                .join(' · ')
                .slice(0, 200);

            const billNumber = buildGarageZohoBillNumber({
                asset,
                service,
                serviceTypeLabel: label,
            });
            const referenceNumber =
                sanitizeZohoBillNumber(assetId) ||
                String(service._id || '')
                    .replace(/[^a-zA-Z0-9-]/g, '')
                    .slice(-20) ||
                undefined;

            const billPayload = {
                vendor_id: vendorId,
                bill_number: billNumber,
                date: today,
                due_date: today,
                notes: description,
                line_items: [
                    {
                        account_id: payAccountId,
                        description: description || label,
                        quantity: 1,
                        rate: amount,
                    },
                ],
            };
            if (referenceNumber) billPayload.reference_number = referenceNumber;

            let bill;
            try {
                bill = await createBill(billPayload);
            } catch (createErr) {
                const msg = String(createErr?.message || createErr || '');
                // Duplicate / series clash — retry once with a unique suffix.
                if (/bill_number|already|exist|duplicate|unique/i.test(msg)) {
                    const retryNumber = sanitizeZohoBillNumber(
                        `${billNumber}-${Date.now().toString(36).toUpperCase().slice(-5)}`,
                    );
                    bill = await createBill({
                        ...billPayload,
                        bill_number: retryNumber || `${billNumber}-${Date.now()}`.slice(0, 45),
                    });
                } else {
                    throw createErr;
                }
            }

            const billId = String(
                bill?.bill_id || bill?.billId || bill?.id || '',
            ).trim();
            if (!billId) {
                throw new Error('Zoho bill created but bill id was missing in response.');
            }

            try {
                await markBillAsOpen(billId);
            } catch (openErr) {
                console.warn(
                    '[GarageZoho] markBillAsOpen failed:',
                    openErr?.message || openErr,
                );
            }

            const file = await buildAttachmentFromService(service, remark);
            if (file) {
                try {
                    await uploadBillAttachment(billId, file);
                } catch (attErr) {
                    console.warn(
                        '[GarageZoho] attachment upload failed:',
                        attErr?.message || attErr,
                    );
                }
            }

            let billForUpsert = bill;
            try {
                billForUpsert = (await fetchBillById(billId)) || bill;
            } catch {
                /* use create response */
            }
            try {
                await upsertZohoBillFromApi(billForUpsert);
            } catch (upsertErr) {
                console.warn(
                    '[GarageZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                    upsertErr?.message || upsertErr,
                );
            }

            return {
                billId,
                vendorId,
                billNumber: String(
                    billForUpsert?.bill_number ||
                        billForUpsert?.billNumber ||
                        bill?.bill_number ||
                        bill?.billNumber ||
                        '',
                ).trim(),
            };
        });

        remark.zohoBillId = result.billId;
        remark.zohoVendorId = result.vendorId;
        remark.zohoBillNumber = result.billNumber || '';
        remark.zohoBillStatus = 'open';
        remark.zohoOrganizationId = orgId;
        remark.zohoSyncedAt = new Date().toISOString();
        remark.zohoSyncError = '';
        service.remark = JSON.stringify(remark);

        return {
            ok: true,
            billId: result.billId,
            billNumber: result.billNumber,
            message: result.billNumber
                ? `Zoho bill ${result.billNumber} created.`
                : 'Zoho bill created.',
        };
    } catch (err) {
        const message = err?.message || 'Failed to create Zoho bill for garage service.';
        remark.zohoSyncError = message;
        remark.zohoSyncedAt = new Date().toISOString();
        service.remark = JSON.stringify(remark);
        console.error('[GarageZoho]', message);
        return { ok: false, message };
    }
}

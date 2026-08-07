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
    const company = money(remark.hrReviewCompanyPay ?? remark.companyPayAmount);
    const employee = money(remark.hrReviewEmployeePay ?? remark.employeePayAmount);
    const splitSum = company + employee;
    return (
        money(remark.billingTotalAmount) ||
        money(remark.garageBillAmount) ||
        money(remark.hrReviewApprovedAmount) ||
        money(remark.estimatedCost) ||
        money(remark.approvedAmount) ||
        money(remark.totalServiceCharge) ||
        money(service?.value) ||
        (splitSum > 0 ? splitSum : 0) ||
        company ||
        0
    );
}

/**
 * Multi payable-from rows (Accounts / Fine-style) → Zoho Bill Item Table lines.
 * Each row: description, Chart of Accounts, qty, amount (line total).
 * Falls back to a single payAccountId + amount when billingPayables is empty.
 */
export function resolveGarageZohoPayableLines(service, remark = {}) {
    const rows = Array.isArray(remark.billingPayables) ? remark.billingPayables : [];
    const fromRows = rows
        .map((row) => {
            const accountId = String(row?.payAccountId || row?.accountId || '').trim();
            const amount = money(row?.amount);
            const name = String(row?.payableTo || row?.payAccountName || '').trim();
            const description = String(row?.description || row?.item || '').trim();
            const qtyRaw = Number(row?.qty ?? row?.quantity);
            const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
            if (!accountId || !(amount > 0)) return null;
            return {
                accountId,
                amount,
                name,
                description: description || name || String(row?.partyName || '').trim(),
                quantity,
                // Zoho Item Table: rate × quantity = line amount
                rate: Number((amount / quantity).toFixed(6)),
            };
        })
        .filter(Boolean);

    if (fromRows.length) return fromRows;

    const fallbackId = String(remark.payAccountId || remark.garagePayAccountId || '').trim();
    const fallbackAmt = resolveAmount(service, remark);
    const fallbackName = String(
        remark.payAccountName || remark.garagePayAccountName || '',
    ).trim();
    if (fallbackId && fallbackAmt > 0) {
        return [
            {
                accountId: fallbackId,
                amount: fallbackAmt,
                name: fallbackName,
                description: '',
                quantity: 1,
                rate: fallbackAmt,
            },
        ];
    }
    return [];
}

export function remarkHasGaragePayAccount(remark = {}) {
    if (String(remark.payAccountId || remark.garagePayAccountId || '').trim()) return true;
    const rows = Array.isArray(remark.billingPayables) ? remark.billingPayables : [];
    return rows.some(
        (row) =>
            String(row?.payAccountId || row?.accountId || '').trim() &&
            money(row?.amount) > 0,
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
    // Fall back to Service Details garage invoice (shopInvoice) so Accounts Zoho bill gets it automatically.
    const key = String(
        remark.garageAttachmentUrl ||
            remark.garageBillAttachmentUrl ||
            service?.shopInvoice ||
            remark.garageInvoiceUrl ||
            '',
    ).trim();
    if (!key) return null;
    const name =
        String(
            remark.garageAttachmentName ||
                remark.garageInvoiceName ||
                remark.shopInvoiceName ||
                '',
        ).trim() ||
        key.split('/').pop() ||
        'garage-invoice.pdf';
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
    const payableLines = resolveGarageZohoPayableLines(service, remark);
    const amount = payableLines.reduce((sum, line) => sum + line.amount, 0) || resolveAmount(service, remark);

    if (!garageName) {
        return { ok: false, message: 'Garage name (vendor) is required for Zoho bill.' };
    }
    if (!payableLines.length) {
        return {
            ok: false,
            message:
                'Each payable-from line needs a Chart of Accounts and amount greater than zero for the Zoho bill.',
        };
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

            // One Zoho Item Table row per payable line: Description, Account, Qty, Amount (via rate×qty).
            const line_items = payableLines.map((line) => {
                const qty = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
                const rate =
                    Number(line.rate) > 0
                        ? Number(line.rate)
                        : Number((line.amount / qty).toFixed(6));
                const lineDescription =
                    String(line.description || '').trim() ||
                    [description, line.name].filter(Boolean).join(' · ').slice(0, 200) ||
                    label;
                return {
                    account_id: line.accountId,
                    name: line.name || lineDescription || label,
                    description: lineDescription.slice(0, 200),
                    quantity: qty,
                    rate,
                };
            });

            const billPayload = {
                vendor_id: vendorId,
                bill_number: billNumber,
                date: today,
                due_date: today,
                notes: description,
                line_items,
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

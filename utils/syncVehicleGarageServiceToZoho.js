import {
    createBillWithZohoSerial,
    fetchBillById,
    getZohoOrganizationId,
    markBillAsOpen,
    uploadBillAttachment,
} from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoVendorIdByProvider } from './syncUtilityBillToZoho.js';
import { resolveZohoBillSerialNumber } from './zohoPurchaseMappers.js';
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

function toZohoDateKey(value) {
    const raw = String(value || '').trim();
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    if (!raw) return '';
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return '';
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function resolveEnteredBillNumber(billSource = {}, remark = {}) {
    return String(billSource.billNumber || remark.billNumber || '').trim();
}

function resolveEnteredBillDate(billSource = {}, remark = {}) {
    return toZohoDateKey(billSource.billDate || remark.billDate);
}

async function buildAttachmentFromBillOrService(service, remark, bill = null) {
    const key = String(
        bill?.garageAttachmentUrl ||
            bill?.garageBillAttachmentUrl ||
            remark.garageAttachmentUrl ||
            remark.garageBillAttachmentUrl ||
            service?.shopInvoice ||
            remark.garageInvoiceUrl ||
            '',
    ).trim();
    if (!key) return null;
    const name =
        String(
            bill?.garageAttachmentName ||
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

async function buildAttachmentFromService(service, remark) {
    return buildAttachmentFromBillOrService(service, remark, null);
}

async function createOneGarageZohoBill({
    asset,
    service,
    remark,
    billRemark = null,
    serviceTypeLabel = '',
    orgId,
    billIndex = 0,
} = {}) {
    const billSource = billRemark && typeof billRemark === 'object' ? billRemark : remark;
    const garageName = String(billSource.garageName || billSource.vendorName || remark.garageName || remark.vendorName || '').trim();
    const payableLines = resolveGarageZohoPayableLines(service, {
        ...remark,
        billingPayables: billSource.billingPayables || remark.billingPayables,
        payAccountId: billSource.payAccountId || remark.payAccountId,
        payAccountName: billSource.payAccountName || remark.payAccountName,
        garagePayAccountId: billSource.payAccountId || remark.garagePayAccountId,
        garagePayAccountName: billSource.payAccountName || remark.garagePayAccountName,
        billingTotalAmount: billSource.billingTotalAmount || remark.billingTotalAmount,
        garageBillAmount: billSource.garageBillAmount || remark.garageBillAmount,
    });
    const amount =
        payableLines.reduce((sum, line) => sum + line.amount, 0) ||
        money(billSource.billingTotalAmount) ||
        money(billSource.garageBillAmount) ||
        resolveAmount(service, remark);

    if (!garageName) {
        throw new Error('Garage name (vendor) is required for Zoho bill.');
    }
    if (!payableLines.length) {
        throw new Error(
            'Each payable-from line needs a Chart of Accounts and amount greater than zero for the Zoho bill.',
        );
    }
    if (!(amount > 0)) {
        throw new Error('Bill amount must be greater than 0.');
    }

    const label = String(serviceTypeLabel || service.serviceType || 'Vehicle Service').trim();
    const plate = [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
    const assetId = String(asset?.assetId || asset?._id || '').trim();
    const enteredBillNumber = resolveEnteredBillNumber(billSource, remark);
    const enteredBillDate = resolveEnteredBillDate(billSource, remark);
    if (!enteredBillNumber) {
        throw new Error('Bill No is required before creating the Zoho bill.');
    }
    if (!enteredBillDate) {
        throw new Error('Date is required before creating the Zoho bill.');
    }

    let vendorId = String(billSource.zohoVendorId || remark.zohoVendorId || '').trim();
    if (!vendorId) {
        vendorId = await resolveZohoVendorIdByProvider(garageName, orgId);
    }
    if (!vendorId) {
        throw new Error(
            `Zoho vendor not found for garage "${garageName}". Add/sync the vendor in Zoho Books.`,
        );
    }

    const description = [label, assetId, plate ? `(${plate})` : '', garageName, billIndex > 0 ? `#${billIndex + 1}` : '']
        .filter(Boolean)
        .join(' · ')
        .slice(0, 200);

    const billNumber = enteredBillNumber;
    const billDate = enteredBillDate;
    const referenceNumber =
        sanitizeZohoBillNumber(billNumber) ||
        sanitizeZohoBillNumber(assetId) ||
        String(service._id || '')
            .replace(/[^a-zA-Z0-9-]/g, '')
            .slice(-20) ||
        undefined;

    const line_items = payableLines.map((line) => {
        const qty = Number(line.quantity) > 0 ? Number(line.quantity) : 1;
        const rate =
            Number(line.rate) > 0 ? Number(line.rate) : Number((line.amount / qty).toFixed(6));
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
        date: billDate,
        due_date: billDate,
        notes: description,
        line_items,
    };
    if (referenceNumber) billPayload.reference_number = referenceNumber;

    const bill = await createBillWithZohoSerial(billPayload);

    const billId = String(bill?.bill_id || bill?.billId || bill?.id || '').trim();
    if (!billId) {
        throw new Error('Zoho bill created but bill id was missing in response.');
    }

    try {
        await markBillAsOpen(billId);
    } catch (openErr) {
        console.warn('[GarageZoho] markBillAsOpen failed:', openErr?.message || openErr);
    }

    const file = await buildAttachmentFromBillOrService(service, remark, billSource);
    if (file) {
        try {
            await uploadBillAttachment(billId, file);
        } catch (attErr) {
            console.warn('[GarageZoho] attachment upload failed:', attErr?.message || attErr);
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
        billNumber: resolveZohoBillSerialNumber(billForUpsert || bill),
        enteredBillNumber: billNumber,
        billDate,
    };
}

/**
 * After Accounts approves garage details — create Zoho Bill(s):
 * Vendor = Garage Name, Account = Pay Account, Amount from service, optional attachment.
 * Accident Repair may send remark.zohoBills[] → one Zoho bill per entry.
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
    const multiBills = Array.isArray(remark.zohoBills) ? remark.zohoBills.filter(Boolean) : [];
    const useMulti = multiBills.length > 0;

    if (!useMulti && String(remark.zohoBillId || '').trim()) {
        return {
            ok: true,
            skipped: true,
            billId: String(remark.zohoBillId).trim(),
            message: 'Zoho bill already linked for this garage service.',
        };
    }

    if (useMulti && multiBills.every((b) => String(b?.zohoBillId || '').trim())) {
        return {
            ok: true,
            skipped: true,
            billId: String(multiBills[0].zohoBillId).trim(),
            billIds: multiBills.map((b) => String(b.zohoBillId).trim()),
            message: 'Zoho bills already linked for this garage service.',
        };
    }

    const orgId = String(organizationId || '').trim() || getZohoOrganizationId();
    const label = String(serviceTypeLabel || service.serviceType || 'Vehicle Service').trim();

    try {
        if (useMulti) {
            const results = [];
            const updatedBills = [...multiBills];
            let firstError = '';

            await withZohoOrganization(orgId, async () => {
                for (let i = 0; i < updatedBills.length; i += 1) {
                    const row = updatedBills[i] || {};
                    if (String(row.zohoBillId || '').trim()) {
                        results.push({
                            ok: true,
                            skipped: true,
                            billId: String(row.zohoBillId).trim(),
                            billNumber: String(row.zohoBillNumber || '').trim(),
                            index: i,
                        });
                        continue;
                    }
                    try {
                        const created = await createOneGarageZohoBill({
                            asset,
                            service,
                            remark,
                            billRemark: row,
                            serviceTypeLabel: label,
                            orgId,
                            billIndex: i,
                        });
                        updatedBills[i] = {
                            ...row,
                            billNumber: created.enteredBillNumber || row.billNumber || '',
                            billDate: created.billDate || row.billDate || '',
                            zohoBillId: created.billId,
                            zohoBillNumber: created.billNumber || '',
                            zohoVendorId: created.vendorId || row.zohoVendorId || '',
                            zohoSyncError: '',
                        };
                        results.push({ ok: true, ...created, index: i });
                    } catch (err) {
                        const message = err?.message || 'Failed to create Zoho bill.';
                        updatedBills[i] = {
                            ...row,
                            zohoSyncError: message,
                        };
                        if (!firstError) firstError = `Zoho Bill #${i + 1}: ${message}`;
                        results.push({ ok: false, message, index: i });
                        console.error('[GarageZoho] multi bill failed:', message);
                    }
                }
            });

            remark.zohoBills = updatedBills;
            const succeeded = results.filter((r) => r.ok);
            const failed = results.filter((r) => !r.ok);
            if (succeeded.length) {
                remark.zohoBillId = succeeded[0].billId || remark.zohoBillId || '';
                remark.zohoBillNumber = succeeded[0].billNumber || remark.zohoBillNumber || '';
                remark.zohoVendorId = succeeded[0].vendorId || remark.zohoVendorId || '';
                remark.billNumber =
                    succeeded[0].enteredBillNumber ||
                    updatedBills[0]?.billNumber ||
                    remark.billNumber ||
                    '';
                remark.billDate =
                    succeeded[0].billDate || updatedBills[0]?.billDate || remark.billDate || '';
                remark.zohoBillStatus = 'open';
                remark.billingStatus = 'billed';
                remark.zohoPaymentStatus = remark.zohoPaymentStatus || 'unpaid';
                remark.zohoOrganizationId = orgId;
                remark.zohoSyncedAt = new Date().toISOString();
            }
            remark.zohoSyncError = failed.length ? firstError : '';
            service.remark = JSON.stringify(remark);

            if (failed.length) {
                return {
                    ok: false,
                    message:
                        firstError ||
                        `${failed.length} of ${results.length} Zoho bill(s) failed. Fix and retry.`,
                    billIds: succeeded.map((r) => r.billId).filter(Boolean),
                    results,
                };
            }

            const billIds = succeeded.map((r) => r.billId).filter(Boolean);
            return {
                ok: true,
                billId: billIds[0] || '',
                billIds,
                billNumber: succeeded.map((r) => r.billNumber).filter(Boolean).join(', '),
                message:
                    billIds.length > 1
                        ? `${billIds.length} Zoho bills created.`
                        : succeeded[0]?.billNumber
                          ? `Zoho bill ${succeeded[0].billNumber} created.`
                          : 'Zoho bill created.',
            };
        }

        const result = await withZohoOrganization(orgId, async () =>
            createOneGarageZohoBill({
                asset,
                service,
                remark,
                billRemark: null,
                serviceTypeLabel: label,
                orgId,
                billIndex: 0,
            }),
        );

        remark.zohoBillId = result.billId;
        remark.zohoVendorId = result.vendorId;
        remark.zohoBillNumber = result.billNumber || '';
        remark.billNumber = result.enteredBillNumber || remark.billNumber || '';
        remark.billDate = result.billDate || remark.billDate || '';
        remark.zohoBillStatus = 'open';
        remark.billingStatus = 'billed';
        remark.zohoPaymentStatus = remark.zohoPaymentStatus || 'unpaid';
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

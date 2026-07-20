import { createBill, getZohoOrganizationId } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';

function sanitizeBillNumber(fineId) {
    return String(fineId || '')
        .trim()
        .replace(/[^\w-]/g, '-')
        .slice(0, 45);
}

async function resolveOrganizationIdForFine(fineDoc) {
    const fromFine = String(fineDoc?.zohoOrganizationId || '').trim();
    if (fromFine) return fromFine;
    if (fineDoc?.company) {
        return resolveZohoOrganizationIdForCompany(fineDoc.company);
    }
    return getZohoOrganizationId();
}

/**
 * Create a Zoho Books bill for an approved fine (after management picks vendor + expense account).
 */
export async function syncApprovedFineToZoho(fineDoc) {
    if (!fineDoc) return { ok: false, message: 'Fine missing' };

    if (fineDoc.zohoBillId) {
        return { ok: true, skipped: true, zohoBillId: fineDoc.zohoBillId };
    }

    const organizationId = await resolveOrganizationIdForFine(fineDoc);
    return withZohoOrganization(organizationId, () => syncApprovedFineToZohoInner(fineDoc));
}

async function syncApprovedFineToZohoInner(fineDoc) {
    const amount = Number(fineDoc.fineAmount ?? fineDoc.totalFineAmount);
    const billNumber =
        String(fineDoc.billNumber || '').trim() || sanitizeBillNumber(fineDoc.fineId) || '';
    const billDate =
        String(fineDoc.billDate || '').trim() ||
        (fineDoc.approvedDate
            ? new Date(fineDoc.approvedDate).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10));
    const expenseAccountId = String(fineDoc.expenseAccountId || '').trim();
    const vendorId = String(fineDoc.zohoVendorId || '').trim();

    if (!vendorId) {
        fineDoc.zohoSyncError = 'Zoho vendor is required for the fine bill.';
        await fineDoc.save();
        return { ok: false, message: fineDoc.zohoSyncError };
    }
    if (!billNumber) {
        fineDoc.zohoSyncError = 'Bill number is required for Zoho.';
        await fineDoc.save();
        return { ok: false, message: fineDoc.zohoSyncError };
    }
    if (!expenseAccountId) {
        fineDoc.zohoSyncError = 'Expense account (Chart of Accounts) is required for Zoho.';
        await fineDoc.save();
        return { ok: false, message: fineDoc.zohoSyncError };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        fineDoc.zohoSyncError = 'Fine amount must be greater than zero for Zoho.';
        await fineDoc.save();
        return { ok: false, message: fineDoc.zohoSyncError };
    }

    const descriptionParts = [
        fineDoc.fineType ? String(fineDoc.fineType) : '',
        fineDoc.category ? String(fineDoc.category) : '',
        fineDoc.fineId ? String(fineDoc.fineId) : '',
    ].filter(Boolean);

    try {
        const zohoBill = await createBill({
            vendor_id: vendorId,
            bill_number: billNumber,
            date: billDate,
            reference_number: String(fineDoc.fineId || '').trim() || undefined,
            notes: String(fineDoc.description || '').trim() || undefined,
            line_items: [
                {
                    account_id: expenseAccountId,
                    quantity: 1,
                    rate: Number(amount.toFixed(2)),
                    description: descriptionParts.join(' · ') || undefined,
                },
            ],
        });

        const zohoBillId = String(zohoBill?.bill_id || zohoBill?.billId || '').trim();
        try {
            await upsertZohoBillFromApi(zohoBill);
        } catch (upsertErr) {
            console.warn(
                '[FineZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        fineDoc.billDate = billDate;
        fineDoc.billNumber = billNumber;
        fineDoc.zohoBillId = zohoBillId;
        try {
            fineDoc.zohoOrganizationId = getZohoOrganizationId();
        } catch {
            /* ignore */
        }
        fineDoc.zohoSyncedAt = new Date();
        fineDoc.zohoSyncError = '';
        fineDoc.vendorBillStatus = fineDoc.vendorBillStatus || 'Pending';
        await fineDoc.save();

        return { ok: true, zohoBillId };
    } catch (err) {
        const message = err?.message || 'Failed to create Zoho bill for fine';
        console.error('[FineZoho] Failed:', message);
        fineDoc.zohoSyncError = message;
        await fineDoc.save();
        return { ok: false, message };
    }
}

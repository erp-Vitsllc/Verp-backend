import ZohoVendor from '../models/ZohoVendor.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { createBill, getZohoOrganizationId } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bill month "YYYY-MM" + payment day (1–31) → Zoho bill date. Clamps to last day of month. */
export function utilityBillDateFromMonth(billMonth, paymentDay = 16) {
    const month = String(billMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return '';

    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;
    if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return '';

    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    let day = Number(paymentDay);
    if (!Number.isInteger(day) || day < 1) day = 16;
    day = Math.min(day, lastDay);

    return `${month}-${String(day).padStart(2, '0')}`;
}

export async function resolveZohoVendorIdByProvider(providerName) {
    const name = String(providerName || '').trim();
    if (!name) return '';

    const organizationId = getZohoOrganizationId();
    const exact = new RegExp(`^${escapeRegex(name)}$`, 'i');
    const doc = await ZohoVendor.findOne({
        organizationId,
        isActive: true,
        $or: [{ contactName: exact }, { companyName: exact }],
    })
        .select('zohoContactId zohoVendorId')
        .lean();

    return String(doc?.zohoContactId || doc?.zohoVendorId || '').trim();
}

async function resolveOrganizationIdForUtilityBill(billDoc) {
    const fromBill = String(billDoc?.zohoOrganizationId || '').trim();
    if (fromBill) return fromBill;

    const employeeRef =
        billDoc?.payByEmployeeId || billDoc?.requestedBy || billDoc?.actionedBy || null;
    if (employeeRef) {
        const emp = await EmployeeBasic.findById(employeeRef).select('company').lean();
        if (emp?.company) {
            return resolveZohoOrganizationIdForCompany(emp.company);
        }
    }

    return getZohoOrganizationId();
}

/**
 * Create the utility row as a Zoho Books bill after HR approval.
 * Does not throw — stores zohoSyncError on the bill document when Zoho fails.
 */
export async function syncApprovedUtilityBillToZoho(billDoc) {
    if (!billDoc) return { ok: false, message: 'Bill missing' };

    if (billDoc.zohoBillId) {
        return { ok: true, skipped: true, zohoBillId: billDoc.zohoBillId };
    }

    const organizationId = await resolveOrganizationIdForUtilityBill(billDoc);
    return withZohoOrganization(organizationId, () =>
        syncApprovedUtilityBillToZohoInner(billDoc),
    );
}

async function syncApprovedUtilityBillToZohoInner(billDoc) {
    const amount = Number(billDoc.amount);
    const billNumber = String(billDoc.billNumber || '').trim();
    const billDate =
        String(billDoc.billDate || '').trim() ||
        utilityBillDateFromMonth(billDoc.billMonth, billDoc.paymentDay);
    const expenseAccountId = String(billDoc.expenseAccountId || '').trim();
    const provider = String(billDoc.provider || '').trim();

    if (!billNumber) {
        billDoc.zohoSyncError = 'Bill number is required for Zoho.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    if (!billDate) {
        billDoc.zohoSyncError = 'Bill date is required for Zoho (use bill month).';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    if (!expenseAccountId) {
        billDoc.zohoSyncError = 'Expense account is required for Zoho.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        billDoc.zohoSyncError = 'Actual amount must be greater than zero for Zoho.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }

    let vendorId = String(billDoc.zohoVendorId || '').trim();
    if (!vendorId) {
        try {
            vendorId = await resolveZohoVendorIdByProvider(provider);
            if (vendorId) billDoc.zohoVendorId = vendorId;
        } catch (err) {
            billDoc.zohoSyncError = err?.message || 'Failed to resolve Zoho vendor.';
            await billDoc.save();
            return { ok: false, message: billDoc.zohoSyncError };
        }
    }

    if (!vendorId) {
        billDoc.zohoSyncError = `No Zoho vendor matched provider "${provider || '—'}". Sync Vendors then retry.`;
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }

    const descriptionParts = [
        billDoc.utilityType ? String(billDoc.utilityType) : '',
        billDoc.accountNo ? `Acc ${billDoc.accountNo}` : '',
        billDoc.billMonth ? String(billDoc.billMonth) : '',
    ].filter(Boolean);

    try {
        const zohoBill = await createBill({
            vendor_id: vendorId,
            bill_number: billNumber,
            date: billDate,
            reference_number: String(billDoc.accountNo || '').trim() || undefined,
            notes: String(billDoc.notes || '').trim() || undefined,
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
                '[UtilityBillZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        billDoc.billDate = billDate;
        billDoc.zohoVendorId = vendorId;
        billDoc.zohoBillId = zohoBillId;
        try {
            billDoc.zohoOrganizationId = getZohoOrganizationId();
        } catch {
            /* ignore */
        }
        billDoc.zohoSyncedAt = new Date();
        billDoc.zohoSyncError = '';
        await billDoc.save();

        return { ok: true, zohoBillId };
    } catch (err) {
        const message = err?.message || 'Failed to create Zoho bill';
        console.error('[UtilityBillZoho] Failed:', message);
        billDoc.zohoSyncError = message;
        await billDoc.save();
        return { ok: false, message };
    }
}

export async function syncApprovedUtilityBillsToZoho(bills = []) {
    const results = [];
    for (const bill of bills) {
        results.push(await syncApprovedUtilityBillToZoho(bill));
    }
    return results;
}

import ZohoVendor from '../models/ZohoVendor.js';
import UtilityEntry from '../models/UtilityEntry.js';
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

/** Prefer exact / whole-word vendor match before loose substring (avoids "Du" → "Dubai …"). */
export async function resolveZohoVendorIdByProvider(providerName) {
    const name = String(providerName || '').trim();
    if (!name) return '';

    const organizationId = getZohoOrganizationId();
    const exact = new RegExp(`^${escapeRegex(name)}$`, 'i');
    const word = new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}([^a-z0-9]|$)`, 'i');

    const select = 'zohoContactId zohoVendorId contactName companyName';
    const baseFilter = { organizationId, isActive: true };

    let doc = await ZohoVendor.findOne({
        ...baseFilter,
        $or: [{ contactName: exact }, { companyName: exact }],
    })
        .select(select)
        .lean();

    if (!doc) {
        doc = await ZohoVendor.findOne({
            ...baseFilter,
            $or: [{ contactName: word }, { companyName: word }],
        })
            .select(select)
            .lean();
    }

    if (!doc && name.length >= 4) {
        const contains = new RegExp(escapeRegex(name), 'i');
        doc = await ZohoVendor.findOne({
            ...baseFilter,
            $or: [{ contactName: contains }, { companyName: contains }],
        })
            .select(select)
            .lean();
    }

    if (!doc) {
        const needle = name.toLowerCase();
        const candidates = await ZohoVendor.find(baseFilter).select(select).limit(500).lean();
        doc =
            candidates.find((row) => {
                const contact = String(row.contactName || '').toLowerCase();
                const company = String(row.companyName || '').toLowerCase();
                return (
                    (contact && contact === needle) ||
                    (company && company === needle) ||
                    (contact && needle.length >= 4 && contact.includes(needle)) ||
                    (company && needle.length >= 4 && company.includes(needle))
                );
            }) || null;
    }

    return String(doc?.zohoContactId || doc?.zohoVendorId || '').trim();
}

async function backfillUtilityBillZohoFields(billDoc) {
    const entryId = String(billDoc?.entryId || '').trim();
    let entry = null;
    if (entryId) {
        entry = await UtilityEntry.findById(entryId).lean();
    }
    const values = entry?.values && typeof entry.values === 'object' ? entry.values : {};

    if (!String(billDoc.provider || '').trim()) {
        const fromEntry = String(values.provider || '').trim();
        if (fromEntry) billDoc.provider = fromEntry;
    }
    if (!String(billDoc.accountNo || '').trim()) {
        const fromEntry = String(values.accountNumber || values.accountNo || '').trim();
        if (fromEntry) billDoc.accountNo = fromEntry;
    }
    if (!Number.isInteger(billDoc.paymentDay) || billDoc.paymentDay < 1) {
        const dayRaw = Number(values.paymentDay ?? values.paymentDate);
        if (Number.isInteger(dayRaw) && dayRaw >= 1 && dayRaw <= 31) {
            billDoc.paymentDay = dayRaw;
        }
    }
    if (!String(billDoc.billNumber || '').trim()) {
        const account = String(billDoc.accountNo || values.accountNumber || 'NA').trim();
        const month = String(billDoc.billMonth || '').trim() || 'NA';
        billDoc.billNumber = `UB-${account}-${month}`.slice(0, 50);
    }
    if (!String(billDoc.billDate || '').trim()) {
        billDoc.billDate = utilityBillDateFromMonth(billDoc.billMonth, billDoc.paymentDay ?? 16);
    }
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
    try {
        await backfillUtilityBillZohoFields(billDoc);
    } catch (backfillErr) {
        console.warn(
            '[UtilityBillZoho] Entry backfill failed:',
            backfillErr?.message || backfillErr,
        );
    }

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
        billDoc.zohoSyncError =
            'Expense account is required for Zoho. Re-submit the bill with an expense Chart of Accounts line, then Retry Zoho sync.';
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
        billDoc.zohoSyncError = `No Zoho vendor matched provider "${provider || '—'}". Sync Vendors in Accounts, then retry Zoho sync.`;
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
        let message = err?.message || 'Failed to create Zoho bill';
        console.error('[UtilityBillZoho] Failed:', message);
        // Stale vendor id from wrong org / deleted contact — clear and keep error for retry.
        if (/vendor|contact|invalid/i.test(message) && billDoc.zohoVendorId) {
            billDoc.zohoVendorId = '';
        }
        // Zoho's generic auth message — usually OAuth scope / user role / wrong org token.
        if (/not authorized to perform this operation/i.test(message)) {
            message =
                'Zoho refused to create the bill (not authorized). Reconnect Zoho for the correct org (Accounts → Zoho) with a user who can create Bills, then Retry Zoho sync.';
        }
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

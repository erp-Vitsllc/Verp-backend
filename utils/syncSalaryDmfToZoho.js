import {
    createBillWithZohoSerial,
    getZohoOrganizationId,
    markBillAsOpen,
    fetchBillById,
} from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';
import { resolveZohoBillSerialNumber } from './zohoPurchaseMappers.js';
import { getCalendarPartsInTz, getScheduledEmailTimeZone } from './scheduleDailyAtMidnight.js';

function pad2(n) {
    return String(n).padStart(2, '0');
}

function dubaiDateKey() {
    const parts = getCalendarPartsInTz(new Date(), getScheduledEmailTimeZone());
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function sanitizeBillNumber(value) {
    return String(value || '')
        .trim()
        .replace(/[^\w-]/g, '-')
        .slice(0, 45);
}

function applyZohoResult(dmf, patch) {
    Object.assign(dmf, patch);
    return dmf;
}

/**
 * Create a Zoho Books bill after Management approves DMF.
 * Missing vendor/account/amount skips the bill without failing the approval.
 */
export async function syncSalaryDmfToZoho(dmf, { company, billNumber, notes } = {}) {
    if (!dmf) return { ok: false, skipped: true, message: 'DMF missing' };

    const amount = Number(dmf.amount) || 0;
    const vendorId = String(process.env.ZOHO_SALARY_VENDOR_ID || dmf.zohoVendorId || '').trim();
    const expenseAccountId = String(
        process.env.ZOHO_SALARY_EXPENSE_ACCOUNT_ID || dmf.expenseAccountId || '',
    ).trim();

    if (!(amount > 0)) {
        return applySkip(dmf, 'No payable amount to send to Zoho Books.');
    }
    if (!vendorId || !expenseAccountId) {
        return applySkip(
            dmf,
            'Zoho Books bill skipped: set ZOHO_SALARY_VENDOR_ID and ZOHO_SALARY_EXPENSE_ACCOUNT_ID.',
        );
    }

    const organizationId =
        (await resolveZohoOrganizationIdForCompany(company)) || getZohoOrganizationId();

    try {
        const result = await withZohoOrganization(organizationId, async () => {
            const number = sanitizeBillNumber(billNumber || dmf.billLabel);
            const zohoBill = await createBillWithZohoSerial({
                vendor_id: vendorId,
                bill_number: number,
                reference_number: number || undefined,
                date: dubaiDateKey(),
                notes: notes || dmf.billLabel || 'Salary DMF',
                line_items: [
                    {
                        account_id: expenseAccountId,
                        name: String(dmf.billLabel || 'Salary DMF').slice(0, 100),
                        quantity: 1,
                        rate: Number(amount.toFixed(2)),
                        description: notes || dmf.billLabel || undefined,
                    },
                ],
            });

            const zohoBillId = String(zohoBill?.bill_id || zohoBill?.billId || '').trim();
            if (!zohoBillId) throw new Error('Zoho did not return a bill id.');

            let zohoBillStatus = 'draft';
            let zohoBillForUpsert = zohoBill;
            let openWarning = '';
            try {
                await markBillAsOpen(zohoBillId);
                zohoBillForUpsert = (await fetchBillById(zohoBillId)) || zohoBill;
                zohoBillStatus = 'open';
            } catch (openErr) {
                openWarning = openErr?.message || 'Could not mark Zoho bill as Open';
            }

            try {
                await upsertZohoBillFromApi(zohoBillForUpsert);
            } catch {
                /* local cache is best-effort */
            }

            return {
                zohoBillId,
                zohoBillNumber: resolveZohoBillSerialNumber(zohoBillForUpsert || zohoBill) || number,
                zohoBillStatus,
                zohoOrganizationId: organizationId || '',
                zohoSyncedAt: new Date(),
                zohoSyncError: openWarning,
                zohoSkipped: false,
            };
        });

        applyZohoResult(dmf, result);
        return { ok: true, ...result };
    } catch (err) {
        const message = err?.message || 'Failed to create Zoho Books bill';
        applyZohoResult(dmf, {
            zohoSyncError: message,
            zohoSkipped: false,
            zohoSyncedAt: new Date(),
        });
        return { ok: false, message };
    }
}

function applySkip(dmf, message) {
    applyZohoResult(dmf, {
        zohoSkipped: true,
        zohoSyncError: message,
        zohoBillStatus: '',
        zohoSyncedAt: new Date(),
    });
    return { ok: true, skipped: true, message };
}

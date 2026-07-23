import { createBill, getZohoOrganizationId, markBillAsOpen, fetchBillById } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';
import {
    resolveCompanyFinePayableAmount,
    resolveEmployeeFinePayableAmount,
    resolvePrimaryEmployeeId,
} from './finePayableAmount.js';

function sanitizeBillNumber(fineId) {
    return String(fineId || '')
        .trim()
        .replace(/[^\w-]/g, '-')
        .slice(0, 45);
}

function getFineBaseId(fineId) {
    const fid = String(fineId || '');
    const parts = fid.split('-');
    if (parts.length > 3) return parts.slice(0, 3).join('-');
    return fid;
}

async function resolveOrganizationIdForFine(fineDoc) {
    const fromFine = String(fineDoc?.zohoOrganizationId || '').trim();
    if (fromFine) return fromFine;
    if (fineDoc?.company) {
        return resolveZohoOrganizationIdForCompany(fineDoc.company);
    }
    return getZohoOrganizationId();
}

/** Bill line rate = party base + service charge (never base alone). */
function resolveFineBillLineAmount(fineDoc) {
    const party = fineDoc.assignedEmployees?.[0];
    const isCompany =
        party?.employeeId === 'VEGA-HR-0000' ||
        party?.employeeId === 'VEGA_INTERNAL';

    let payable = 0;
    if (isCompany) {
        payable = resolveCompanyFinePayableAmount(fineDoc, party);
    } else {
        const empId = party?.employeeId || resolvePrimaryEmployeeId(fineDoc);
        payable = empId ? resolveEmployeeFinePayableAmount(fineDoc, empId) : 0;
    }

    if (payable > 0) return Number(payable.toFixed(2));

    const empAmt = Number(fineDoc.employeeAmount || 0) || 0;
    const compAmt = Number(fineDoc.companyAmount || 0) || 0;
    const servCharge = Number(fineDoc.serviceCharge || 0) || 0;
    const fromParts = empAmt + compAmt + servCharge;
    if (fromParts > 0) return Number(fromParts.toFixed(2));

    const total = Number(fineDoc.totalFineAmount || fineDoc.fineAmount || 0);
    return Number.isFinite(total) && total > 0 ? Number(total.toFixed(2)) : 0;
}

function buildLineItemFromFine(fineDoc) {
    const amount = resolveFineBillLineAmount(fineDoc);
    const expenseAccountId = String(fineDoc.expenseAccountId || '').trim();
    if (!expenseAccountId || !Number.isFinite(amount) || amount <= 0) return null;

    const party = fineDoc.assignedEmployees?.[0];
    const isCompany =
        party?.employeeId === 'VEGA-HR-0000' ||
        party?.employeeId === 'VEGA_INTERNAL';
    const partyName =
        party?.employeeName ||
        (isCompany ? fineDoc.companyName || 'Company' : '') ||
        fineDoc.companyName ||
        '';
    // Zoho Bill Item Table: Item Details = party + fine ref; Account = Payable COA
    const descriptionParts = [
        partyName,
        fineDoc.fineType ? String(fineDoc.fineType) : 'Fine',
        fineDoc.fineId ? String(fineDoc.fineId) : '',
        fineDoc.description ? String(fineDoc.description).slice(0, 80) : '',
    ].filter(Boolean);

    return {
        account_id: expenseAccountId,
        name: partyName || String(fineDoc.fineId || 'Fine party'),
        quantity: 1,
        rate: amount,
        description: descriptionParts.join(' · ') || undefined,
    };
}

/**
 * Create one Zoho Books bill for approved fine(s) after Management approval.
 * Group fines: a single bill — Vendor = Fine Source; Item Table rows = each party (Payable COA + amount).
 */
export async function syncApprovedFineToZoho(fineDoc, siblingFines = null) {
    if (!fineDoc) return { ok: false, message: 'Fine missing' };

    const group = Array.isArray(siblingFines) && siblingFines.length > 0
        ? siblingFines
        : [fineDoc];

    if (group.every((f) => f.zohoBillId)) {
        return { ok: true, skipped: true, zohoBillId: group[0].zohoBillId };
    }

    const organizationId = await resolveOrganizationIdForFine(fineDoc);
    return withZohoOrganization(organizationId, () => syncApprovedFineToZohoInner(fineDoc, group));
}

async function syncApprovedFineToZohoInner(fineDoc, group) {
    const primary = group.find((f) => !f.zohoBillId) || fineDoc;
    const baseId = getFineBaseId(primary.fineId);
    const billNumber =
        String(primary.billNumber || '').trim() || sanitizeBillNumber(baseId) || '';
    const billDate =
        String(primary.billDate || '').trim() ||
        (primary.approvedDate
            ? new Date(primary.approvedDate).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10));
    const vendorId = String(primary.zohoVendorId || fineDoc.zohoVendorId || '').trim();

    if (!vendorId) {
        const message = 'Zoho vendor is required for the fine bill (use Fine Source / vendor).';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }
    if (!billNumber) {
        const message = 'Bill number is required for Zoho.';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }

    const lineItems = group.map(buildLineItemFromFine).filter(Boolean);
    if (!lineItems.length) {
        const message =
            'Each party needs a Payable (Chart of Accounts) and amount greater than zero for the Zoho bill.';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }

    const vendorLabel =
        String(primary.zohoVendorName || fineDoc.zohoVendorName || fineDoc.fineSource || '').trim();
    const notesParts = [
        fineDoc.description ? String(fineDoc.description).trim() : '',
        vendorLabel ? `Vendor (Fine Source): ${vendorLabel}` : '',
        `Parties: ${lineItems.length}`,
    ].filter(Boolean);

    try {
        const zohoBill = await createBill({
            vendor_id: vendorId,
            bill_number: billNumber,
            date: billDate,
            reference_number: String(baseId || '').trim() || undefined,
            notes: notesParts.join('\n') || undefined,
            line_items: lineItems,
        });

        const zohoBillId = String(zohoBill?.bill_id || zohoBill?.billId || '').trim();
        if (!zohoBillId) {
            throw new Error('Zoho did not return a bill id.');
        }

        // Management-approved fine bills must be Open (payable), not left as Draft
        let zohoBillForUpsert = zohoBill;
        let openWarning = '';
        try {
            await markBillAsOpen(zohoBillId);
            zohoBillForUpsert = (await fetchBillById(zohoBillId)) || zohoBill;
        } catch (openErr) {
            openWarning = openErr?.message || 'Could not mark Zoho bill as Open';
            console.warn('[FineZoho] Bill created but still Draft:', openWarning);
        }

        try {
            await upsertZohoBillFromApi(zohoBillForUpsert);
        } catch (upsertErr) {
            console.warn(
                '[FineZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        let orgId = '';
        try {
            orgId = getZohoOrganizationId();
        } catch {
            /* ignore */
        }

        for (const f of group) {
            f.billDate = billDate;
            f.billNumber = billNumber;
            f.zohoBillId = zohoBillId;
            if (orgId) f.zohoOrganizationId = orgId;
            f.zohoSyncedAt = new Date();
            f.zohoSyncError = openWarning || '';
            f.vendorBillStatus = f.vendorBillStatus || 'Pending';
            if (!f.zohoVendorId) f.zohoVendorId = vendorId;
            if (!f.zohoVendorName && vendorLabel) f.zohoVendorName = vendorLabel;
            await f.save();
        }

        return {
            ok: true,
            zohoBillId,
            lineItemCount: lineItems.length,
            zohoStatus: openWarning ? 'draft' : 'open',
            warning: openWarning || undefined,
        };
    } catch (err) {
        const message = err?.message || 'Failed to create Zoho bill for fine';
        console.error('[FineZoho] Failed:', message);
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }
}

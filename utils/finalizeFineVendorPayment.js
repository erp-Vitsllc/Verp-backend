import Fine from '../models/Fine.js';
import PartyExpense from '../models/PartyExpense.js';
import {
    resolveCompanyFinePayableAmount,
    resolveEmployeeFinePayableAmount,
} from './finePayableAmount.js';
import {
    fetchZohoPaymentLedgerLines,
    ledgerFromZohoLines,
} from './recordPartyExpenseFromZohoPayment.js';

const COMPANY_PARTY_ID = 'VEGA-HR-0000';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function isCompanyParty(entry) {
    if (!entry) return false;
    const id = entry.employeeId;
    const name = String(entry.employeeName || '').trim();
    return id === COMPANY_PARTY_ID || id === 'VEGA_INTERNAL' || name === 'Vega Digital IT Solutions';
}

/**
 * After Accounts pays the fine vendor bill in Zoho: mark fine vendor paid + party expense rows.
 */
export async function finalizeFineVendorPayment({
    fineMongoId,
    zohoPayment = {},
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    paymentMode = '',
    userId = null,
} = {}) {
    const id = clean(fineMongoId);
    if (!id) throw new Error('fineMongoId is required.');

    const fine = await Fine.findById(id);
    if (!fine) throw new Error('Fine not found.');

    const zohoPaymentId = clean(
        zohoPayment.payment_id || zohoPayment.vendorpayment_id || zohoPayment.id,
    );
    const zohoPaymentNumber = clean(zohoPayment.payment_number || zohoPayment.payment_no);
    const zohoOrganizationId = clean(zohoPayment.organization_id || fine.zohoOrganizationId);
    const paymentAmount = money(zohoPayment.amount ?? fine.fineAmount);

    let ledgerLines = [];
    if (zohoPaymentId) {
        const zohoLedger = await fetchZohoPaymentLedgerLines(zohoPaymentId);
        if (zohoLedger?.lines?.length) {
            ledgerLines = ledgerFromZohoLines(zohoLedger.lines, paymentAmount);
        }
    }

    fine.vendorBillStatus = 'Paid';
    fine.vendorBillPaidAt = new Date();
    fine.zohoVendorPaymentId = zohoPaymentId || fine.zohoVendorPaymentId;
    fine.zohoVendorPaymentNumber = zohoPaymentNumber || fine.zohoVendorPaymentNumber;
    await fine.save();

    const created = [];
    const companyId = clean(fine.company?.toString?.() || fine.company);
    const companyName = clean(fine.companyName, 'VEGA Digital');

    for (const entry of fine.assignedEmployees || []) {
        if (!entry?.employeeId || entry.employeeId === 'PENDING') continue;

        if (isCompanyParty(entry)) {
            const amount = resolveCompanyFinePayableAmount(fine, entry);
            if (amount <= 0) continue;

            const doc = await upsertFinePartyExpense({
                fine,
                partyType: 'company',
                employeeId: COMPANY_PARTY_ID,
                employeeName: clean(entry.employeeName, companyName),
                companyId,
                companyName,
                amount,
                zohoPaymentId,
                zohoPaymentNumber,
                zohoOrganizationId,
                paidThroughAccountId,
                paidThroughAccountName,
                paymentMode,
                ledgerLines,
                userId,
            });
            created.push(doc);
            continue;
        }

        const amount = resolveEmployeeFinePayableAmount(fine, entry.employeeId);
        if (amount <= 0) continue;

        const doc = await upsertFinePartyExpense({
            fine,
            partyType: 'employee',
            employeeId: entry.employeeId,
            employeeName: clean(entry.employeeName),
            companyId,
            companyName,
            amount,
            zohoPaymentId,
            zohoPaymentNumber,
            zohoOrganizationId,
            paidThroughAccountId,
            paidThroughAccountName,
            paymentMode,
            ledgerLines,
            userId,
        });
        created.push(doc);
    }

    if (!created.length) {
        const rf = clean(fine.responsibleFor).toLowerCase();
        if (rf === 'company') {
            const amount = resolveCompanyFinePayableAmount(fine);
            if (amount > 0) {
                created.push(
                    await upsertFinePartyExpense({
                        fine,
                        partyType: 'company',
                        employeeId: COMPANY_PARTY_ID,
                        employeeName: companyName,
                        companyId,
                        companyName,
                        amount,
                        zohoPaymentId,
                        zohoPaymentNumber,
                        zohoOrganizationId,
                        paidThroughAccountId,
                        paidThroughAccountName,
                        paymentMode,
                        ledgerLines,
                        userId,
                    }),
                );
            }
        }
    }

    return { fine: fine.toObject(), partyExpenses: created.map((d) => d.toObject?.() || d) };
}

async function upsertFinePartyExpense({
    fine,
    partyType,
    employeeId,
    employeeName,
    companyId,
    companyName,
    amount,
    zohoPaymentId,
    zohoPaymentNumber,
    zohoOrganizationId,
    paidThroughAccountId,
    paidThroughAccountName,
    paymentMode,
    ledgerLines,
    userId,
}) {
    const fineMongoId = String(fine._id);
    let doc = await PartyExpense.findOne({
        fineMongoId,
        kind: 'fine',
        partyType,
        ...(partyType === 'employee' ? { employeeId } : {}),
    });

    if (!doc) {
        doc = new PartyExpense({
            partyType,
            kind: 'fine',
            employeeId: partyType === 'company' ? COMPANY_PARTY_ID : employeeId,
            employeeName,
            companyId,
            companyName,
            fineMongoId,
            fineId: clean(fine.fineId),
            createdBy: userId || null,
            ledger: [],
        });
    }

    doc.status = 'Not Paid';
    doc.amount = money(amount);
    doc.description =
        doc.description ||
        `Fine ${clean(fine.fineId)} · ${clean(fine.fineType)} · vendor bill paid in Zoho`;
    doc.zohoBillId = clean(fine.zohoBillId);
    doc.zohoPaymentId = zohoPaymentId || doc.zohoPaymentId;
    doc.zohoPaymentNumber = zohoPaymentNumber || doc.zohoPaymentNumber;
    doc.zohoOrganizationId = zohoOrganizationId || doc.zohoOrganizationId;
    doc.paidThroughAccountId = paidThroughAccountId || doc.paidThroughAccountId;
    doc.paidThroughAccountName = paidThroughAccountName || doc.paidThroughAccountName;
    doc.paymentMode = paymentMode || doc.paymentMode;

    if (ledgerLines.length && (!doc.ledger || doc.ledger.length === 0)) {
        doc.ledger = ledgerLines.map((row) => ({ ...row, locked: true }));
    }

    await doc.save();
    return doc;
}

import Fine from '../../models/Fine.js';
import Payment from '../../models/Payment.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { isUserInFlowchart } from '../../utils/getDepartmentHOD.js';
import { resolveEmployeeFinePayableAmount } from '../../utils/finePayableAmount.js';
import { runAfterResponse } from '../../utils/runAfterResponse.js';
import {
    closeAccountsPaymentInbox,
    emailManagementAccountsSettlement,
} from '../../utils/fineAccountsPaymentFlow.js';

const COMPANY_IDS = new Set(['VEGA-HR-0000', 'VEGA_INTERNAL']);

async function loadFineGroup(id) {
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    let fines = [];

    if (isValidObjectId) {
        const targetFine = await Fine.findById(id);
        if (targetFine) {
            const baseId =
                targetFine.fineId.split('-').length > 3
                    ? targetFine.fineId.split('-').slice(0, 3).join('-')
                    : targetFine.fineId;
            const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
            fines = await Fine.find({ fineId: baseIdRegex }).populate('createdBy', 'name');
        }
    }

    if (fines.length === 0) {
        const baseId = String(id).split('-').length > 3 ? String(id).split('-').slice(0, 3).join('-') : id;
        const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
        fines = await Fine.find({ fineId: baseIdRegex }).populate('createdBy', 'name');
    }

    return fines;
}

async function isAccountsActor(req) {
    if (req.user?.isAdmin === true) return true;
    const inAccounts =
        (await isUserInFlowchart(req.user, 'accounts').catch(() => false)) ||
        (await isUserInFlowchart(req.user, 'finance').catch(() => false));
    if (inAccounts) return true;
    const dept = String(req.user?.department || '').toLowerCase();
    return dept === 'finance' || dept === 'account' || dept === 'accounts';
}

function applyPartyPayables(fines, partyPayables = []) {
    if (!Array.isArray(partyPayables) || partyPayables.length === 0) return;
    for (const party of partyPayables) {
        if (!party) continue;
        const match = fines.find(
            (f) =>
                (party.fineRecordId && String(f._id) === String(party.fineRecordId)) ||
                (party.fineId && String(f.fineId) === String(party.fineId)),
        );
        if (!match) continue;
        if (party.expenseAccountId !== undefined) {
            match.expenseAccountId = String(party.expenseAccountId || '').trim();
        }
        if (party.expenseAccountName !== undefined) {
            match.expenseAccountName = String(party.expenseAccountName || '').trim();
        }
        if (party.payableConfirmed !== undefined) {
            match.payableConfirmed = Boolean(party.payableConfirmed);
        } else if (match.expenseAccountId) {
            match.payableConfirmed = true;
        }
        if (party.zohoVendorId !== undefined) {
            match.zohoVendorId = String(party.zohoVendorId || '').trim();
        }
        if (party.zohoVendorName !== undefined) {
            match.zohoVendorName = String(party.zohoVendorName || '').trim();
        }
    }
}

/**
 * Accounts settlement after Management approval.
 * POST/PUT body: { action: 'enter_zoho' | 'paid_by_employee', partyPayables?, zohoVendorId?, ... }
 */
export const accountsFinePayment = async (req, res) => {
    let { id } = req.params;
    if (id && typeof id === 'string' && id.includes(':')) {
        id = id.split(':')[0].trim();
    }

    try {
        const action = String(req.body?.action || '').trim();
        if (action !== 'enter_zoho' && action !== 'paid_by_employee') {
            return res.status(400).json({
                message: 'Action must be enter_zoho or paid_by_employee.',
            });
        }

        if (!(await isAccountsActor(req))) {
            return res.status(403).json({
                message: 'Only Accounts can settle an approved fine.',
            });
        }

        const fines = await loadFineGroup(id);
        if (fines.length === 0) {
            return res.status(404).json({ message: 'Fine(s) not found' });
        }

        const fine = fines[0];
        const status = String(fine.fineStatus || '');
        if (!['Approved', 'Active'].includes(status)) {
            return res.status(400).json({
                message: `Fine must be Approved before Accounts settlement (status: ${status}).`,
            });
        }

        const alreadySettled = fines.some((f) => String(f.accountsPaymentPath || '').trim());
        if (alreadySettled) {
            return res.status(400).json({
                message: 'Accounts has already settled this fine (Zoho or paid by employee).',
            });
        }

        if (action === 'enter_zoho') {
            applyPartyPayables(fines, req.body?.partyPayables);

            const {
                zohoVendorId = '',
                zohoVendorName = '',
                expenseAccountId = '',
                expenseAccountName = '',
                zohoOrganizationId = '',
                billNumber = '',
                billDate = '',
            } = req.body || {};

            let vendorId = String(zohoVendorId || fine.zohoVendorId || '').trim();
            const vendorNameHint = String(
                zohoVendorName || fine.zohoVendorName || fine.fineSource || '',
            ).trim();
            const accountId = String(expenseAccountId || fine.expenseAccountId || '').trim();
            const allPartiesHavePayable = fines.every((f) => String(f.expenseAccountId || '').trim());

            if (!vendorId && !vendorNameHint) {
                return res.status(400).json({
                    message:
                        'Enter in Zoho requires a vendor. Set Vendor (Fine Source) on the Fine Parties card first.',
                });
            }
            if (!accountId && !allPartiesHavePayable) {
                return res.status(400).json({
                    message: 'Enter in Zoho requires Payable (Chart of Accounts) for every party.',
                });
            }

            for (const f of fines) {
                f.zohoVendorId = vendorId || f.zohoVendorId || '';
                f.zohoVendorName = vendorNameHint || f.zohoVendorName || '';
                if (accountId && !String(f.expenseAccountId || '').trim()) {
                    f.expenseAccountId = accountId;
                    f.expenseAccountName = String(expenseAccountName || '').trim();
                }
                if (String(zohoOrganizationId || '').trim()) {
                    f.zohoOrganizationId = String(zohoOrganizationId).trim();
                }
                if (String(billNumber || '').trim()) f.billNumber = String(billNumber).trim();
                if (String(billDate || '').trim()) f.billDate = String(billDate).trim();
                f.accountsPaymentPath = 'zoho';
                f.accountsPaymentAt = new Date();
                f.accountsPaymentBy = req.user._id;
                await f.save();
            }

            const fineIdsForZoho = fines.map((f) => f._id);
            const primaryFineId = fines[0]._id;
            const vendorNameForBg = vendorNameHint;
            const orgIdForBg = String(zohoOrganizationId || fine.zohoOrganizationId || '').trim();

            runAfterResponse('accountsFine-enter-zoho', async () => {
                const freshFines = await Fine.find({ _id: { $in: fineIdsForZoho } });
                if (!freshFines.length) return;
                const primary =
                    freshFines.find((f) => String(f._id) === String(primaryFineId)) || freshFines[0];

                if (!String(primary.zohoVendorId || '').trim() && vendorNameForBg) {
                    try {
                        const { fetchVendors } = await import('../../services/zohoService.js');
                        const { withZohoOrganization } = await import('../../utils/zohoOrgContext.js');
                        const vendors = orgIdForBg
                            ? await withZohoOrganization(orgIdForBg, () => fetchVendors())
                            : await fetchVendors();
                        const normalize = (s) =>
                            String(s || '')
                                .trim()
                                .toLowerCase()
                                .replace(/\u00a0/g, ' ')
                                .replace(/\s+/g, ' ')
                                .replace(/\s*&\s*/g, ' and ')
                                .replace(/[^a-z0-9\u0600-\u06FF\s]/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim();
                        const hint = normalize(vendorNameForBg);
                        const list = Array.isArray(vendors) ? vendors : [];
                        let match = list.find((v) => {
                            const names = [v.contact_name, v.vendor_name, v.company_name]
                                .map(normalize)
                                .filter(Boolean);
                            return names.some((n) => n === hint);
                        });
                        if (!match) {
                            match = list.find((v) => {
                                const names = [v.contact_name, v.vendor_name, v.company_name]
                                    .map(normalize)
                                    .filter(Boolean);
                                return names.some((n) => n.includes(hint) || hint.includes(n));
                            });
                        }
                        const resolvedId = String(
                            match?.contact_id || match?.vendor_id || match?.id || '',
                        ).trim();
                        if (resolvedId) {
                            for (const f of freshFines) {
                                f.zohoVendorId = resolvedId;
                                if (!f.zohoVendorName) f.zohoVendorName = vendorNameForBg;
                                await f.save();
                            }
                            primary.zohoVendorId = resolvedId;
                        }
                    } catch (lookupErr) {
                        console.warn(
                            '[accountsFinePayment] Vendor lookup failed:',
                            lookupErr?.message || lookupErr,
                        );
                    }
                }

                const { syncApprovedFineToZoho } = await import('../../utils/syncApprovedFineToZoho.js');
                const zohoResult = await syncApprovedFineToZoho(primary, freshFines);
                if (zohoResult && zohoResult.ok === false && !zohoResult.skipped) {
                    console.warn('[accountsFinePayment] Zoho bill sync issues:', zohoResult);
                }

                await emailManagementAccountsSettlement(primary, 'accounts_entered_zoho');
            });

            await closeAccountsPaymentInbox(fine, fines);

            return res.status(200).json({
                message: 'Zoho bill is posting in the background. Employee payment stays unpaid.',
                fine: fines[0],
            });
        }

        // paid_by_employee — no Zoho
        for (const f of fines) {
            const employeeParties = (f.assignedEmployees || []).filter(
                (e) => e.employeeId && !COMPANY_IDS.has(String(e.employeeId)),
            );

            let totalPaid = 0;
            for (const party of employeeParties) {
                const amount = resolveEmployeeFinePayableAmount(f, party.employeeId);
                if (amount <= 0.01) continue;

                const emp = await EmployeeBasic.findOne({ employeeId: party.employeeId }).select(
                    '_id firstName lastName employeeId',
                );
                if (!emp) {
                    totalPaid += amount;
                    continue;
                }

                const existing = await Payment.findOne({
                    relatedEntityType: 'Fine',
                    status: { $in: ['Completed', 'Paid'] },
                    $or: [{ relatedEntityId: f._id }, { referenceId: f.fineId }],
                    paidBy: emp._id,
                });
                if (existing) {
                    totalPaid += Number(existing.amount || 0);
                    continue;
                }

                await Payment.create({
                    paymentType: 'Fine',
                    paidBy: emp._id,
                    paidByName: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || party.employeeName,
                    amount,
                    status: 'Completed',
                    paymentDate: new Date(),
                    description: `Paid by employee · ${f.fineId}`,
                    referenceId: f.fineId,
                    relatedEntityType: 'Fine',
                    relatedEntityId: f._id,
                    createdBy: req.user._id,
                    paymentSource: 'Cash',
                    remarks: 'Accounts marked paid by employee — no Zoho entry',
                });
                totalPaid += amount;
            }

            if (totalPaid <= 0.01) {
                totalPaid = Number(f.totalFineAmount || f.fineAmount || 0) || 0;
            }

            f.paidAmount = totalPaid;
            f.fineStatus = 'Paid';
            f.accountsPaymentPath = 'employee';
            f.accountsPaymentAt = new Date();
            f.accountsPaymentBy = req.user._id;
            await f.save();
        }

        const snapshot = fines[0].toObject?.() ? fines[0].toObject() : fines[0];
        runAfterResponse('accountsFine-paid-by-employee', () =>
            emailManagementAccountsSettlement(snapshot, 'accounts_paid_by_employee'),
        );
        await closeAccountsPaymentInbox(fine, fines);

        return res.status(200).json({
            message: 'Fine marked paid by employee. No Zoho entry was created.',
            fine: fines[0],
        });
    } catch (error) {
        console.error('accountsFinePayment:', error);
        return res.status(500).json({ message: error.message || 'Failed to settle fine payment.' });
    }
};

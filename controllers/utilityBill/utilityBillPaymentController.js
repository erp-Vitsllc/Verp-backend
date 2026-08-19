import mongoose from 'mongoose';
import UtilityBillPayment from '../../models/UtilityBillPayment.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import DashboardAction from '../../models/DashboardAction.js';
import { getDepartmentHOD } from '../../utils/getDepartmentHOD.js';
import { syncDashboardAction } from '../../utils/syncDashboard.js';
import { sendUtilityBillPaymentEmail, notifyUtilityBillZohoPayableParties } from '../../utils/sendUtilityBillPaymentEmail.js';
import {
    cascadeDeleteUtilityBill,
    isUtilityAdminSuperUser,
} from '../../utils/utilityBillAdminDelete.js';
import {
    syncApprovedUtilityBillsToZoho,
    utilityBillDateFromMonth,
    resolveZohoVendorIdByProvider,
} from '../../utils/syncUtilityBillToZoho.js';
import { upsertUtilityBalancePartyExpensesFromBills, employeeIdQueryVariants } from '../../utils/upsertUtilityBalancePartyExpense.js';
import { syncApprovedUtilityBillsPaidFromZoho, utilityBillHasZohoLink } from '../../utils/markUtilityVendorBillsPaidFromZoho.js';
import Company from '../../models/Company.js';
import {
    findCurrentBatchVendorBillDuplicate,
    lookupVendorBillDuplicates,
} from '../../utils/utilityBillDuplicateCheck.js';
import { attachZohoBillNumbers } from '../../utils/attachZohoDocumentNumbers.js';

const REQUEST_TYPE = 'Utility Bill Payment';

function empDisplayName(emp) {
    if (!emp) return '';
    return `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'User';
}

function computePaySplit(amount, monthlyRental, paymentBy, existingCompany = 0, existingEmployee = 0) {
    const amt = Math.max(0, Number(amount) || 0);
    const monthly = Math.max(0, Number(monthlyRental) || 0);
    if (paymentBy === 'employee_and_company') {
        return {
            companyPayAmount: Number(existingCompany) || 0,
            employeePayAmount: Number(existingEmployee) || 0,
        };
    }
    if (paymentBy === 'employee_balance' || paymentBy === 'employee') {
        const companyPayAmount = Math.min(amt, monthly);
        const employeePayAmount = Math.max(0, amt - monthly);
        return { companyPayAmount, employeePayAmount };
    }
    return { companyPayAmount: amt, employeePayAmount: 0 };
}

function attachmentPayload(attachment) {
    if (attachment?.name && attachment?.dataUrl) {
        return {
            name: String(attachment.name).slice(0, 240),
            mime: String(attachment.mime || '').slice(0, 120),
            dataUrl: String(attachment.dataUrl),
        };
    }
    return { name: '', mime: '', dataUrl: '' };
}

async function resolveRequesterEmployee(user) {
    if (!user) return null;
    const oid = user.employeeObjectId || user.employeeId;
    if (oid) {
        const emp = await EmployeeBasic.findById(oid)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email status')
            .lean();
        if (emp) return emp;
    }
    return null;
}

function requesterDisplayName(emp, user) {
    if (emp) return empDisplayName(emp);
    return user?.name || 'User';
}

function reviewPath(batchId, utilityType = '', billMonth = '') {
    const q = new URLSearchParams({
        batchId: String(batchId),
        review: '1',
    });
    if (utilityType) q.set('type', String(utilityType));
    if (billMonth) q.set('billMonth', String(billMonth));
    return `/HRM/Asset/UtilityBills?${q.toString()}`;
}

function statusLabel(status, pendingWithName = '') {
    if (status === 'Pending Accounts') {
        return `pending ${pendingWithName || 'Accounts'} accounts`;
    }
    if (status === 'Pending HR') {
        return `pending ${pendingWithName || 'HR'} hr`;
    }
    // Approved by HR/Accounts workflow but Accounts has not paid yet
    if (status === 'Approved') return 'not paid';
    if (status === 'Paid') return 'paid';
    if (status === 'Rejected') return 'rejected';
    return String(status || '');
}

function decorateBill(bill) {
    if (!bill) return bill;
    const o = typeof bill.toObject === 'function' ? bill.toObject() : { ...bill };
    const accountsApprovedByName =
        o.accountsApprovedBy && typeof o.accountsApprovedBy === 'object'
            ? empDisplayName(o.accountsApprovedBy)
            : '';
    const hrApprovedByName =
        o.hrApprovedBy && typeof o.hrApprovedBy === 'object'
            ? empDisplayName(o.hrApprovedBy)
            : '';
    const actionedByName =
        o.actionedBy && typeof o.actionedBy === 'object' ? empDisplayName(o.actionedBy) : '';

    o.accountsApprovedByName = accountsApprovedByName;
    o.hrApprovedByName = hrApprovedByName;
    o.actionedByName = actionedByName;
    o.approvedByName = hrApprovedByName || accountsApprovedByName || actionedByName;
    o.statusLabel = statusLabel(o.status, o.pendingWithName);
    o.reviewPath = o.batchId
        ? reviewPath(o.batchId, o.utilityType, o.billMonth)
        : `/HRM/Asset/UtilityBills/details/${encodeURIComponent(o.entryId)}?billId=${encodeURIComponent(String(o._id))}`;
    o.zohoBillNumber = String(o.zohoBillNumber || '').trim();
    return o;
}

/** Pay By party labels selected in UI (company / employee name dropdowns). */
function payByPartyFromRow(row = {}) {
    return {
        payByCompanyId: String(row.payByCompanyId || '').trim(),
        payByCompanyName: String(row.payByCompanyName || '').trim(),
        payByEmployeeId: String(row.payByEmployeeId || '').trim(),
        payByEmployeeName: String(row.payByEmployeeName || '').trim(),
    };
}

/** True when both refs point to the same employee (ObjectId or lean doc). */
function isSameEmployee(a, b) {
    if (!a || !b) return false;
    const idA = a._id != null ? a._id : a;
    const idB = b._id != null ? b._id : b;
    if (!idA || !idB) return false;
    return String(idA) === String(idB);
}

/**
 * Diff → HR first, then Accounts (Zoho). No diff → Accounts → Zoho.
 * Never auto-marks Paid — Accounts still clicks Pay after Zoho is Open.
 *
 * needsHr: true when |contract − actual| (or a named diff share) > 0.01.
 */
function resolveStageAfterActor({
    actor,
    accounts,
    hr,
    from = 'submit',
    needsHr = true,
    hrAlreadyDone = false,
}) {
    const actorIsAccounts = isSameEmployee(actor, accounts);
    const actorIsHr = isSameEmployee(actor, hr);
    const hrRequired = needsHr !== false;
    const hrDone = hrAlreadyDone === true || actorIsHr;

    if (from === 'submit') {
        if (hrRequired && !hrDone) {
            return { status: 'Pending HR', pendingRole: 'hr', skipped: [] };
        }
        if (hrRequired && hrDone) {
            return { status: 'Pending Accounts', pendingRole: 'accounts', skipped: ['hr'] };
        }
        // No difference — skip HR; Accounts creates the Zoho bill.
        if (actorIsAccounts) {
            return {
                status: 'Approved',
                pendingRole: 'accounts',
                skipped: ['accounts', 'hr'],
            };
        }
        return { status: 'Pending Accounts', pendingRole: 'accounts', skipped: ['hr'] };
    }

    if (from === 'accounts_approve') {
        // Accounts creates Zoho. Only bounce to HR when a difference bill
        // landed here before HR has acted (legacy in-flight batches).
        if (hrRequired && !hrDone) {
            return { status: 'Pending HR', pendingRole: 'hr', skipped: [] };
        }
        return {
            status: 'Approved',
            pendingRole: 'accounts',
            skipped: hrRequired ? [] : ['hr'],
        };
    }

    // hr_approve → Accounts creates / opens the Zoho bill, then Pay.
    return { status: 'Pending Accounts', pendingRole: 'accounts', skipped: [] };
}

/**
 * HR is required when the bill has a real difference — named shares or
 * |contract − actual|. A stored 0 must not hide a contract vs actual gap.
 */
function billHasHrDifference(billOrRow = {}) {
    const monthly = Math.max(
        0,
        Number(
            billOrRow.monthlyRental ??
                billOrRow.contractAmount ??
                billOrRow.contract ??
                0,
        ) || 0,
    );
    const amount = Number(
        billOrRow.amount ?? billOrRow.actualAmount ?? billOrRow.actual ?? 0,
    );
    const named = [
        billOrRow.differenceAmount,
        billOrRow.difference,
        billOrRow.employeeDiffAmount,
        billOrRow.companyDiffAmount,
    ];
    if (named.some((v) => Number.isFinite(Number(v)) && Math.abs(Number(v)) > 0.01)) {
        return true;
    }
    if (!Number.isFinite(amount)) return false;
    return Math.abs(monthly - amount) > 0.01;
}

function batchNeedsHrApproval(billsOrRows = []) {
    return (billsOrRows || []).some((row) => billHasHrDifference(row));
}

function applyPaySplitToBills(bills, modeFallback = '') {
    const allowedPayBy = new Set([
        'company',
        'employee',
        'employee_and_company',
        'employee_balance',
    ]);
    let mode = String(modeFallback || bills[0]?.paymentBy || '').trim();
    if (!allowedPayBy.has(mode)) {
        mode = bills.every((b) => allowedPayBy.has(String(b.paymentBy || '')))
            ? String(bills[0].paymentBy)
            : '';
    }
    if (!mode) {
        return { ok: false, message: 'Pay by is required (company, employee, or employee and company).' };
    }
    for (const bill of bills) {
        const billMode = allowedPayBy.has(String(bill.paymentBy || ''))
            ? String(bill.paymentBy)
            : mode;
        bill.paymentBy = billMode === 'employee_balance' ? 'employee' : billMode;

        // Keep difference shares already set at submit / Accounts-HR edits (do not overwrite with full actual).
        const company = Number(bill.companyPayAmount);
        const employee = Number(bill.employeePayAmount);
        if (Number.isFinite(company) || Number.isFinite(employee)) {
            bill.companyPayAmount = Number.isFinite(company) ? company : 0;
            bill.employeePayAmount = Number.isFinite(employee) ? employee : 0;
            continue;
        }

        const split = computePaySplit(
            bill.amount,
            bill.monthlyRental,
            bill.paymentBy,
            bill.companyPayAmount,
            bill.employeePayAmount,
        );
        bill.companyPayAmount = split.companyPayAmount;
        bill.employeePayAmount = split.employeePayAmount;
    }
    return { ok: true, mode: bills[0]?.paymentBy || mode };
}

async function isActorAccountsOrAdmin(actor, reqUser) {
    const accounts = await getDepartmentHOD('accounts');
    const role = String(reqUser?.role || reqUser?.userType || '').toLowerCase();
    const isAdminUser = role.includes('admin') || role.includes('super');
    const isAccounts =
        Boolean(accounts?._id && actor?._id && String(accounts._id) === String(actor._id));
    return { accounts, isAccounts, isAdminUser, allowed: isAccounts || isAdminUser };
}

async function isActorHrOrAdmin(actor, reqUser) {
    const hr = await getDepartmentHOD('hr');
    const role = String(reqUser?.role || reqUser?.userType || '').toLowerCase();
    const isAdminUser = role.includes('admin') || role.includes('super');
    const isHr = Boolean(hr?._id && actor?._id && String(hr._id) === String(actor._id));
    return { hr, isHr, isAdminUser, allowed: isHr || isAdminUser };
}

/**
 * Same focus rules as getUtilityBillBatch — prefer the stage this actor can act on
 * so Accounts isn't blocked with "Only HR…" when Pending Accounts rows still exist.
 */
function resolveBatchStageStatus(bills = [], accountsGate, hrGate) {
    const list = Array.isArray(bills) ? bills : [];
    const focus =
        list.find((b) => b.status === 'Pending Accounts' && accountsGate?.allowed) ||
        list.find((b) => b.status === 'Pending HR' && hrGate?.allowed) ||
        list.find((b) => b.status === 'Pending Accounts') ||
        list.find((b) => b.status === 'Pending HR') ||
        list[0];
    return focus?.status || '';
}

async function syncBatchDashboard({
    batchId,
    bills,
    assignedTo,
    status = 'Pending',
    actionedBy = null,
    comment = '',
    extra2 = '',
    subjectEmployee = null,
    requestedByName = '',
}) {
    const first = bills[0];
    const total = bills.reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const utilityType = first?.utilityType || 'Utility';
    const billMonth = first?.billMonth || '';
    const path = reviewPath(batchId, utilityType, billMonth);

    // Complete any existing pending inbox rows for this batch so the previous
    // Accounts/HR actor's notification/task goes away after they act.
    await DashboardAction.updateMany(
        { requestId: batchId, requestType: REQUEST_TYPE, status: 'Pending' },
        {
            status: status === 'Rejected' ? 'Rejected' : 'Approved',
            actionedDate: new Date(),
            actionedBy: actionedBy || null,
            comment: comment || '',
        },
    );

    // Next assignee gets a fresh Pending task (skip if final / no assignee).
    if (status !== 'Pending' || !assignedTo) {
        return;
    }

    await syncDashboardAction({
        requestId: batchId,
        requestType: REQUEST_TYPE,
        status: 'Pending',
        assignedTo,
        actionedBy,
        comment,
        subjectEmployee,
        requestedByName: requestedByName || first?.requestedByName || '',
        extra1: `${utilityType} ${billMonth || ''} — ${bills.length} bill(s) · ${total.toLocaleString()} AED`.trim(),
        extra2: extra2 || statusLabel(first?.status, first?.pendingWithName),
        extra3: JSON.stringify({
            batchId: String(batchId),
            utilityType,
            billMonth,
            billCount: bills.length,
            detailsPath: path,
            reviewPath: path,
        }),
    });
}

/**
 * POST /api/UtilityBill/check-duplicates
 * Body: { items: [{ provider, billNumber, billId? }] }
 */
export async function checkUtilityBillDuplicates(req, res) {
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        const excludeIds = items
            .map((item) => String(item?.billId || item?._id || '').trim())
            .filter((id) => mongoose.Types.ObjectId.isValid(id));
        const results = await lookupVendorBillDuplicates(items, { excludeIds });
        return res.status(200).json({ results });
    } catch (err) {
        console.error('[checkUtilityBillDuplicates]', err);
        return res.status(500).json({ message: err.message || 'Failed to check duplicate bills.' });
    }
}

export async function listUtilityBillPayments(req, res) {
    try {
        const { entryId, batchId, utilityType, entryIds, payByEmployeeId, payByCompanyId, employeeId, companyId } =
            req.query;
        const actor = await resolveRequesterEmployee(req.user);
        const accountsGate = await isActorAccountsOrAdmin(actor, req.user);
        const hrGate = await isActorHrOrAdmin(actor, req.user);

        const withPermissions = (bill) => {
            const decorated = decorateBill(bill);
            const canApproveReject =
                (bill.status === 'Pending Accounts' && accountsGate.allowed) ||
                (bill.status === 'Pending HR' && hrGate.allowed);
            // Pay only after approve → not paid; Accounts flowchart user (or admin)
            const canPay = bill.status === 'Approved' && accountsGate.allowed;
            return { ...decorated, canApproveReject, canPay };
        };

        const syncBillsVendorPaymentFromZoho = async (bills, { entryId: syncEntryId = null } = {}) => {
            const linked = (bills || []).filter(
                (b) =>
                    (b.status === 'Approved' || b.status === 'Paid') &&
                    utilityBillHasZohoLink(b),
            );
            if (!syncEntryId && !linked.length) return bills;
            try {
                await syncApprovedUtilityBillsPaidFromZoho({
                    entryId: syncEntryId,
                    billIds: syncEntryId ? null : linked.map((b) => b._id),
                    userId: actor?._id || req.user?._id || null,
                    fetchLive: true,
                });
            } catch (syncErr) {
                console.warn(
                    '[listUtilityBillPayments] Zoho paid sync failed:',
                    syncErr?.message || syncErr,
                );
                return bills;
            }
            return null;
        };

        if (batchId) {
            let bills = await UtilityBillPayment.find({ batchId: String(batchId) })
                .sort({ createdAt: 1 })
                .lean();
            const synced = await syncBillsVendorPaymentFromZoho(bills);
            if (synced === null) {
                bills = await UtilityBillPayment.find({ batchId: String(batchId) })
                    .sort({ createdAt: 1 })
                    .lean();
            }
            const numbered = await attachZohoBillNumbers(bills, {
                persistModel: UtilityBillPayment,
                fetchLive: true,
            });
            return res.status(200).json({ bills: numbered.map(withPermissions) });
        }

        const filter = {};
        const partyEmployeeId = String(payByEmployeeId || employeeId || '').trim();
        const partyCompanyId = String(payByCompanyId || companyId || '').trim();

        if (entryId) {
            filter.entryId = String(entryId);
        } else if (entryIds) {
            const ids = String(entryIds)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (!ids.length) {
                return res.status(400).json({ message: 'entryIds is empty' });
            }
            filter.entryId = { $in: ids };
        } else if (utilityType) {
            filter.utilityType = String(utilityType).trim();
        } else if (partyEmployeeId) {
            const variants = await employeeIdQueryVariants(partyEmployeeId);
            const ids = variants.length ? variants : [partyEmployeeId];
            filter.$or = [
                { payByEmployeeId: { $in: ids } },
                { 'zohoLineItems.payByEmployeeId': { $in: ids } },
            ];
        } else if (partyCompanyId) {
            const ids = new Set([partyCompanyId]);
            const query = /^[0-9a-fA-F]{24}$/.test(partyCompanyId)
                ? { _id: partyCompanyId }
                : { companyId: partyCompanyId };
            const company = await Company.findOne(query).select('_id companyId').lean();
            if (company?._id) ids.add(String(company._id));
            if (company?.companyId) ids.add(String(company.companyId));
            const list = [...ids];
            filter.$or = [
                { payByCompanyId: { $in: list } },
                { 'zohoLineItems.payByCompanyId': { $in: list } },
            ];
        } else {
            return res.status(400).json({
                message:
                    'entryId, entryIds, utilityType, batchId, payByEmployeeId, or payByCompanyId is required',
            });
        }

        let bills = await UtilityBillPayment.find(filter)
            .populate('accountsApprovedBy', 'firstName lastName employeeId')
            .populate('hrApprovedBy', 'firstName lastName employeeId')
            .populate('actionedBy', 'firstName lastName employeeId')
            .sort({ createdAt: -1 })
            .lean();

        const syncEntryId = entryId ? String(entryId) : null;
        const synced = await syncBillsVendorPaymentFromZoho(bills, { entryId: syncEntryId });
        if (synced === null) {
            bills = await UtilityBillPayment.find(filter)
                .populate('accountsApprovedBy', 'firstName lastName employeeId')
                .populate('hrApprovedBy', 'firstName lastName employeeId')
                .populate('actionedBy', 'firstName lastName employeeId')
                .sort({ createdAt: -1 })
                .lean();
        }

        const numbered = await attachZohoBillNumbers(bills, {
            persistModel: UtilityBillPayment,
            fetchLive: true,
        });
        return res.status(200).json({ bills: numbered.map(withPermissions) });
    } catch (err) {
        return res.status(500).json({ message: err.message || 'Failed to load bills' });
    }
}

export async function getUtilityBillBatch(req, res) {
    try {
        const { batchId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(batchId)) {
            return res.status(400).json({ message: 'Invalid batchId' });
        }

        let bills = await UtilityBillPayment.find({ batchId })
            .sort({ createdAt: 1 })
            .lean();

        // Inbox/links sometimes pass a single bill _id — resolve its batch (or return that bill alone).
        if (!bills.length) {
            const single = await UtilityBillPayment.findById(batchId).lean();
            if (single?.batchId) {
                bills = await UtilityBillPayment.find({ batchId: single.batchId })
                    .sort({ createdAt: 1 })
                    .lean();
            } else if (single) {
                bills = [single];
            }
        }

        if (!bills.length) {
            return res.status(404).json({ message: 'Batch not found' });
        }

        // Sync Vendor Payment status from Zoho for Approved/Paid bills in this batch.
        try {
            const linkedIds = bills
                .filter(
                    (b) =>
                        (b.status === 'Approved' || b.status === 'Paid') &&
                        utilityBillHasZohoLink(b),
                )
                .map((b) => b._id);
            if (linkedIds.length) {
                await syncApprovedUtilityBillsPaidFromZoho({
                    billIds: linkedIds,
                    userId: req.user?._id || null,
                    fetchLive: true,
                });
                const batchKey = bills[0]?.batchId || batchId;
                bills = await UtilityBillPayment.find(
                    mongoose.Types.ObjectId.isValid(String(batchKey))
                        ? { batchId: batchKey }
                        : { _id: { $in: bills.map((b) => b._id) } },
                )
                    .sort({ createdAt: 1 })
                    .lean();
            }
        } catch (syncErr) {
            console.warn(
                '[getUtilityBillBatch] Zoho paid sync failed:',
                syncErr?.message || syncErr,
            );
        }

        const actor = await resolveRequesterEmployee(req.user);
        const accountsGate = await isActorAccountsOrAdmin(actor, req.user);
        const hrGate = await isActorHrOrAdmin(actor, req.user);

        // Prefer a stage this user can act on (mixed-status batches after partial approve)
        const focus =
            bills.find((b) => b.status === 'Pending Accounts' && accountsGate.allowed) ||
            bills.find((b) => b.status === 'Pending HR' && hrGate.allowed) ||
            bills.find((b) => b.status === 'Approved' && accountsGate.allowed) ||
            bills.find((b) => b.status === 'Pending Accounts') ||
            bills.find((b) => b.status === 'Pending HR') ||
            bills.find((b) => b.status === 'Approved') ||
            bills[0];

        const stageStatus = focus.status;
        const canEditAccounts = stageStatus === 'Pending Accounts' && accountsGate.allowed;
        const canEditHr = stageStatus === 'Pending HR' && hrGate.allowed;
        const canEdit = Boolean(canEditAccounts || canEditHr);
        // Approved = not paid; Accounts may Pay only when Zoho bill is Open (not Draft).
        const hasZohoDraft = bills.some(
            (b) =>
                String(b.status) === 'Approved' &&
                String(b.zohoBillStatus || '').toLowerCase() === 'draft',
        );
        const canPay =
            stageStatus === 'Approved' && accountsGate.allowed && !hasZohoDraft;
        const canApproveReject = canEdit;
        const needsZohoOpen = hasZohoDraft && (accountsGate.allowed || hrGate.allowed);

        const paidCount = bills.filter((b) => b.status === 'Paid').length;
        const approvedCount = bills.filter((b) => b.status === 'Approved').length;
        let batchStatusLabel = statusLabel(stageStatus, focus.pendingWithName);
        if (paidCount > 0 && approvedCount > 0) {
            batchStatusLabel = 'partially paid';
        } else if (paidCount > 0 && approvedCount === 0 && canPay === false) {
            const stillPending = bills.some((b) =>
                ['Pending Accounts', 'Pending HR'].includes(String(b.status)),
            );
            if (!stillPending) batchStatusLabel = 'paid';
        }

        const resolvedBatchId = String(focus.batchId || batchId);
        return res.status(200).json({
            batchId: resolvedBatchId,
            utilityType: focus.utilityType,
            billMonth: focus.billMonth,
            status: stageStatus,
            statusLabel: hasZohoDraft
                ? 'Zoho Draft — open before pay'
                : batchStatusLabel,
            pendingWithName: focus.pendingWithName,
            pendingWithRole: focus.pendingWithRole,
            /** Edit/approve only for the flowchart user the batch is pending with */
            canEdit,
            canApproveReject,
            canPay,
            needsZohoOpen,
            actorIsAccounts: Boolean(accountsGate.isAccounts || accountsGate.isAdminUser),
            actorIsHr: Boolean(hrGate.isHr || hrGate.isAdminUser),
            bills: (
                await attachZohoBillNumbers(bills, {
                    persistModel: UtilityBillPayment,
                    fetchLive: true,
                })
            ).map(decorateBill),
            reviewPath: reviewPath(resolvedBatchId, focus.utilityType, focus.billMonth),
        });
    } catch (err) {
        console.error('[getUtilityBillBatch]', err);
        return res.status(500).json({ message: err.message || 'Failed to load batch' });
    }
}

/**
 * Submit: difference → Pending HR; no difference → Pending Accounts (Zoho).
 * HR approve → Accounts creates Zoho. HR reject → Rejected.
 * No difference → Accounts creates Zoho directly. Pay is never auto-skipped.
 */
export async function createUtilityBillBatch(req, res) {
    try {
        const { utilityType, billMonth = '', notes = '', rows = [] } = req.body || {};
        if (!utilityType || !Array.isArray(rows) || !rows.length) {
            return res.status(400).json({ message: 'utilityType and rows are required' });
        }

        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) {
            return res.status(400).json({
                message: 'Accounts responsible person is not configured in Flowchart.',
            });
        }
        const hr = await getDepartmentHOD('hr');
        if (!hr?._id) {
            return res.status(400).json({
                message: 'HR responsible person is not configured in Flowchart.',
            });
        }

        const requester = await resolveRequesterEmployee(req.user);
        const requestedByName = requesterDisplayName(requester, req.user);
        const batchId = new mongoose.Types.ObjectId();
        const accountsName = empDisplayName(accounts);
        const hrName = empDisplayName(hr);
        const now = new Date();

        const needsHr = batchNeedsHrApproval(rows);
        const stage = resolveStageAfterActor({
            actor: requester,
            accounts,
            hr,
            from: 'submit',
            needsHr,
        });

        const modalDuplicate = findCurrentBatchVendorBillDuplicate(rows);
        if (modalDuplicate) {
            return res.status(400).json({ message: modalDuplicate.message });
        }
        const remoteDuplicates = await lookupVendorBillDuplicates(rows);
        const remoteHit = remoteDuplicates.find((row) => row.source);
        if (remoteHit) {
            return res.status(400).json({ message: remoteHit.message });
        }

        let pendingWithName = accountsName;
        let pendingWithRole = 'accounts';
        if (stage.status === 'Pending HR') {
            pendingWithName = hrName;
            pendingWithRole = 'hr';
        } else if (stage.status === 'Approved') {
            pendingWithName = accountsName;
            pendingWithRole = 'accounts';
        }

        const docs = [];
        for (const row of rows) {
            const entryId = row.entryId;
            const amt = Number(row.actualAmount ?? row.amount);
            if (!entryId || !Number.isFinite(amt) || amt < 0) {
                return res.status(400).json({ message: 'Each row needs entryId and a valid amount.' });
            }
            const monthly = Math.max(0, Number(row.contractAmount ?? row.monthlyRental) || 0);
            const diff =
                Number.isFinite(Number(row.difference ?? row.differenceAmount))
                    ? Number(row.difference ?? row.differenceAmount)
                    : monthly - amt;
            const payBy = String(row.payBy || '').trim();
            const underDiff = Math.max(0, monthly - amt);
            const overage = Math.max(0, amt - monthly);
            let companyDiff = Number(row.companyDiffAmount);
            let employeeDiff = Number(row.employeeDiffAmount);
            if (!Number.isFinite(companyDiff) || !Number.isFinite(employeeDiff)) {
                if (payBy === 'company') {
                    companyDiff = underDiff;
                    employeeDiff = 0;
                } else if (payBy === 'employee' || payBy === 'employee_balance') {
                    companyDiff = 0;
                    employeeDiff = underDiff;
                } else {
                    companyDiff = 0;
                    employeeDiff = 0;
                }
            }
            // Prefer TOTAL company/employee pay amounts from the client (TOTAL bar)
            let companyAmt = Number(row.companyPayAmount);
            let employeeAmt = Number(row.employeePayAmount);
            if (!Number.isFinite(companyAmt) || !Number.isFinite(employeeAmt)) {
                const employeeOverage =
                    payBy === 'employee' || payBy === 'employee_balance' || payBy === 'employee_and_company'
                        ? overage
                        : 0;
                companyAmt = Math.max(0, amt + companyDiff - employeeOverage);
                employeeAmt = Math.max(0, employeeDiff + employeeOverage);
            }
            const paymentByStored =
                payBy === 'company' || payBy === 'employee' || payBy === 'employee_and_company'
                    ? payBy
                    : undefined;

            const provider = String(row.provider || '').trim();
            const billNumber = String(row.billNumber || '').trim();
            const expenseAccountId = String(row.expenseAccountId || '').trim();
            const expenseAccountName = String(row.expenseAccountName || '').trim();
            const partyAccountId = String(row.partyAccountId || '').trim();
            const partyAccountName = String(row.partyAccountName || '').trim();
            const partyAccountCode = String(row.partyAccountCode || '').trim();
            const rawLineItems = Array.isArray(row.lineItems)
                ? row.lineItems
                : Array.isArray(row.zohoLineItems)
                  ? row.zohoLineItems
                  : [];
            const zohoLineItems = rawLineItems
                .map((line) => {
                    const accountId = String(line?.accountId || line?.account_id || '').trim();
                    const amount = Number(line?.amount);
                    const qtyRaw = Number(line?.quantity);
                    const quantity =
                        Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
                    const rateRaw = Number(line?.rate);
                    const rate =
                        Number.isFinite(rateRaw) && rateRaw > 0
                            ? rateRaw
                            : quantity > 0 && Number.isFinite(amount)
                              ? Number((amount / quantity).toFixed(2))
                              : Number.isFinite(amount)
                                ? amount
                                : 0;
                    if (!accountId || !Number.isFinite(amount) || amount <= 0) return null;
                    const payByEmployeeId = String(line?.payByEmployeeId || '').trim();
                    const payByCompanyId = String(line?.payByCompanyId || '').trim();
                    let linePayBy = String(line?.payBy || '').trim();
                    if (linePayBy !== 'company' && linePayBy !== 'employee') {
                        linePayBy = payByEmployeeId ? 'employee' : payByCompanyId ? 'company' : '';
                    }
                    return {
                        item: String(line?.item || line?.description || '').trim(),
                        description: String(
                            line?.description || line?.item || '',
                        ).trim(),
                        accountId,
                        accountName: String(line?.accountName || '').trim(),
                        quantity,
                        amount: Number(amount.toFixed(2)),
                        rate: Number(rate.toFixed(2)),
                        payBy: linePayBy,
                        payByEmployeeId,
                        payByEmployeeName: String(line?.payByEmployeeName || '').trim(),
                        payByCompanyId,
                        payByCompanyName: String(line?.payByCompanyName || '').trim(),
                        zohoBillId: String(line?.zohoBillId || '').trim(),
                    };
                })
                .filter(Boolean);
            if (zohoLineItems.length) {
                const linesTotal = zohoLineItems.reduce((sum, line) => sum + line.amount, 0);
                if (Math.abs(linesTotal - amt) > 0.05) {
                    return res.status(400).json({
                        message: `Item line amounts for account ${row.accountNo || entryId} must equal Actual (${amt}).`,
                    });
                }
            }
            const paymentDayRaw = Number(row.paymentDay ?? row.paymentDate);
            const paymentDay =
                Number.isInteger(paymentDayRaw) && paymentDayRaw >= 1 && paymentDayRaw <= 31
                    ? paymentDayRaw
                    : null;
            const billDate =
                String(row.billDate || '').trim() ||
                utilityBillDateFromMonth(billMonth, paymentDay ?? 16);

            if (!billNumber) {
                return res.status(400).json({
                    message: `Bill number is required for account ${row.accountNo || entryId}.`,
                });
            }
            if (!expenseAccountId) {
                return res.status(400).json({
                    message: 'Expense account is required to create the Zoho bill after HR approval.',
                });
            }
            // Difference Acc2 is optional. Zoho bill debit uses Account from Add more / line prices.
            if (!provider) {
                return res.status(400).json({
                    message: `Provider is required for account ${row.accountNo || entryId} (maps to Zoho vendor).`,
                });
            }
            if (!billDate) {
                return res.status(400).json({
                    message:
                        'Bill date could not be built. Set Payment Day (1–31) on the utility entry and bill month.',
                });
            }

            let zohoVendorId = String(row.zohoVendorId || '').trim();
            if (!zohoVendorId) {
                try {
                    zohoVendorId = await resolveZohoVendorIdByProvider(provider);
                } catch (vendorErr) {
                    console.warn(
                        '[createUtilityBillBatch] Zoho vendor lookup failed:',
                        vendorErr?.message || vendorErr,
                    );
                }
            }

            const doc = {
                entryId: String(entryId),
                utilityType: String(utilityType).trim(),
                amount: amt,
                monthlyRental: monthly,
                billMonth: String(billMonth || ''),
                notes: String(notes || ''),
                accountNo: String(row.accountNo || ''),
                differenceAmount: diff,
                attachment: attachmentPayload(row.attachment),
                batchId,
                status: stage.status,
                pendingWithName,
                pendingWithRole,
                companyPayAmount: companyAmt,
                employeePayAmount: employeeAmt,
                companyDiffAmount: companyDiff,
                employeeDiffAmount: employeeDiff,
                provider,
                billNumber,
                billDate,
                paymentDay,
                expenseAccountId,
                expenseAccountName,
                partyAccountId,
                partyAccountName,
                partyAccountCode,
                zohoLineItems,
                zohoVendorId,
                ...payByPartyFromRow(row),
                requestedBy: requester?._id || null,
                requestedByName,
            };
            // Omit unset paymentBy — mongoose enum rejects explicit `undefined`/`''`.
            if (paymentByStored) doc.paymentBy = paymentByStored;

            // Record auto-skipped approvals when submitter is that role
            if (stage.skipped.includes('accounts')) {
                doc.accountsApprovedBy = requester?._id || null;
                doc.accountsApprovedAt = now;
                doc.comment = 'Accounts step skipped (submitter is Accounts)';
            }
            if (stage.skipped.includes('hr')) {
                doc.hrApprovedBy = requester?._id || null;
                doc.hrApprovedAt = now;
                doc.comment = stage.skipped.includes('accounts')
                    ? 'Accounts & HR skipped (submitter is Accounts; no difference) — Zoho / awaiting Pay'
                    : needsHr
                      ? 'HR step skipped (submitter is HR) — sent to Accounts for Zoho'
                      : 'HR skipped (no difference) — sent to Accounts for Zoho';
            }

            docs.push(doc);
        }

        // Ensure pay split ready when landing on Approved
        if (stage.status === 'Approved') {
            const splitCheck = applyPaySplitToBills(docs, docs[0]?.paymentBy);
            if (!splitCheck.ok) {
                return res.status(400).json({ message: splitCheck.message });
            }
        }

        const bills = await UtilityBillPayment.insertMany(docs);
        let zohoSync = null;
        if (stage.status === 'Approved') {
            zohoSync = await syncApprovedUtilityBillsToZoho(bills, { markAsOpen: true });
            try {
                await upsertUtilityBalancePartyExpensesFromBills(
                    bills,
                    requester?._id || req.user?._id || null,
                );
            } catch (balanceErr) {
                console.warn(
                    '[createUtilityBillBatch] PartyExpense balance upsert failed:',
                    balanceErr?.message || balanceErr,
                );
            }
            const zohoOk = bills.some(
                (b) =>
                    String(b.zohoBillId || '').trim() ||
                    String(b.zohoBillStatus || '').toLowerCase() === 'open',
            );
            if (zohoOk) {
                // Notify Payable-to employees after Zoho entry (best-effort).
                notifyUtilityBillZohoPayableParties({
                    bills,
                    batchMeta: {
                        batchId: String(batchId),
                        billCount: bills.length,
                        reviewPath: reviewPath(batchId, utilityType, billMonth),
                    },
                }).catch((err) =>
                    console.warn(
                        '[createUtilityBillBatch] Zoho payable notify failed:',
                        err?.message || err,
                    ),
                );
            }
        }
        const leanBills = bills.map((b) => b.toObject());
        const path = reviewPath(batchId, utilityType, billMonth);
        const totalAmount = leanBills.reduce((s, b) => s + Number(b.amount || 0), 0);

        if (stage.status === 'Pending Accounts') {
            await syncBatchDashboard({
                batchId,
                bills: leanBills,
                assignedTo: accounts._id,
                status: 'Pending',
                subjectEmployee: requester,
                requestedByName,
                extra2: statusLabel('Pending Accounts', accountsName),
            });
            await sendUtilityBillPaymentEmail({
                recipient: accounts,
                bill: { ...leanBills[0], amount: totalAmount },
                kind: 'pending_accounts',
                batchMeta: { batchId: String(batchId), billCount: leanBills.length, reviewPath: path },
            });
        } else if (stage.status === 'Pending HR') {
            await syncBatchDashboard({
                batchId,
                bills: leanBills,
                assignedTo: hr._id,
                status: 'Pending',
                subjectEmployee: requester,
                requestedByName,
                extra2: statusLabel('Pending HR', hrName),
            });
            await sendUtilityBillPaymentEmail({
                recipient: hr,
                bill: { ...leanBills[0], amount: totalAmount },
                kind: 'pending_hr',
                batchMeta: { batchId: String(batchId), billCount: leanBills.length, reviewPath: path },
            });
        } else {
            // Approved — awaiting Accounts pay
            await syncBatchDashboard({
                batchId,
                bills: leanBills,
                assignedTo: accounts._id,
                status: 'Pending',
                subjectEmployee: requester,
                requestedByName,
                extra2: 'not paid — awaiting Accounts payment',
            });
            await sendUtilityBillPaymentEmail({
                recipient: accounts,
                bill: { ...leanBills[0], amount: totalAmount },
                kind: 'pending_pay',
                batchMeta: { batchId: String(batchId), billCount: leanBills.length, reviewPath: path },
            });
        }

        return res.status(201).json({
            batchId: String(batchId),
            bills: leanBills.map(decorateBill),
            status: stage.status,
            statusLabel:
                stage.status === 'Approved'
                    ? 'not paid'
                    : statusLabel(stage.status, pendingWithName),
            reviewPath: path,
            sentToAccounts: stage.status === 'Pending Accounts',
            skippedStages: stage.skipped,
            zohoSync,
        });
    } catch (err) {
        console.error('[createUtilityBillBatch]', err);
        return res.status(500).json({ message: err.message || 'Failed to submit bills' });
    }
}

/** @deprecated single-row create — routes to batch of one */
export async function createUtilityBillPayment(req, res) {
    const body = req.body || {};
    req.body = {
        utilityType: body.utilityType,
        billMonth: body.billMonth,
        notes: body.notes,
        rows: [
            {
                entryId: body.entryId,
                actualAmount: body.amount,
                contractAmount: body.monthlyRental,
                accountNo: body.accountNo,
                differenceAmount: body.differenceAmount,
                attachment: body.attachment,
            },
        ],
    };
    return createUtilityBillBatch(req, res);
}

function applyRowEdits(bills, rowUpdates = []) {
    if (!Array.isArray(rowUpdates) || !rowUpdates.length) return;
    const byId = new Map(rowUpdates.map((r) => [String(r.billId || r._id || ''), r]));
    for (const bill of bills) {
        const patch = byId.get(String(bill._id));
        if (!patch) continue;
        if (patch.actualAmount != null || patch.amount != null) {
            const amt = Number(patch.actualAmount ?? patch.amount);
            if (Number.isFinite(amt) && amt >= 0) bill.amount = amt;
        }
        if (patch.contractAmount != null || patch.monthlyRental != null) {
            const m = Number(patch.contractAmount ?? patch.monthlyRental);
            if (Number.isFinite(m) && m >= 0) bill.monthlyRental = m;
        }
        if (patch.accountNo != null) bill.accountNo = String(patch.accountNo);
        if (patch.difference != null || patch.differenceAmount != null) {
            const d = Number(patch.difference ?? patch.differenceAmount);
            if (Number.isFinite(d)) bill.differenceAmount = d;
        } else {
            // Contract − Actual = Difference
            bill.differenceAmount = Number(bill.monthlyRental || 0) - Number(bill.amount || 0);
        }
        if (patch.attachment) {
            bill.attachment = attachmentPayload(patch.attachment);
        }
        const payBy = String(patch.payBy || patch.paymentBy || '').trim();
        if (
            payBy === 'company' ||
            payBy === 'employee' ||
            payBy === 'employee_and_company' ||
            payBy === 'employee_balance'
        ) {
            bill.paymentBy = payBy === 'employee_balance' ? 'employee' : payBy;
        }
        if (patch.payByCompanyId != null) bill.payByCompanyId = String(patch.payByCompanyId || '');
        if (patch.payByCompanyName != null) {
            bill.payByCompanyName = String(patch.payByCompanyName || '');
        }
        if (patch.payByEmployeeId != null) {
            bill.payByEmployeeId = String(patch.payByEmployeeId || '');
        }
        if (patch.payByEmployeeName != null) {
            bill.payByEmployeeName = String(patch.payByEmployeeName || '');
        }
        // Diff shares for Pay By UI
        if (patch.companyDiffAmount != null) {
            const c = Number(patch.companyDiffAmount);
            if (Number.isFinite(c)) bill.companyDiffAmount = c;
        }
        if (patch.employeeDiffAmount != null) {
            const e = Number(patch.employeeDiffAmount);
            if (Number.isFinite(e)) bill.employeeDiffAmount = e;
        }
        // Totals (TOTAL bar) — never overwrite totals with diff shares
        if (patch.companyPayAmount != null) {
            const c = Number(patch.companyPayAmount);
            if (Number.isFinite(c)) bill.companyPayAmount = c;
        }
        if (patch.employeePayAmount != null) {
            const e = Number(patch.employeePayAmount);
            if (Number.isFinite(e)) bill.employeePayAmount = e;
        }
        if (patch.expenseAccountId != null) {
            bill.expenseAccountId = String(patch.expenseAccountId || '');
        }
        if (patch.expenseAccountName != null) {
            bill.expenseAccountName = String(patch.expenseAccountName || '');
        }
        if (patch.partyAccountId != null) {
            bill.partyAccountId = String(patch.partyAccountId || '');
        }
        if (patch.partyAccountName != null) {
            bill.partyAccountName = String(patch.partyAccountName || '');
        }
        if (patch.partyAccountCode != null) {
            bill.partyAccountCode = String(patch.partyAccountCode || '');
        }
        if (patch.billNumber != null) {
            bill.billNumber = String(patch.billNumber || '').trim();
        }
        if (patch.billDate != null) {
            bill.billDate = String(patch.billDate || '').trim();
        }
        if (patch.provider != null) {
            bill.provider = String(patch.provider || '').trim();
        }
        if (Array.isArray(patch.lineItems) || Array.isArray(patch.zohoLineItems)) {
            const rawLineItems = Array.isArray(patch.lineItems)
                ? patch.lineItems
                : patch.zohoLineItems;
            const zohoLineItems = rawLineItems
                .map((line) => {
                    const accountId = String(line?.accountId || line?.account_id || '').trim();
                    const amount = Number(line?.amount);
                    const qtyRaw = Number(line?.quantity);
                    const quantity =
                        Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
                    const rateRaw = Number(line?.rate);
                    const rate =
                        Number.isFinite(rateRaw) && rateRaw > 0
                            ? rateRaw
                            : quantity > 0 && Number.isFinite(amount)
                              ? Number((amount / quantity).toFixed(2))
                              : Number.isFinite(amount)
                                ? amount
                                : 0;
                    if (!accountId || !Number.isFinite(amount) || amount <= 0) return null;
                    const payByEmployeeId = String(line?.payByEmployeeId || '').trim();
                    const payByCompanyId = String(line?.payByCompanyId || '').trim();
                    let linePayBy = String(line?.payBy || '').trim();
                    if (linePayBy !== 'company' && linePayBy !== 'employee') {
                        linePayBy = payByEmployeeId
                            ? 'employee'
                            : payByCompanyId
                              ? 'company'
                              : '';
                    }
                    return {
                        item: String(line?.item || line?.description || '').trim(),
                        description: String(line?.description || line?.item || '').trim(),
                        accountId,
                        accountName: String(line?.accountName || '').trim(),
                        quantity,
                        amount: Number(amount.toFixed(2)),
                        rate: Number(rate.toFixed(2)),
                        payBy: linePayBy,
                        payByEmployeeId,
                        payByEmployeeName: String(line?.payByEmployeeName || '').trim(),
                        payByCompanyId,
                        payByCompanyName: String(line?.payByCompanyName || '').trim(),
                        zohoBillId: '',
                    };
                })
                .filter(Boolean);
            if (zohoLineItems.length) {
                bill.zohoLineItems = zohoLineItems;
                if (!bill.expenseAccountId && zohoLineItems[0]?.accountId) {
                    bill.expenseAccountId = zohoLineItems[0].accountId;
                    bill.expenseAccountName = zohoLineItems[0].accountName || '';
                }
            }
        }

        // Zoho invalidation is handled by updateUtilityBillBatch (Accounts Edit).
    }
}

/**
 * Accounts / HR edit bill details before Pay (same fields as Add Bills).
 * Clears Zoho bill ids so sync recreates with updated expense accounts.
 */
export async function updateUtilityBillBatch(req, res) {
    try {
        const { batchId } = req.params;
        const { rows = [] } = req.body || {};
        if (!mongoose.Types.ObjectId.isValid(batchId)) {
            return res.status(400).json({ message: 'Invalid batchId' });
        }
        if (!Array.isArray(rows) || !rows.length) {
            return res.status(400).json({ message: 'rows are required' });
        }

        const actor = await resolveRequesterEmployee(req.user);
        const accountsGate = await isActorAccountsOrAdmin(actor, req.user);
        const hrGate = await isActorHrOrAdmin(actor, req.user);
        if (!accountsGate.allowed && !hrGate.allowed) {
            return res.status(403).json({
                message: 'Only Accounts or HR can edit utility bill details.',
            });
        }

        const bills = await UtilityBillPayment.find({
            batchId,
            status: { $in: ['Pending Accounts', 'Pending HR', 'Approved'] },
        });
        if (!bills.length) {
            return res.status(404).json({
                message: 'No editable bills found for this batch (Paid bills cannot be edited).',
            });
        }

        const modalDuplicate = findCurrentBatchVendorBillDuplicate(rows);
        if (modalDuplicate) {
            return res.status(400).json({ message: modalDuplicate.message });
        }
        const remoteDuplicates = await lookupVendorBillDuplicates(rows, {
            excludeIds: bills.map((bill) => bill._id),
        });
        const remoteHit = remoteDuplicates.find((row) => row.source);
        if (remoteHit) {
            return res.status(400).json({ message: remoteHit.message });
        }

        applyRowEdits(bills, rows);
        for (const bill of bills) {
            // Invalidate prior Zoho bill so Retry / Pay recreates with updated accounts.
            bill.zohoBillId = '';
            bill.zohoBillIds = [];
            bill.zohoBillStatus = '';
            bill.zohoSyncError = '';
            bill.zohoSyncedAt = null;
            if (Array.isArray(bill.zohoLineItems)) {
                bill.zohoLineItems.forEach((line) => {
                    if (line && typeof line === 'object') line.zohoBillId = '';
                });
            }
            await bill.save();
        }

        const refreshed = await UtilityBillPayment.find({ batchId }).lean();
        return res.status(200).json({
            batchId,
            updatedCount: bills.length,
            bills: refreshed.map((b) => decorateBill(b)),
            message: 'Bill details saved. Retry Zoho sync or Pay to store the updated bill.',
        });
    } catch (err) {
        console.error('[updateUtilityBillBatch]', err);
        return res.status(500).json({ message: err.message || 'Failed to update bills' });
    }
}

/**
 * Resolve bills to act on from selected review rows.
 * - Existing selected billIds
 * - Newly checked accounts (entryId without billId) are inserted into the batch
 * - Unchecked existing bills stay at their current stage (not rejected/approved)
 */
async function resolveSelectedBillsForRespond({
    batchId,
    allBills,
    rows,
    stageStatus,
    allowCreate = true,
}) {
    const template = allBills[0];
    if (!Array.isArray(rows) || !rows.length) {
        return allBills.filter((b) => b.status === stageStatus);
    }

    const selectedWithId = rows.filter((r) => r.billId || r._id);
    const selectedNew = allowCreate
        ? rows.filter((r) => !r.billId && !r._id && r.entryId)
        : [];
    const idSet = new Set(selectedWithId.map((r) => String(r.billId || r._id)));

    const existing = allBills.filter(
        (b) => b.status === stageStatus && idSet.has(String(b._id)),
    );

    const created = [];
    for (const row of selectedNew) {
        const amt = Number(row.actualAmount ?? row.amount);
        if (!Number.isFinite(amt) || amt < 0) {
            throw new Error(`Invalid actual amount for account ${row.accountNo || row.entryId}.`);
        }
        const monthly = Math.max(0, Number(row.contractAmount ?? row.monthlyRental) || 0);
        const diff =
            Number.isFinite(Number(row.difference ?? row.differenceAmount))
                ? Number(row.difference ?? row.differenceAmount)
                : monthly - amt;
        const payBy = String(row.payBy || row.paymentBy || '').trim();
        const underDiff = Math.max(0, monthly - amt);
        const overage = Math.max(0, amt - monthly);
        let companyDiff = Number(row.companyDiffAmount);
        let employeeDiff = Number(row.employeeDiffAmount);
        if (!Number.isFinite(companyDiff) || !Number.isFinite(employeeDiff)) {
            if (payBy === 'company') {
                companyDiff = underDiff;
                employeeDiff = 0;
            } else if (payBy === 'employee' || payBy === 'employee_balance') {
                companyDiff = 0;
                employeeDiff = underDiff;
            } else {
                companyDiff = 0;
                employeeDiff = 0;
            }
        }
        let companyAmt = Number(row.companyPayAmount);
        let employeeAmt = Number(row.employeePayAmount);
        if (!Number.isFinite(companyAmt) || !Number.isFinite(employeeAmt)) {
            const employeeOverage =
                payBy === 'employee' || payBy === 'employee_balance' || payBy === 'employee_and_company'
                    ? overage
                    : 0;
            companyAmt = Math.max(0, amt + companyDiff - employeeOverage);
            employeeAmt = Math.max(0, employeeDiff + employeeOverage);
        }
        const doc = {
            entryId: String(row.entryId),
            utilityType: template.utilityType,
            amount: amt,
            monthlyRental: monthly,
            billMonth: template.billMonth || '',
            notes: template.notes || '',
            accountNo: String(row.accountNo || ''),
            differenceAmount: diff,
            attachment: attachmentPayload(row.attachment),
            batchId: template.batchId,
            status: stageStatus,
            pendingWithName: template.pendingWithName || '',
            pendingWithRole: template.pendingWithRole || '',
            companyPayAmount: companyAmt,
            employeePayAmount: employeeAmt,
            companyDiffAmount: companyDiff,
            employeeDiffAmount: employeeDiff,
            ...payByPartyFromRow(row),
            requestedBy: template.requestedBy || null,
            requestedByName: template.requestedByName || '',
        };
        if (
            payBy === 'company' ||
            payBy === 'employee' ||
            payBy === 'employee_and_company' ||
            payBy === 'employee_balance'
        ) {
            doc.paymentBy = payBy === 'employee_balance' ? 'employee' : payBy;
        }
        created.push(await UtilityBillPayment.create(doc));
    }

    const selected = [...existing, ...created];
    if (!selected.length) {
        throw new Error('Select at least one account.');
    }
    return selected;
}

/**
 * Difference → HR first; HR approve → Accounts (Zoho). HR reject → Rejected.
 * No difference → Accounts approve creates Zoho (Pay is a separate Accounts click).
 */
export async function respondUtilityBillBatch(req, res) {
    try {
        const { batchId } = req.params;
        const { decision, comment = '', paymentBy = null, rows = [] } = req.body || {};
        const action = String(decision || '').toLowerCase();
        if (!['approve', 'reject', 'draft'].includes(action)) {
            return res.status(400).json({ message: 'decision must be approve, reject, or draft' });
        }
        if (!mongoose.Types.ObjectId.isValid(batchId)) {
            return res.status(400).json({ message: 'Invalid batchId' });
        }

        const allBills = await UtilityBillPayment.find({ batchId });
        if (!allBills.length) return res.status(404).json({ message: 'Batch not found' });

        const actor = await resolveRequesterEmployee(req.user);
        const accountsGateEarly = await isActorAccountsOrAdmin(actor, req.user);
        const hrGateEarly = await isActorHrOrAdmin(actor, req.user);

        const stageStatus = resolveBatchStageStatus(
            allBills,
            accountsGateEarly,
            hrGateEarly,
        );
        if (!['Pending Accounts', 'Pending HR'].includes(stageStatus)) {
            return res.status(400).json({
                message: `Batch is not awaiting approval (current: ${allBills[0].status}).`,
            });
        }

        let bills;
        try {
            bills = await resolveSelectedBillsForRespond({
                batchId,
                allBills,
                rows,
                stageStatus,
                allowCreate: action === 'approve' || action === 'draft',
            });
        } catch (selErr) {
            return res.status(400).json({ message: selErr.message || 'Invalid selection.' });
        }

        if (action === 'draft' && stageStatus !== 'Pending HR') {
            return res.status(400).json({
                message: 'Draft to Zoho is only available at the HR review stage.',
            });
        }

        const requester = allBills[0].requestedBy
            ? await EmployeeBasic.findById(allBills[0].requestedBy)
                  .select('firstName lastName companyEmail workEmail personalEmail email employeeId')
                  .lean()
            : null;

        if (stageStatus === 'Pending Accounts') {
            const gate = accountsGateEarly;
            if (!gate.allowed) {
                return res.status(403).json({
                    message: `Only Accounts (${empDisplayName(gate.accounts) || 'flowchart Accounts'}) can respond at this stage.`,
                });
            }

            if (action === 'reject') {
                // Accounts reject → return to creator (final Rejected).
                for (const bill of bills) {
                    bill.status = 'Rejected';
                    bill.pendingWithName = '';
                    bill.pendingWithRole = '';
                    bill.accountsApprovedBy = null;
                    bill.accountsApprovedAt = null;
                    bill.hrApprovedBy = null;
                    bill.hrApprovedAt = null;
                    bill.actionedBy = actor?._id || null;
                    bill.actionedAt = new Date();
                    bill.comment =
                        comment ||
                        'Rejected by Accounts — returned to creator for correction';
                    await bill.save();
                }
                const remaining = await UtilityBillPayment.countDocuments({
                    batchId,
                    status: 'Pending Accounts',
                });
                await syncBatchDashboard({
                    batchId,
                    bills: bills.map((b) => b.toObject()),
                    assignedTo: requester?._id || gate.accounts?._id || actor?._id,
                    status: remaining > 0 ? 'Pending' : 'Rejected',
                    actionedBy: actor?._id || req.user?._id,
                    comment:
                        comment ||
                        'Rejected by Accounts — returned to creator for correction',
                    subjectEmployee: requester,
                    requestedByName: allBills[0].requestedByName,
                    extra2:
                        remaining > 0
                            ? statusLabel('Pending Accounts', empDisplayName(gate.accounts))
                            : 'returned to creator',
                });
                if (requester && remaining === 0) {
                    await sendUtilityBillPaymentEmail({
                        recipient: requester,
                        bill: bills[0].toObject(),
                        kind: 'returned_creator',
                        batchMeta: {
                            batchId: String(batchId),
                            billCount: bills.length,
                            comment:
                                comment ||
                                'Rejected by Accounts — returned to you for correction',
                        },
                    });
                }
                return res.status(200).json({
                    batchId,
                    status: remaining > 0 ? 'Pending Accounts' : 'Rejected',
                    statusLabel:
                        remaining > 0
                            ? statusLabel('Pending Accounts', empDisplayName(gate.accounts))
                            : 'returned to creator',
                    returnedTo: 'creator',
                    bills: bills.map((b) => decorateBill(b.toObject())),
                });
            }

            applyRowEdits(bills, rows);
            const hr = await getDepartmentHOD('hr');
            if (!hr?._id) {
                return res.status(400).json({
                    message: 'HR responsible person is not configured in Flowchart.',
                });
            }
            const hrName = empDisplayName(hr);
            const next = resolveStageAfterActor({
                actor: actor || gate.accounts,
                accounts: gate.accounts,
                hr,
                from: 'accounts_approve',
                needsHr: batchNeedsHrApproval(bills),
                hrAlreadyDone: bills.every((b) => Boolean(b.hrApprovedBy)),
            });
            const now = new Date();
            const path = reviewPath(batchId, bills[0].utilityType, bills[0].billMonth);
            const totalAmount = bills.reduce((s, b) => s + Number(b.amount || 0), 0);
            const accountsName = empDisplayName(gate.accounts);

            if (next.status === 'Approved') {
                const splitCheck = applyPaySplitToBills(bills, paymentBy);
                if (!splitCheck.ok) {
                    return res.status(400).json({ message: splitCheck.message });
                }

                const zohoSync = await syncApprovedUtilityBillsToZoho(bills, { markAsOpen: true });
                await Promise.all(bills.map((b) => b.save()));
                const zohoFailedSkip = (zohoSync || []).filter(
                    (r) => r && r.ok === false && !r.skipped,
                );
                const stillDraftSkip = bills.filter(
                    (b) => String(b.zohoBillStatus || '').toLowerCase() !== 'open',
                );
                if (zohoFailedSkip.length || stillDraftSkip.length) {
                    const firstMsg =
                        zohoFailedSkip[0]?.message ||
                        stillDraftSkip[0]?.zohoSyncError ||
                        'Zoho bill is still Draft. Open it in Zoho before payment.';
                    return res.status(400).json({
                        batchId,
                        status: 'Pending Accounts',
                        message: firstMsg,
                        zohoSync,
                        bills: bills.map((b) => decorateBill(b.toObject())),
                    });
                }

                const skippedHr = next.skipped.includes('hr');
                for (const bill of bills) {
                    bill.status = 'Approved';
                    bill.pendingWithName = accountsName;
                    bill.pendingWithRole = 'accounts';
                    bill.accountsApprovedBy = actor?._id || null;
                    bill.accountsApprovedAt = now;
                    if (!bill.hrApprovedBy && skippedHr) {
                        bill.hrApprovedBy = actor?._id || null;
                        bill.hrApprovedAt = now;
                    }
                    bill.actionedBy = actor?._id || null;
                    bill.actionedAt = now;
                    bill.comment =
                        comment ||
                        (skippedHr
                            ? 'Approved by Accounts — no difference — Zoho Open — awaiting Pay'
                            : 'Approved by Accounts after HR — Zoho Open — awaiting Pay');
                    await bill.save();
                }

                try {
                    await upsertUtilityBalancePartyExpensesFromBills(
                        bills,
                        actor?._id || req.user?._id || null,
                    );
                } catch (balanceErr) {
                    console.warn(
                        '[respondUtilityBillBatch] PartyExpense balance upsert failed:',
                        balanceErr?.message || balanceErr,
                    );
                }

                const remainingAccounts = await UtilityBillPayment.countDocuments({
                    batchId,
                    status: 'Pending Accounts',
                });

                await syncBatchDashboard({
                    batchId,
                    bills: bills.map((b) => b.toObject()),
                    assignedTo:
                        remainingAccounts > 0 ? gate.accounts._id : gate.accounts._id,
                    status: 'Pending',
                    actionedBy: actor?._id || req.user?._id,
                    comment:
                        comment ||
                        (skippedHr
                            ? 'Approved by Accounts — no difference — Zoho Open — ready to pay'
                            : 'Approved by Accounts after HR — Zoho Open — ready to pay'),
                    subjectEmployee: requester,
                    requestedByName: allBills[0].requestedByName,
                    extra2:
                        remainingAccounts > 0
                            ? statusLabel('Pending Accounts', accountsName)
                            : 'not paid — awaiting Accounts payment',
                });

                await sendUtilityBillPaymentEmail({
                    recipient: gate.accounts,
                    bill: { ...bills[0].toObject(), amount: totalAmount },
                    kind: 'pending_pay',
                    batchMeta: {
                        batchId: String(batchId),
                        billCount: bills.length,
                        reviewPath: path,
                    },
                });

                notifyUtilityBillZohoPayableParties({
                    bills,
                    batchMeta: {
                        batchId: String(batchId),
                        billCount: bills.length,
                        reviewPath: path,
                    },
                }).catch((err) =>
                    console.warn(
                        '[respondUtilityBillBatch] Zoho payable notify failed:',
                        err?.message || err,
                    ),
                );

                if (requester && !isSameEmployee(requester, gate.accounts)) {
                    await sendUtilityBillPaymentEmail({
                        recipient: requester,
                        bill: bills[0].toObject(),
                        kind: 'approved',
                        batchMeta: { batchId: String(batchId), billCount: bills.length },
                    });
                }

                return res.status(200).json({
                    batchId,
                    status: 'Approved',
                    statusLabel: 'not paid',
                    skippedStages: next.skipped,
                    bills: bills.map((b) => decorateBill(b.toObject())),
                    zohoSync,
                });
            }

            for (const bill of bills) {
                bill.status = 'Pending HR';
                bill.pendingWithName = hrName;
                bill.pendingWithRole = 'hr';
                bill.accountsApprovedBy = actor?._id || null;
                bill.accountsApprovedAt = now;
                bill.actionedBy = actor?._id || null;
                bill.actionedAt = now;
                bill.comment = comment || '';
                await bill.save();
            }

            const remainingAccounts = await UtilityBillPayment.countDocuments({
                batchId,
                status: 'Pending Accounts',
            });

            await syncBatchDashboard({
                batchId,
                bills: bills.map((b) => b.toObject()),
                assignedTo: remainingAccounts > 0 ? gate.accounts._id : hr._id,
                status: 'Pending',
                actionedBy: actor?._id || req.user?._id,
                comment: comment || 'Approved by Accounts — sent to HR',
                subjectEmployee: requester,
                requestedByName: allBills[0].requestedByName,
                extra2:
                    remainingAccounts > 0
                        ? statusLabel('Pending Accounts', accountsName)
                        : statusLabel('Pending HR', hrName),
            });

            await sendUtilityBillPaymentEmail({
                recipient: hr,
                bill: {
                    ...bills[0].toObject(),
                    amount: totalAmount,
                },
                kind: 'pending_hr',
                batchMeta: {
                    batchId: String(batchId),
                    billCount: bills.length,
                    reviewPath: path,
                },
            });

            return res.status(200).json({
                batchId,
                status: remainingAccounts > 0 ? 'Pending Accounts' : 'Pending HR',
                statusLabel:
                    remainingAccounts > 0
                        ? statusLabel('Pending Accounts', accountsName)
                        : statusLabel('Pending HR', hrName),
                bills: bills.map((b) => decorateBill(b.toObject())),
            });
        }

        // Pending HR
        const gate = hrGateEarly;
        if (!gate.allowed) {
            const hrName = empDisplayName(gate.hr) || 'HR';
            return res.status(403).json({
                message: `Only HR (${hrName}) can respond at this stage. Open this from the HR login / HR pending inbox.`,
            });
        }

        if (action === 'draft') {
            applyRowEdits(bills, rows);
            const splitCheckDraft = applyPaySplitToBills(bills, paymentBy);
            if (!splitCheckDraft.ok) {
                return res.status(400).json({ message: splitCheckDraft.message });
            }

            for (const bill of bills) {
                bill.actionedBy = actor?._id || null;
                bill.actionedAt = new Date();
                bill.comment = comment || 'Saved as Zoho Draft by HR';
                await bill.save();
            }

            // Stay Pending HR — Accounts cannot pay until Approve opens the Zoho bill.
            const zohoSyncDraft = await syncApprovedUtilityBillsToZoho(bills, {
                markAsOpen: false,
            });

            await syncBatchDashboard({
                batchId,
                bills: bills.map((b) => b.toObject()),
                assignedTo: gate.hr._id,
                status: 'Pending',
                actionedBy: actor?._id || req.user?._id,
                comment: comment || 'HR saved Zoho Draft — awaiting Approve',
                subjectEmployee: requester,
                requestedByName: allBills[0].requestedByName,
                extra2: `${statusLabel('Pending HR', empDisplayName(gate.hr))} · Zoho Draft`,
            });

            return res.status(200).json({
                batchId,
                status: 'Pending HR',
                statusLabel: `${statusLabel('Pending HR', empDisplayName(gate.hr))} · Zoho Draft`,
                zohoSync: zohoSyncDraft,
                bills: bills.map((b) => decorateBill(b.toObject())),
            });
        }

        if (action === 'reject') {
            // HR reject → Rejected (returned to creator).
            for (const bill of bills) {
                bill.status = 'Rejected';
                bill.pendingWithName = '';
                bill.pendingWithRole = '';
                bill.hrApprovedBy = null;
                bill.hrApprovedAt = null;
                bill.actionedBy = actor?._id || null;
                bill.actionedAt = new Date();
                bill.comment =
                    comment || 'Rejected by HR — returned to creator for correction';
                await bill.save();
            }
            const remainingHr = await UtilityBillPayment.countDocuments({
                batchId,
                status: 'Pending HR',
            });
            const path = reviewPath(batchId, bills[0].utilityType, bills[0].billMonth);
            await syncBatchDashboard({
                batchId,
                bills: bills.map((b) => b.toObject()),
                assignedTo: requester?._id || gate.hr?._id || actor?._id,
                status: remainingHr > 0 ? 'Pending' : 'Rejected',
                actionedBy: actor?._id || req.user?._id,
                comment:
                    comment || 'Rejected by HR — returned to creator for correction',
                subjectEmployee: requester,
                requestedByName: allBills[0].requestedByName,
                extra2:
                    remainingHr > 0
                        ? statusLabel('Pending HR', empDisplayName(gate.hr))
                        : 'returned to creator',
            });
            if (requester && remainingHr === 0) {
                await sendUtilityBillPaymentEmail({
                    recipient: requester,
                    bill: bills[0].toObject(),
                    kind: 'returned_creator',
                    batchMeta: {
                        batchId: String(batchId),
                        billCount: bills.length,
                        reviewPath: path,
                        comment:
                            comment ||
                            'Rejected by HR — returned to you for correction',
                    },
                });
            }
            return res.status(200).json({
                batchId,
                status: remainingHr > 0 ? 'Pending HR' : 'Rejected',
                statusLabel:
                    remainingHr > 0
                        ? statusLabel('Pending HR', empDisplayName(gate.hr))
                        : 'returned to creator',
                returnedTo: 'creator',
                bills: bills.map((b) => decorateBill(b.toObject())),
            });
        }

        applyRowEdits(bills, rows);
        const splitCheck = applyPaySplitToBills(bills, paymentBy);
        if (!splitCheck.ok) {
            return res.status(400).json({ message: splitCheck.message });
        }

        const accounts = await getDepartmentHOD('accounts');
        if (!accounts?._id) {
            return res.status(400).json({
                message: 'Accounts responsible person is not configured in Flowchart.',
            });
        }
        const accountsNameHr = empDisplayName(accounts);
        const nowHr = new Date();
        const pathHr = reviewPath(batchId, bills[0].utilityType, bills[0].billMonth);

        for (const bill of bills) {
            bill.status = 'Pending Accounts';
            bill.pendingWithName = accountsNameHr;
            bill.pendingWithRole = 'accounts';
            bill.hrApprovedBy = actor?._id || null;
            bill.hrApprovedAt = nowHr;
            bill.actionedBy = actor?._id || null;
            bill.actionedAt = nowHr;
            bill.comment = comment || 'Approved by HR — sent to Accounts for Zoho bill';
            await bill.save();
        }

        const remainingHr = await UtilityBillPayment.countDocuments({
            batchId,
            status: 'Pending HR',
        });

        await syncBatchDashboard({
            batchId,
            bills: bills.map((b) => b.toObject()),
            assignedTo: remainingHr > 0 ? gate.hr._id : accounts._id,
            status: 'Pending',
            actionedBy: actor?._id || req.user?._id,
            comment: comment || 'Approved by HR — sent to Accounts for Zoho bill',
            subjectEmployee: requester,
            requestedByName: allBills[0].requestedByName,
            extra2:
                remainingHr > 0
                    ? statusLabel('Pending HR', empDisplayName(gate.hr))
                    : statusLabel('Pending Accounts', accountsNameHr),
        });

        await sendUtilityBillPaymentEmail({
            recipient: accounts,
            bill: {
                ...bills[0].toObject(),
                amount: bills.reduce((s, b) => s + Number(b.amount || 0), 0),
            },
            kind: 'pending_accounts',
            batchMeta: {
                batchId: String(batchId),
                billCount: bills.length,
                reviewPath: pathHr,
            },
        });

        if (requester && !isSameEmployee(requester, actor) && !isSameEmployee(requester, accounts)) {
            await sendUtilityBillPaymentEmail({
                recipient: requester,
                bill: bills[0].toObject(),
                kind: 'approved',
                batchMeta: { batchId: String(batchId), billCount: bills.length },
            });
        }

        return res.status(200).json({
            batchId,
            status: remainingHr > 0 ? 'Pending HR' : 'Pending Accounts',
            statusLabel:
                remainingHr > 0
                    ? statusLabel('Pending HR', empDisplayName(gate.hr))
                    : statusLabel('Pending Accounts', accountsNameHr),
            bills: bills.map((b) => decorateBill(b.toObject())),
        });
    } catch (err) {
        console.error('[respondUtilityBillBatch]', err);
        return res.status(500).json({ message: err.message || 'Failed to respond' });
    }
}

/** Legacy single-bill respond — wraps batch when batchId present. */
export async function respondUtilityBillPayment(req, res) {
    try {
        const bill = await UtilityBillPayment.findById(req.params.id);
        if (!bill) return res.status(404).json({ message: 'Bill not found' });
        if (bill.batchId) {
            req.params.batchId = String(bill.batchId);
            return respondUtilityBillBatch(req, res);
        }
        // Legacy orphan Pending HR bills without batch
        req.params.batchId = String(bill._id);
        bill.batchId = bill._id;
        await bill.save();
        return respondUtilityBillBatch(req, res);
    } catch (err) {
        return res.status(500).json({ message: err.message || 'Failed to respond' });
    }
}

/**
 * Accounts Pay — mark selected/approved bills Paid.
 */
export async function payUtilityBillBatch(req, res) {
    try {
        const { batchId } = req.params;
        const { billIds = [] } = req.body || {};
        if (!mongoose.Types.ObjectId.isValid(batchId)) {
            return res.status(400).json({ message: 'Invalid batchId' });
        }

        const actor = await resolveRequesterEmployee(req.user);
        const gate = await isActorAccountsOrAdmin(actor, req.user);
        if (!gate.allowed) {
            return res.status(403).json({ message: 'Only Accounts can mark bills as paid.' });
        }

        const filter = { batchId, status: 'Approved' };
        if (Array.isArray(billIds) && billIds.length) {
            filter._id = { $in: billIds };
        }
        const bills = await UtilityBillPayment.find(filter);
        if (!bills.length) {
            return res.status(400).json({ message: 'No approved bills selected to pay.' });
        }

        // Ensure each selected bill is stored in Zoho before marking Paid.
        const missingZoho = bills.filter((b) => !String(b.zohoBillId || '').trim());
        if (missingZoho.length) {
            const first = missingZoho[0];
            return res.status(400).json({
                message:
                    first?.zohoSyncError ||
                    `Zoho bill missing for ${first?.accountNo || 'selected bill'}. Sync to Zoho first, then Pay.`,
                zohoSyncError: first?.zohoSyncError || '',
                failedBillIds: missingZoho.map((b) => String(b._id)),
            });
        }

        for (const bill of bills) {
            // Prefer Open; if still Draft, try to open before marking Paid.
            if (String(bill.zohoBillStatus || '').toLowerCase() !== 'open') {
                try {
                    const { syncApprovedUtilityBillToZoho } = await import(
                        '../../utils/syncUtilityBillToZoho.js'
                    );
                    const openResult = await syncApprovedUtilityBillToZoho(bill, {
                        markAsOpen: true,
                    });
                    if (!openResult?.ok && !openResult?.zohoBillId) {
                        return res.status(400).json({
                            message:
                                openResult?.message ||
                                bill.zohoSyncError ||
                                'Could not open Zoho bill before payment.',
                            zohoSyncError: bill.zohoSyncError || openResult?.message || '',
                        });
                    }
                } catch (openErr) {
                    return res.status(400).json({
                        message:
                            openErr?.message ||
                            bill.zohoSyncError ||
                            'Could not open Zoho bill before payment.',
                        zohoSyncError: bill.zohoSyncError || openErr?.message || '',
                    });
                }
            }

            bill.status = 'Paid';
            bill.pendingWithName = '';
            bill.pendingWithRole = '';
            bill.paidBy = actor?._id || null;
            bill.paidAt = new Date();
            bill.actionedBy = actor?._id || null;
            bill.actionedAt = new Date();
            await bill.save();
        }

        try {
            const { clearUtilityBillPaymentDayRemindersForBills } = await import(
                '../../utils/processUtilityBillPaymentDayReminders.js'
            );
            await clearUtilityBillPaymentDayRemindersForBills(
                bills,
                'Month bill paid — payment day reminder cleared',
            );
        } catch (remErr) {
            console.warn(
                '[payUtilityBillBatch] payment-day reminder clear failed:',
                remErr?.message || remErr,
            );
        }

        const remaining = await UtilityBillPayment.countDocuments({
            batchId,
            status: 'Approved',
        });
        const allInBatch = await UtilityBillPayment.find({ batchId }).lean();
        const remainingBills = allInBatch.filter((b) => b.status === 'Approved');

        if (remaining === 0) {
            // Fully paid — clear Accounts notification
            await syncBatchDashboard({
                batchId,
                bills: allInBatch,
                assignedTo: gate.accounts?._id || actor?._id,
                status: 'Approved',
                actionedBy: actor?._id || req.user?._id,
                comment: 'Paid by Accounts',
                subjectEmployee: null,
                requestedByName: allInBatch[0]?.requestedByName || '',
                extra2: 'paid',
            });
        } else {
            // Partially paid — keep Accounts notification for unchecked/remaining bills
            await syncBatchDashboard({
                batchId,
                bills: remainingBills.length ? remainingBills : allInBatch,
                assignedTo: gate.accounts?._id || actor?._id,
                status: 'Pending',
                actionedBy: actor?._id || req.user?._id,
                comment: 'Partially paid by Accounts — remaining bills still pending',
                subjectEmployee: null,
                requestedByName: allInBatch[0]?.requestedByName || '',
                extra2: 'partially paid',
            });
        }

        const requester = allInBatch[0]?.requestedBy
            ? await EmployeeBasic.findById(allInBatch[0].requestedBy)
                  .select('firstName lastName companyEmail workEmail personalEmail email employeeId')
                  .lean()
            : null;
        // Don't block the pay response on SMTP — hanging mail was freezing Accounts Pay Now
        if (requester) {
            sendUtilityBillPaymentEmail({
                recipient: requester,
                bill: {
                    ...bills[0].toObject(),
                    amount: bills.reduce((s, b) => s + Number(b.amount || 0), 0),
                    status: remaining === 0 ? 'Paid' : 'Approved',
                },
                kind: remaining === 0 ? 'paid' : 'partially_paid',
                batchMeta: { batchId: String(batchId), billCount: bills.length, remaining },
            }).catch((mailErr) =>
                console.error('[payUtilityBillBatch] email failed:', mailErr?.message || mailErr),
            );
        }

        return res.status(200).json({
            batchId,
            paidCount: bills.length,
            remainingApproved: remaining,
            bills: bills.map((b) => decorateBill(b.toObject())),
            statusLabel: remaining === 0 ? 'paid' : 'partially paid',
        });
    } catch (err) {
        console.error('[payUtilityBillBatch]', err);
        return res.status(500).json({ message: err.message || 'Failed to pay bills' });
    }
}

export async function getUtilityBillPayment(req, res) {
    try {
        let bill = await UtilityBillPayment.findById(req.params.id).lean();
        if (!bill) return res.status(404).json({ message: 'Bill not found' });

        if (
            (bill.status === 'Approved' || bill.status === 'Paid') &&
            utilityBillHasZohoLink(bill)
        ) {
            try {
                await syncApprovedUtilityBillsPaidFromZoho({
                    billIds: [bill._id],
                    userId: req.user?._id || null,
                    fetchLive: true,
                });
                bill = await UtilityBillPayment.findById(req.params.id).lean();
            } catch (syncErr) {
                console.warn(
                    '[getUtilityBillPayment] Zoho paid sync failed:',
                    syncErr?.message || syncErr,
                );
            }
        }

        const [numbered] = await attachZohoBillNumbers([bill], {
            persistModel: UtilityBillPayment,
            fetchLive: true,
        });
        return res.status(200).json({ bill: decorateBill(numbered) });
    } catch (err) {
        return res.status(500).json({ message: err.message || 'Failed to load bill' });
    }
}

/**
 * Retry Zoho Books bill create / mark Open for Approved (not paid) rows in a batch.
 * Also opens Zoho Draft bills so Accounts can pay.
 */
export async function syncUtilityBillBatchToZoho(req, res) {
    try {
        const { batchId } = req.params;
        const bills = await UtilityBillPayment.find({
            batchId,
            status: { $in: ['Approved', 'Paid', 'Pending HR'] },
        });
        if (!bills.length) {
            return res.status(404).json({ message: 'No bills found for this batch.' });
        }

        // Re-resolve vendor when missing or prior sync failed on vendor match.
        for (const bill of bills) {
            if (bill.zohoBillId && String(bill.zohoBillStatus || '').toLowerCase() === 'open') {
                continue;
            }
            if (!bill.zohoBillId) {
                if (
                    !String(bill.zohoVendorId || '').trim() ||
                    /vendor/i.test(bill.zohoSyncError || '')
                ) {
                    bill.zohoVendorId = '';
                }
            }
        }

        const zohoSync = await syncApprovedUtilityBillsToZoho(bills, { markAsOpen: true });
        const failed = (zohoSync || []).filter((r) => r && r.ok === false && !r.skipped);
        const created = (zohoSync || []).filter(
            (r) => r && r.ok && !r.skipped && !r.opened && r.zohoBillId,
        );
        const opened = (zohoSync || []).filter((r) => r && r.ok && r.opened);
        const storedDraft = (zohoSync || []).filter(
            (r) => r && r.ok && !r.opened && String(r.zohoBillStatus || '').toLowerCase() === 'draft',
        );

        try {
            await upsertUtilityBalancePartyExpensesFromBills(
                bills,
                req.user?.employeeObjectId || req.user?._id || null,
            );
        } catch (balanceErr) {
            console.warn(
                '[syncUtilityBillBatchToZoho] PartyExpense balance upsert failed:',
                balanceErr?.message || balanceErr,
            );
        }

        // If Zoho is now Open and ERP was stuck Approved+Draft, notify Accounts to pay.
        const newlyOpenApproved = bills.filter(
            (b) =>
                String(b.status) === 'Approved' &&
                String(b.zohoBillStatus || '').toLowerCase() === 'open',
        );
        if (opened.length > 0 && newlyOpenApproved.length > 0) {
            try {
                const accounts = await getDepartmentHOD('accounts');
                if (accounts?._id) {
                    await syncBatchDashboard({
                        batchId,
                        bills: newlyOpenApproved.map((b) => b.toObject()),
                        assignedTo: accounts._id,
                        status: 'Pending',
                        actionedBy: req.user?._id,
                        comment: 'Zoho bill Open — awaiting Accounts payment',
                        subjectEmployee: null,
                        requestedByName: newlyOpenApproved[0].requestedByName || '',
                        extra2: 'not paid — awaiting Accounts payment',
                    });
                    await sendUtilityBillPaymentEmail({
                        recipient: accounts,
                        bill: {
                            ...newlyOpenApproved[0].toObject(),
                            amount: newlyOpenApproved.reduce(
                                (s, b) => s + Number(b.amount || 0),
                                0,
                            ),
                        },
                        kind: 'pending_pay',
                        batchMeta: {
                            batchId: String(batchId),
                            billCount: newlyOpenApproved.length,
                            reviewPath: reviewPath(
                                batchId,
                                newlyOpenApproved[0].utilityType,
                                newlyOpenApproved[0].billMonth,
                            ),
                        },
                    });
                }
            } catch (notifyErr) {
                console.warn(
                    '[syncUtilityBillBatchToZoho] Accounts notify failed:',
                    notifyErr?.message || notifyErr,
                );
            }
        }

        const refreshed = await UtilityBillPayment.find({ batchId }).lean();

        return res.status(200).json({
            batchId,
            zohoSync,
            createdCount: created.length,
            openedCount: opened.length,
            failedCount: failed.length,
            failed: failed.map((r) => ({
                ok: false,
                message: r?.message || 'Zoho sync failed',
                zohoBillId: r?.zohoBillId || '',
            })),
            bills: refreshed.map((b) => decorateBill(b)),
            message:
                failed.length > 0
                    ? `${created.length + opened.length} synced; ${failed.length} failed. ${
                          failed[0]?.message || 'Check zohoSyncError on each bill.'
                      }`
                    : opened.length > 0
                      ? `${opened.length} Zoho bill(s) marked Open — Accounts can pay.`
                      : storedDraft.length > 0
                        ? `${storedDraft.length} Zoho bill(s) stored as Draft. Use Open Zoho bill / Pay to mark Open.`
                        : `${created.length || (zohoSync || []).filter((r) => r?.skipped).length} bill(s) ready in Zoho.`,
        });
    } catch (err) {
        console.error('[syncUtilityBillBatchToZoho]', err);
        return res.status(500).json({ message: err.message || 'Failed to sync bills to Zoho' });
    }
}

/** DELETE /api/UtilityBill/:id — admin / super user only */
export async function deleteUtilityBillPayment(req, res) {
    try {
        if (!isUtilityAdminSuperUser(req)) {
            return res.status(403).json({ message: 'Only admin can delete utility bills.' });
        }
        const result = await cascadeDeleteUtilityBill(req.params.id, { req });
        if (!result.ok) {
            return res.status(result.message === 'Bill not found.' ? 404 : 400).json({
                message: result.message || 'Failed to delete bill',
            });
        }
        return res.json(result);
    } catch (err) {
        console.error('[deleteUtilityBillPayment]', err);
        return res.status(500).json({ message: err?.message || 'Failed to delete bill' });
    }
}

import multer from 'multer';
import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import SalaryMonthPayment from '../../models/SalaryMonthPayment.js';
import { buildExpensePayload } from '../zoho/postZohoExpense.js';
import { createExpense, getZohoConfig, uploadExpenseAttachment } from '../../services/zohoService.js';
import { withZohoOrganization } from '../../utils/zohoOrgContext.js';
import { collectSalarySlipPayrollFigures } from '../../utils/buildSalarySlipPayload.js';
import { buildDmfViewerContext } from '../../utils/salaryDmfApproval.js';
import { closeAccountsSalarySlotInbox } from '../../utils/salaryDmfNotify.js';
import { slotStatusOf } from '../../utils/salarySlotRules.js';
import { resolveEmployeeZohoOrg, zohoOrgShortLabel } from '../../utils/salaryZohoJournalLines.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

export const uploadSalarySlotExpense = upload.array('attachments', 5);

function toYearMonth(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function personKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

function activeZohoAccount(salary) {
    const history = Array.isArray(salary?.salaryHistory) ? salary.salaryHistory : [];
    const active = history.find((row) => !row?.toDate) || history[history.length - 1];
    const directId = String(salary?.zohoAccountId || '').trim();
    if (directId) {
        return {
            zohoAccountId: directId,
            zohoAccountName: String(salary?.zohoAccountName || '').trim(),
            zohoAccountOrganizationId: String(
                salary?.zohoAccountOrganizationId || active?.zohoAccountOrganizationId || '',
            ).trim(),
        };
    }
    return {
        zohoAccountId: String(active?.zohoAccountId || '').trim(),
        zohoAccountName: String(active?.zohoAccountName || '').trim(),
        zohoAccountOrganizationId: String(
            active?.zohoAccountOrganizationId || salary?.zohoAccountOrganizationId || '',
        ).trim(),
    };
}

function configuredOrganizations() {
    const config = getZohoConfig();
    const rows = [];
    const vega = String(config.organizationId || '').trim();
    const nnit = String(config.nnitOrganizationId || '').trim();
    if (vega) rows.push({ organizationId: vega, name: 'VEGADIGITAL IT SOLUTIONS LLC', brand: 'VEGA' });
    if (nnit) {
        rows.push({
            organizationId: nnit,
            name: 'NEURON NEXUS INFORMATION TECHNOLOGY L.L.C',
            brand: 'NNIT',
        });
    }
    return rows.map((org) => ({ ...org, label: zohoOrgShortLabel(org) }));
}

async function assertAccountsSlot(req, doc) {
    const ctx = await buildDmfViewerContext(req);
    if (!ctx?.isAccounts) {
        const error = new Error('Only the flowchart Accounts assignee can update this payment.');
        error.statusCode = 403;
        throw error;
    }
    if (slotStatusOf(doc) !== 'pending_update') {
        const error = new Error('Update payment opens after the earlier slot steps are done.');
        error.statusCode = 400;
        throw error;
    }
}

async function slotExpenseLines(doc, monthKey) {
    const ids = [...new Set((doc.employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return [];
    const [people, salaries, figures] = await Promise.all([
        EmployeeBasic.find({ employeeId: { $in: ids } })
            .select('employeeId firstName lastName company zohoCategoryOrganizationId zohoCategoryAccountId zohoCategoryAccountName')
            .populate('company', 'name nickName zohoOrganizationId zohoOrganizationLabel')
            .lean(),
        EmployeeSalary.find({ employeeId: { $in: ids } })
            .select('employeeId zohoAccountOrganizationId zohoAccountId zohoAccountName salaryHistory.zohoAccountOrganizationId salaryHistory.zohoAccountId salaryHistory.zohoAccountName salaryHistory.toDate')
            .lean(),
        collectSalarySlipPayrollFigures(ids, monthKey),
    ]);
    const peopleByCode = new Map((people || []).map((emp) => [personKey(emp.employeeId), emp]));
    const salaryByCode = new Map((salaries || []).map((row) => [personKey(row.employeeId), row]));
    return ids.map((employeeId) => {
        const emp = peopleByCode.get(personKey(employeeId));
        const pay = figures.get(personKey(employeeId)) || {};
        const account = activeZohoAccount(salaryByCode.get(personKey(employeeId)));
        const name = `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || employeeId;
        const amount = money(pay.zohoSalary);
        return {
            employeeId: String(emp?.employeeId || employeeId).trim(),
            name,
            accountId: String(emp?.zohoCategoryAccountId || '').trim(),
            accountName: String(emp?.zohoCategoryAccountName || '').trim(),
            zohoCategoryOrganizationId: String(emp?.zohoCategoryOrganizationId || '').trim(),
            employeeAccountId: account.zohoAccountId,
            employeeAccountName: account.zohoAccountName,
            zohoAccountOrganizationId: account.zohoAccountOrganizationId,
            notes: `${name} (${String(emp?.employeeId || employeeId).trim()})`,
            amount: amount > 0 ? amount.toFixed(2) : '',
            company: emp?.company || null,
        };
    });
}

function serializePayment(doc) {
    return {
        id: String(doc._id),
        monthKey: String(doc.monthKey || ''),
        paymentNo: Number(doc.paymentNo) || 0,
        selectedIds: (doc.employeeIds || []).map((id) => String(id || '').trim()).filter(Boolean),
        companyName: String(doc.companyName || '').trim(),
        paymentMethod: String(doc.paymentMethod || '').trim(),
        status: slotStatusOf(doc),
        rejectReason: String(doc.rejectReason || '').trim(),
        processed: slotStatusOf(doc) === 'approved',
        createdAt: doc.createdAt || null,
        zohoExpenseId: String(doc.zohoExpenseId || '').trim(),
        zohoExpenseNumber: String(doc.zohoExpenseNumber || '').trim(),
        zohoOrganizationId: String(doc.zohoOrganizationId || '').trim(),
    };
}

async function applySlotPaid(employeeIds, monthKey) {
    const { applySalarySlipLeaveTicketPaymentsForEmployee } = await import(
        '../../utils/applySalarySlipLeaveTicketPayments.js'
    );
    for (const id of employeeIds || []) {
        try {
            await applySalarySlipLeaveTicketPaymentsForEmployee(id, monthKey);
        } catch (error) {
            console.error('[salary slot expense] leave ticket', id, error?.message || error);
        }
    }
}

export const getSalarySlotExpense = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey);
        const paymentId = String(req.params.paymentId || '').trim();
        if (!monthKey || !mongoose.Types.ObjectId.isValid(paymentId)) {
            return res.status(400).json({ message: 'Invalid salary slot.' });
        }
        const doc = await SalaryMonthPayment.findOne({ _id: paymentId, monthKey });
        if (!doc || slotStatusOf(doc) === 'cancelled') {
            return res.status(404).json({ message: 'Salary slot was not found.' });
        }
        await assertAccountsSlot(req, doc);
        const organizations = configuredOrganizations();
        const lines = await slotExpenseLines(doc, monthKey);
        const company = { nickName: doc.companyName, name: doc.companyName };
        const explicitOrg = lines
            .map((line) => line.zohoAccountOrganizationId || line.zohoCategoryOrganizationId)
            .find(Boolean) || '';
        const matched = resolveEmployeeZohoOrg(
            lines.find((line) => line.company)?.company || company,
            organizations,
            explicitOrg,
        );
        return res.status(200).json({
            organizations,
            organizationId: matched?.organizationId || organizations[0]?.organizationId || '',
            referenceNumber: `Slot ${doc.paymentNo} ${monthKey}`,
            lines: lines.map(({ company: _company, ...line }) => line),
        });
    } catch (error) {
        console.error('[getSalarySlotExpense]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Could not open the salary expense.',
        });
    }
};

export const postSalarySlotExpense = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey);
        const paymentId = String(req.params.paymentId || '').trim();
        if (!monthKey || !mongoose.Types.ObjectId.isValid(paymentId)) {
            return res.status(400).json({ message: 'Invalid salary slot.' });
        }
        const doc = await SalaryMonthPayment.findOne({ _id: paymentId, monthKey });
        if (!doc || slotStatusOf(doc) === 'cancelled') {
            return res.status(404).json({ message: 'Salary slot was not found.' });
        }
        await assertAccountsSlot(req, doc);

        let body = req.body?.payload ?? req.body ?? {};
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                return res.status(400).json({ message: 'Expense details are not valid JSON.' });
            }
        }
        const organizationId = String(body.organizationId || '').trim();
        if (!organizationId) return res.status(400).json({ message: 'Choose a Zoho company.' });

        const payload = buildExpensePayload(body);
        const files = Array.isArray(req.files) ? req.files.slice(0, 5) : [];
        const created = await withZohoOrganization(organizationId, async () => {
            const expense = await createExpense(payload);
            const expenseId = String(expense?.expense_id || expense?.expenseId || '').trim();
            const expenseNumber = String(expense?.expense_number || expense?.expenseNumber || '').trim();
            const attachmentErrors = [];
            if (expenseId && files.length) {
                for (const file of files) {
                    try {
                        await uploadExpenseAttachment(expenseId, {
                            buffer: file.buffer,
                            filename: file.originalname || 'attachment',
                            mimeType: file.mimetype || 'application/octet-stream',
                        });
                    } catch (err) {
                        attachmentErrors.push(`${file.originalname || 'file'}: ${err?.message || 'upload failed'}`);
                    }
                }
            }
            return { expenseId, expenseNumber, attachmentErrors };
        });

        doc.status = 'approved';
        doc.rejectReason = '';
        doc.zohoExpenseId = created.expenseId;
        doc.zohoExpenseNumber = created.expenseNumber;
        doc.zohoOrganizationId = organizationId;
        await doc.save();
        await applySlotPaid(doc.employeeIds || [], monthKey);
        try {
            const { applySalarySlotDeductionReceipts } = await import(
                '../../utils/applySalarySlotDeductionReceipts.js'
            );
            await applySalarySlotDeductionReceipts({
                employeeIds: doc.employeeIds || [],
                monthKey,
                slotId: doc._id,
                userId: req.user?._id || null,
            });
        } catch (deductionErr) {
            console.error(
                '[salary slot expense] deduction receipts',
                deductionErr?.message || deductionErr,
            );
        }
        await closeAccountsSalarySlotInbox(doc._id);

        const label = String(body.organizationLabel || 'Zoho').trim() || 'Zoho';
        const message = created.attachmentErrors.length
            ? `${label} expense ${created.expenseNumber || ''} saved. Some attachments failed: ${created.attachmentErrors.join('; ')}`
            : `${label} expense ${created.expenseNumber || ''} saved. This slot is updated.`;
        return res.status(200).json({
            message,
            payment: serializePayment(doc),
            expenseId: created.expenseId,
            expenseNumber: created.expenseNumber,
            attachmentErrors: created.attachmentErrors,
        });
    } catch (error) {
        console.error('[postSalarySlotExpense]', error);
        const message = error?.message || 'Could not save the salary expense in Zoho.';
        const statusCode = error.statusCode
            || (/required|greater than|YYYY-MM-DD|itemized|at least one/i.test(message) ? 400 : 500);
        return res.status(statusCode).json({ message });
    }
};

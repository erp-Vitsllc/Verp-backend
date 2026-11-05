import multer from 'multer';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import EmployeeSalary from '../../models/EmployeeSalary.js';
import SalaryEnrollment from '../../models/SalaryEnrollment.js';
import SalaryMonthDmf from '../../models/SalaryMonthDmf.js';
import { REAL_EMPLOYEE_MONGO_FILTER, isCompanyShellEmployee } from '../../utils/attendanceEmployeeFilters.js';
import { isPlaceholderEmployeeId } from '../../utils/employeeIdPrefix.js';
import { collectSalarySlipPayrollFigures } from '../../utils/buildSalarySlipPayload.js';
import { enrollmentCoversSalaryMonth } from '../../utils/salaryEnrollmentStartMonth.js';
import { buildDmfViewerContext } from '../../utils/salaryDmfApproval.js';
import { getScheduledEmailTimeZone, getZonedParts } from '../../utils/scheduleDailyAtMidnight.js';
import { createZohoJournal, getZohoConfig, uploadJournalAttachment } from '../../services/zohoService.js';
import { withZohoOrganization } from '../../utils/zohoOrgContext.js';
import { groupSalaryZohoJournals } from '../../utils/salaryZohoJournalLines.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

export const uploadSalaryZohoJournal = upload.array('attachments', 5);

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

function toYearMonth(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : '';
}

function monthLabel(monthKey) {
    const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return String(monthKey || '');
    return `${MONTHS[Number(match[2]) - 1] || match[2]} ${match[1]}`;
}

function currentSalaryYearMonth() {
    const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
    return `${dubai.year}-${String(dubai.month).padStart(2, '0')}`;
}

function personKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function activePayrollEmployee(emp) {
    if (!emp) return false;
    if (String(emp.status || '') === 'Left User') return false;
    return String(emp.profileStatus || '').trim().toLowerCase() === 'active';
}

function employeeWorkedInMonth(emp, ym) {
    const join = toYearMonth(emp?.dateOfJoining);
    if (join && join > ym) return false;
    if (String(emp?.status || '') === 'Left User') {
        if (ym >= currentSalaryYearMonth()) return false;
        const exit = toYearMonth(emp?.noticeRequest?.exitDate);
        if (exit && exit < ym) return false;
    }
    return true;
}

function activeZohoAccount(salary) {
    const directId = String(salary?.zohoAccountId || '').trim();
    if (directId) {
        return { zohoAccountId: directId, zohoAccountName: String(salary?.zohoAccountName || '').trim() };
    }
    const history = Array.isArray(salary?.salaryHistory) ? salary.salaryHistory : [];
    const active = history.find((row) => !row?.toDate) || history[history.length - 1];
    return {
        zohoAccountId: String(active?.zohoAccountId || '').trim(),
        zohoAccountName: String(active?.zohoAccountName || '').trim(),
    };
}

function configuredOrganizations() {
    const config = getZohoConfig();
    const rows = [];
    const vega = String(config.organizationId || '').trim();
    const nnit = String(config.nnitOrganizationId || '').trim();
    if (vega) {
        rows.push({ organizationId: vega, name: 'VEGADIGITAL IT SOLUTIONS LLC', brand: 'VEGA' });
    }
    if (nnit) {
        rows.push({
            organizationId: nnit,
            name: 'NEURON NEXUS INFORMATION TECHNOLOGY L.L.C',
            brand: 'NNIT',
        });
    }
    return rows;
}

async function assertAccountsProcessedMonth(req, monthKey) {
    const ctx = await buildDmfViewerContext(req);
    if (!ctx?.isAccounts) {
        const error = new Error('Only the flowchart Accounts assignee can update Zoho.');
        error.statusCode = 403;
        throw error;
    }
    const month = await SalaryMonthDmf.findOne({ monthKey }).select('dmfApproval.status').lean();
    if (String(month?.dmfApproval?.status || '') !== 'approved') {
        const error = new Error('Update Zoho opens after Management approves the payroll.');
        error.statusCode = 400;
        throw error;
    }
}

async function payrollPeople(monthKey) {
    const enrollments = await SalaryEnrollment.find({})
        .select('employeeId fromMonth salaryDate processDate')
        .lean();
    const ids = [...new Set(
        (enrollments || [])
            .filter((row) => enrollmentCoversSalaryMonth(row, monthKey))
            .map((row) => String(row.employeeId || '').trim())
            .filter((id) => id && !isPlaceholderEmployeeId(id)),
    )];
    if (!ids.length) return [];

    const [people, salaries] = await Promise.all([
        EmployeeBasic.find({ employeeId: { $in: ids }, ...REAL_EMPLOYEE_MONGO_FILTER })
            .select('employeeId firstName lastName status profileStatus dateOfJoining noticeRequest.exitDate company zohoCategoryAccountId zohoCategoryAccountName')
            .populate('company', 'name nickName zohoOrganizationId zohoOrganizationLabel')
            .lean(),
        EmployeeSalary.find({ employeeId: { $in: ids } })
            .select('employeeId zohoAccountId zohoAccountName salaryHistory.zohoAccountId salaryHistory.zohoAccountName salaryHistory.toDate')
            .lean(),
    ]);
    const salaryById = new Map((salaries || []).map((row) => [personKey(row.employeeId), row]));
    const enrolled = (people || []).filter((emp) => (
        emp && !isCompanyShellEmployee(emp) && activePayrollEmployee(emp) && employeeWorkedInMonth(emp, monthKey)
    ));
    const figures = await collectSalarySlipPayrollFigures(
        enrolled.map((emp) => emp.employeeId),
        monthKey,
    );
    return enrolled.map((emp) => {
        const code = String(emp.employeeId || '').trim();
        const account = activeZohoAccount(salaryById.get(personKey(code)));
        const pay = figures.get(personKey(code)) || {};
        return {
            employeeId: code,
            name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || code,
            zohoSalary: Number(pay.zohoSalary) || 0,
            zohoAccountId: account.zohoAccountId,
            zohoAccountName: account.zohoAccountName,
            zohoCategoryAccountId: String(emp.zohoCategoryAccountId || '').trim(),
            zohoCategoryAccountName: String(emp.zohoCategoryAccountName || '').trim(),
            company: emp.company || null,
        };
    });
}

function journalTypeFromReporting(method) {
    const value = String(method || '').trim().toLowerCase();
    if (value === 'accrual' || value === 'accrual only') return 'accrual';
    if (value === 'cash' || value === 'cash only') return 'cash';
    return 'both';
}

function buildJournalPayload(body) {
    const journalDate = String(body.journalDate || '').trim();
    const notes = String(body.notes || '').trim();
    const lines = Array.isArray(body.lineItems) ? body.lineItems : [];
    if (!journalDate) {
        const error = new Error('Date is required.');
        error.statusCode = 400;
        throw error;
    }
    if (!notes) {
        const error = new Error('Notes are required.');
        error.statusCode = 400;
        throw error;
    }
    if (notes.length > 500) {
        const error = new Error('Notes must be 500 characters or less.');
        error.statusCode = 400;
        throw error;
    }

    let debitTotal = 0;
    let creditTotal = 0;
    const line_items = [];
    for (const line of lines) {
        const accountId = String(line?.accountId || '').trim();
        const debit = Number(line?.debit || 0) || 0;
        const credit = Number(line?.credit || 0) || 0;
        const description = String(line?.description || '').trim();
        const contactId = String(line?.contactId || '').trim();
        if (!accountId && debit <= 0 && credit <= 0 && !description && !contactId) continue;
        if (!accountId) {
            const error = new Error('Each journal row needs an account.');
            error.statusCode = 400;
            throw error;
        }
        if (debit > 0 && credit > 0) {
            const error = new Error('A journal row cannot have both a debit and a credit.');
            error.statusCode = 400;
            throw error;
        }
        if (debit <= 0 && credit <= 0) {
            const error = new Error('Each journal row needs a debit or a credit amount.');
            error.statusCode = 400;
            throw error;
        }
        const amount = Number((debit > 0 ? debit : credit).toFixed(2));
        debitTotal += debit > 0 ? amount : 0;
        creditTotal += credit > 0 ? amount : 0;
        const item = {
            account_id: accountId,
            amount,
            debit_or_credit: debit > 0 ? 'debit' : 'credit',
        };
        if (description) item.description = description;
        if (contactId) item.customer_id = contactId;
        line_items.push(item);
    }
    if (line_items.length < 2) {
        const error = new Error('A journal needs at least two lines.');
        error.statusCode = 400;
        throw error;
    }
    if (Math.abs(Number((debitTotal - creditTotal).toFixed(2))) > 0.009) {
        const error = new Error('Debits and credits must balance before the journal can be added.');
        error.statusCode = 400;
        throw error;
    }

    const status = String(body.status || 'published').trim().toLowerCase() === 'draft' ? 'draft' : 'published';
    const payload = {
        journal_date: journalDate,
        notes,
        journal_type: journalTypeFromReporting(body.reportingMethod),
        line_items,
        status,
    };
    const reference = String(body.referenceNumber || '').trim();
    if (reference) payload.reference_number = reference;
    const entryNumber = String(body.journalNumber || '').trim();
    if (entryNumber) payload.entry_number = entryNumber;
    const currencyId = String(body.currencyId || '').trim();
    if (currencyId) payload.currency_id = currencyId;
    const locationId = String(body.locationId || '').trim();
    if (locationId) payload.location_id = locationId;
    const reversalDate = String(body.reverseJournalDate || '').trim();
    if (reversalDate) payload.reversal_date = reversalDate;
    return { payload, status };
}

export const getSalaryZohoJournal = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });
        await assertAccountsProcessedMonth(req, monthKey);
        const people = await payrollPeople(monthKey);
        const label = monthLabel(monthKey);
        const organizations = groupSalaryZohoJournals({
            employees: people,
            organizations: configuredOrganizations(),
            note: label ? `Salary payroll ${label}` : 'Salary payroll',
        });
        return res.status(200).json({
            monthKey,
            monthLabel: monthLabel(monthKey),
            organizations,
        });
    } catch (error) {
        console.error('[getSalaryZohoJournal]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Could not build the Zoho salary journal.',
        });
    }
};

export const postSalaryZohoJournal = async (req, res) => {
    try {
        const monthKey = toYearMonth(req.params.monthKey);
        if (!monthKey) return res.status(400).json({ message: 'Invalid salary month.' });
        await assertAccountsProcessedMonth(req, monthKey);

        let body = req.body?.payload ?? req.body ?? {};
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                return res.status(400).json({ message: 'Journal details are not valid JSON.' });
            }
        }
        const organizationId = String(body.organizationId || '').trim();
        if (!organizationId) return res.status(400).json({ message: 'Choose a Zoho company.' });

        const { payload, status } = buildJournalPayload(body);
        const files = Array.isArray(req.files) ? req.files.slice(0, 5) : [];
        const result = await withZohoOrganization(organizationId, async () => {
            const journal = await createZohoJournal(payload);
            const journalId = String(journal?.journal_id || journal?.journalId || '').trim();
            const journalNumber = String(journal?.entry_number || journal?.journal_number || '').trim();
            const attachmentErrors = [];
            if (journalId && files.length) {
                for (const file of files) {
                    try {
                        await uploadJournalAttachment(journalId, {
                            buffer: file.buffer,
                            filename: file.originalname || 'attachment',
                            mimeType: file.mimetype || 'application/octet-stream',
                        });
                    } catch (err) {
                        attachmentErrors.push(`${file.originalname || 'file'}: ${err?.message || 'upload failed'}`);
                    }
                }
            }
            return { journalId, journalNumber, attachmentErrors };
        });

        const label = String(body.organizationLabel || 'Zoho').trim() || 'Zoho';
        const message = result.attachmentErrors.length
            ? `${label} journal ${result.journalNumber || ''} saved. Some attachments failed: ${result.attachmentErrors.join('; ')}`
            : status === 'published'
                ? `${label} journal ${result.journalNumber || ''} published in Zoho.`
                : `${label} journal ${result.journalNumber || ''} saved as draft in Zoho.`;
        return res.status(200).json({
            message,
            organizationId,
            status,
            journalId: result.journalId,
            journalNumber: result.journalNumber,
            attachmentErrors: result.attachmentErrors,
        });
    } catch (error) {
        console.error('[postSalaryZohoJournal]', error);
        return res.status(error.statusCode || 500).json({
            message: error.message || 'Could not save the Zoho salary journal.',
        });
    }
};

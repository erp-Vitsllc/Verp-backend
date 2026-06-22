import Fine from '../models/Fine.js';
import Payment from '../models/Payment.js';
import Loan from '../models/Loan.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import {
    dedupeEmployeeFinesByParty,
    resolveCompanyFinePayableAmount,
    resolveEmployeeFinePayableAmount,
} from './finePayableAmount.js';

const PAID_PAYMENT_STATUSES = ['Completed', 'Paid'];
const ACTIVE_FINE_STATUSES = ['Approved', 'Active', 'Paid', 'Completed'];

function getYearMonth(val) {
    if (!val) return 0;
    if (typeof val === 'string') {
        const parts = val.split(/[-/T ]/);
        if (parts.length >= 2) {
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            if (y > 1000 && m >= 1 && m <= 12) return y * 100 + m;
        }
    }
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return 0;
    return d.getFullYear() * 100 + (d.getMonth() + 1);
}

function addMonthsToYM(ym, months) {
    if (!ym) return 0;
    const y = Math.floor(ym / 100);
    const m = ym % 100;
    const date = new Date(y, m - 1 + months, 1);
    return date.getFullYear() * 100 + (date.getMonth() + 1);
}


function categorizeFine(f) {
    const fType = (f.fineType || f.category || f.subCategory || '').toLowerCase();
    if (fType.includes('vehicle')) return 'Vehicle';
    if (fType.includes('safety')) return 'Safety';
    if (fType.includes('project')) return 'Project';
    if (fType.includes('loss and damage')) return 'Loss';
    if (fType.includes('loss') || (fType.includes('damage') && !fType.includes('other'))) return 'Loss';
    if (fType.includes('property')) return 'Loss';
    return 'Other';
}

function emptyAggregates() {
    return {
        Vehicle: { amount: 0, paid: 0, count: 0, duration: 0 },
        Safety: { amount: 0, paid: 0, count: 0, duration: 0 },
        Project: { amount: 0, paid: 0, count: 0, duration: 0 },
        Loss: { amount: 0, paid: 0, count: 0, duration: 0 },
        Other: { amount: 0, paid: 0, count: 0, duration: 0 },
    };
}

function formatMonthYear(baseMonthStr, duration) {
    let startMonthStr = '-';
    let endMonthStr = '-';
    if (!baseMonthStr) return { startMonthYear: startMonthStr, endMonthYear: endMonthStr };

    try {
        let date;
        if (typeof baseMonthStr === 'string' && baseMonthStr.includes('-')) {
            const p = baseMonthStr.split('-');
            date = new Date(parseInt(p[0], 10), (parseInt(p[1], 10) || 1) - 1, 1);
        } else {
            date = new Date(baseMonthStr);
        }

        if (!Number.isNaN(date.getTime())) {
            const formatMY = (d) => `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()}`;
            startMonthStr = formatMY(date);
            const startYM = getYearMonth(baseMonthStr);
            const endYM = addMonthsToYM(startYM, (parseInt(duration, 10) || 1) - 1);
            const ey = Math.floor(endYM / 100);
            const em = endYM % 100;
            endMonthStr = `${em.toString().padStart(2, '0')}/${ey}`;
        }
    } catch {
        startMonthStr = String(baseMonthStr);
    }

    return { startMonthYear: startMonthStr, endMonthYear: endMonthStr };
}

function calculateServiceYears(joinDate) {
    if (!joinDate) return '-';
    const start = new Date(joinDate);
    if (Number.isNaN(start.getTime())) return '-';
    const now = new Date();
    let years = now.getFullYear() - start.getFullYear();
    let months = now.getMonth() - start.getMonth();
    let days = now.getDate() - start.getDate();
    if (days < 0) {
        months -= 1;
        const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        days += prevMonth.getDate();
    }
    if (months < 0) {
        years -= 1;
        months += 12;
    }
    const parts = [];
    if (years > 0) parts.push(`${years} Year${years > 1 ? 's' : ''}`);
    if (months > 0) parts.push(`${months} Month${months > 1 ? 's' : ''}`);
    if (days > 0 || parts.length === 0) parts.push(`${days} Day${days !== 1 ? 's' : ''}`);
    return parts.join(' ');
}

function approverName(user) {
    if (!user) return '';
    if (typeof user === 'string') return user;
    if (user.name) return user.name;
    return `${user.firstName || ''} ${user.lastName || ''}`.trim();
}

function workflowApproved(fine, roles) {
    return (fine.workflow || []).some(
        (w) => w.status === 'Approved' && roles.some((r) => (w.role || '').toLowerCase() === r.toLowerCase())
    );
}

function buildSignatureMeta(fine, { displayName, hodName, hrHODName, accountsHODName, ceoName }) {
    const finalized = ['Approved', 'Active', 'Paid', 'Completed'].includes(fine.fineStatus);
    const hrApproved = !!(fine.hrApprovedBy || workflowApproved(fine, ['HR']));
    const accountsApproved = !!(fine.accountsApprovedBy || workflowApproved(fine, ['Accounts']));
    const mgmtApproved = finalized && !!(fine.approvedBy || workflowApproved(fine, ['Management', 'CEO']));
    const hodApproved = !!(fine.managerApprovedBy || workflowApproved(fine, ['Manager', 'HOD']));

    return {
        employee: { show: finalized, name: displayName || '' },
        hod: { show: hodApproved, name: hodName || '' },
        hr: { show: hrApproved, name: approverName(fine.hrApprovedBy) || hrHODName || '' },
        accounts: { show: accountsApproved, name: approverName(fine.accountsApprovedBy) || accountsHODName || '' },
        management: {
            show: mgmtApproved,
            name: approverName(fine.approvedBy) || ceoName || 'MANAGEMENT',
            stamped: mgmtApproved,
        },
    };
}

function getPaidFromPayments(payments, fineDoc) {
    const fromPayments = payments
        .filter(
            (p) =>
                p.relatedEntityType === 'Fine' &&
                (String(p.relatedEntityId) === String(fineDoc._id) || p.referenceId === fineDoc.fineId)
        )
        .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    return Math.max(fromPayments, parseFloat(fineDoc.paidAmount) || 0);
}

function getLoanPaidFromPayments(payments, loanDoc) {
    const fromPayments = payments
        .filter(
            (p) =>
                (p.relatedEntityType === 'Loan' || p.paymentType === 'Loan' || p.paymentType === 'Advance') &&
                (String(p.relatedEntityId) === String(loanDoc._id) || p.referenceId === loanDoc.loanId)
        )
        .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    return Math.max(fromPayments, parseFloat(loanDoc.paidAmount) || 0);
}

function isCompanyFineContext(fine, targetEmpId) {
    return (
        !targetEmpId ||
        targetEmpId === 'VEGA-HR-0000' ||
        fine.responsibleFor === 'Company' ||
        fine.assignedEmployees?.some(
            (e) => e.employeeId === 'VEGA-HR-0000' || e.employeeName === 'Vega Digital IT Solutions'
        )
    );
}

function getCompanyShare(f) {
    return resolveCompanyFinePayableAmount(f);
}

/**
 * Build payment-aware fine form summary for detail view and PDF print.
 */
export async function buildFineFormSummary(fine, options = {}) {
    if (!fine) return null;

    const contextFineId = fine.fineId;
    const realEmployee = fine.assignedEmployees?.find((e) => e.employeeId && e.employeeId !== 'VEGA-HR-0000');
    const targetEmpId = options.employeeId || realEmployee?.employeeId || fine.employeeId;
    const isCompanyFine = isCompanyFineContext(fine, targetEmpId);

    const displayName = isCompanyFine
        ? (fine.company?.name ||
              fine.assignedEmployees?.find((e) => e.employeeId === 'VEGA-HR-0000')?.employeeName ||
              'Company')
        : (realEmployee?.employeeName ||
              `${realEmployee?.firstName || ''} ${realEmployee?.lastName || ''}`.trim());

    const { startMonthYear, endMonthYear } = formatMonthYear(
        fine.monthStart || fine.awardedDate,
        fine.payableDuration || 1
    );

    if (isCompanyFine) {
        const companyQuery = {
            fineStatus: { $in: ACTIVE_FINE_STATUSES },
            $or: [{ responsibleFor: 'Company' }, { 'assignedEmployees.employeeId': 'VEGA-HR-0000' }],
        };
        if (fine.company) {
            companyQuery.company = fine.company._id || fine.company;
        }

        const companyFines = await Fine.find(companyQuery).lean();

        const aggregates = emptyAggregates();
        let totalAmount = 0;
        let paidAmount = 0;

        companyFines.forEach((f) => {
            const share = getCompanyShare(f);
            const paid = parseFloat(f.paidAmount) || 0;
            const cat = categorizeFine(f);
            aggregates[cat].amount += share;
            aggregates[cat].paid += paid;
            aggregates[cat].count += 1;
            aggregates[cat].duration += parseInt(f.payableDuration, 10) || 1;
            totalAmount += share;
            paidAmount += paid;
        });

        const signatures = buildSignatureMeta(fine, {
            displayName,
            hodName: '',
            hrHODName: options.hrHODName,
            accountsHODName: options.accountsHODName,
            ceoName: options.ceoName,
        });

        return {
            isCompanyFine: true,
            startMonthYear,
            endMonthYear,
            nextSalaryDeduction: 0,
            aggregates,
            totalFineCount: companyFines.length,
            totalAmount,
            paidFineCount: companyFines.filter((f) => f.fineStatus === 'Paid' || (f.paidAmount || 0) >= getCompanyShare(f)).length,
            paidFineAmount: paidAmount,
            distinctTypesCount: Object.values(aggregates).filter((a) => a.count > 0).length,
            personalLoan: { amount: 0, duration: 0, paid: 0, count: 0 },
            salaryAdvance: { amount: 0, duration: 0, paid: 0, count: 0 },
            outstandingBalance: Math.max(0, getCompanyShare(fine) - (parseFloat(fine.paidAmount) || 0)),
            companyOutstanding: Math.max(0, totalAmount - paidAmount),
            signatures,
            employeeStats: null,
        };
    }

    const employee = await EmployeeBasic.findOne({ employeeId: targetEmpId })
        .populate('primaryReportee', 'firstName lastName employeeId')
        .lean();

    const employeeObjectId = employee?._id;
    const hodName = employee?.primaryReportee
        ? `${employee.primaryReportee.firstName || ''} ${employee.primaryReportee.lastName || ''}`.trim()
        : 'Manager';

    const allFines = await Fine.find({
        'assignedEmployees.employeeId': targetEmpId,
        fineStatus: { $in: ACTIVE_FINE_STATUSES },
    }).lean();

    const payments = employeeObjectId
        ? await Payment.find({
              paidBy: employeeObjectId,
              status: { $in: PAID_PAYMENT_STATUSES },
          }).lean()
        : [];

    const dedupedFines = dedupeEmployeeFinesByParty(allFines, targetEmpId);

    const aggregates = emptyAggregates();
    let totalAmount = 0;
    let paidAmount = 0;

    dedupedFines.forEach((f) => {
        const share = resolveEmployeeFinePayableAmount(f, targetEmpId);
        const paid = Math.min(getPaidFromPayments(payments, f), share);
        const cat = categorizeFine(f);
        aggregates[cat].amount += share;
        aggregates[cat].paid += paid;
        aggregates[cat].count += 1;
        aggregates[cat].duration += parseInt(f.payableDuration, 10) || 1;
        totalAmount += share;
        paidAmount += paid;
    });

    const paidFines = dedupedFines.filter((f) => {
        const share = resolveEmployeeFinePayableAmount(f, targetEmpId);
        const paid = Math.min(getPaidFromPayments(payments, f), share);
        return f.fineStatus === 'Paid' || (share > 0 && paid >= share);
    });

    const loans = await Loan.find({ employeeId: targetEmpId }).lean();
    const approvedLoans = loans.filter((l) => (l.approvalStatus || l.status || '').toLowerCase() === 'approved');
    const pLoans = approvedLoans.filter((l) => (l.type || '').toLowerCase() === 'loan');
    const sAdvances = approvedLoans.filter((l) => (l.type || '').toLowerCase() === 'advance');

    const personalLoan = {
        amount: pLoans.reduce((sum, l) => sum + (Number(l.amount) || 0), 0),
        duration: pLoans.reduce((sum, l) => sum + (Number(l.duration) || 0), 0),
        paid: pLoans.reduce((sum, l) => sum + getLoanPaidFromPayments(payments, l), 0),
        count: pLoans.length,
    };
    const salaryAdvance = {
        amount: sAdvances.reduce((sum, l) => sum + (Number(l.amount) || 0), 0),
        duration: sAdvances.reduce((sum, l) => sum + (Number(l.duration) || 0), 0),
        paid: sAdvances.reduce((sum, l) => sum + getLoanPaidFromPayments(payments, l), 0),
        count: sAdvances.length,
    };

    const loanInstallments = approvedLoans.reduce((sum, l) => {
        const amt = Number(l.amount) || 0;
        const dur = Number(l.duration) || 1;
        const pd = getLoanPaidFromPayments(payments, l);
        if (amt - pd > 0.5) return sum + amt / dur;
        return sum;
    }, 0);

    const now = new Date();
    const targetYM = addMonthsToYM(now.getFullYear() * 100 + (now.getMonth() + 1), 1);

    const nextSalaryDeduction = dedupedFines.reduce((sum, f) => {
        const isCurrent = f._id?.toString() === fine._id?.toString() || f.fineId === fine.fineId;
        const record = isCurrent ? fine : f;
        const share = resolveEmployeeFinePayableAmount(record, targetEmpId);
        if (share <= 0) return sum;

        const paid = Math.min(getPaidFromPayments(payments, record), share);
        const outstanding = share - paid;
        if (outstanding <= 0) return sum;

        const startYM = getYearMonth(record.monthStart || record.awardedDate);
        const duration = parseInt(record.payableDuration, 10) || 1;
        const endYM = addMonthsToYM(startYM, duration - 1);

        if (startYM > 0 && targetYM >= startYM && targetYM <= endYM) {
            return sum + share / duration;
        }
        return sum;
    }, 0);

    const visaExpiry =
        employee?.visaDetails?.employment?.expiryDate ||
        employee?.visaDetails?.spouse?.expiryDate ||
        employee?.visaDetails?.visit?.expiryDate ||
        null;

    const joiningDate =
        employee?.dateOfJoining || employee?.contractJoiningDate || employee?.joiningDate || null;

    const signatures = buildSignatureMeta(fine, {
        displayName:
            displayName ||
            `${employee?.firstName || ''} ${employee?.lastName || ''}`.trim(),
        hodName,
        hrHODName: options.hrHODName,
        accountsHODName: options.accountsHODName,
        ceoName: options.ceoName,
    });

    return {
        isCompanyFine: false,
        startMonthYear,
        endMonthYear,
        nextSalaryDeduction: Math.round(nextSalaryDeduction + loanInstallments),
        aggregates,
        totalFineCount: dedupedFines.length,
        totalAmount,
        paidFineCount: paidFines.length,
        paidFineAmount: paidAmount,
        distinctTypesCount: Object.values(aggregates).filter((a) => a.count > 0).length,
        personalLoan,
        salaryAdvance,
        outstandingBalance:
            totalAmount -
            paidAmount +
            (personalLoan.amount - personalLoan.paid) +
            (salaryAdvance.amount - salaryAdvance.paid),
        signatures,
        employeeStats: {
            visaExpiry,
            labourCardExpiry: employee?.labourCardDetails?.expiryDate || null,
            joiningDate,
            serviceYears: calculateServiceYears(joiningDate),
            department: employee?.department || '',
            designation: employee?.designation || '',
            hodName,
        },
    };
}

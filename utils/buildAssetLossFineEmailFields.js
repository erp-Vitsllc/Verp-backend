import { isMultiPartyFine } from './fineGroupClassification.js';
import { resolveEmployeeFinePayableAmount } from './finePayableAmount.js';
import { formatFineCalendarDate } from './fineCalendarDate.js';

function formatMoney(value) {
    return Number(value || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function computeAssetAging(purchaseDate) {
    if (!purchaseDate) return '—';
    const start = new Date(purchaseDate);
    if (Number.isNaN(start.getTime())) return '—';
    const end = new Date();
    let years = end.getFullYear() - start.getFullYear();
    let months = end.getMonth() - start.getMonth();
    if (end.getDate() < start.getDate()) months -= 1;
    if (months < 0) {
        years -= 1;
        months += 12;
    }
    const parts = [];
    if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
    if (months > 0) parts.push(`${months} month${months !== 1 ? 's' : ''}`);
    return parts.length ? parts.join(' ') : '0 months';
}

function mapPayableType(responsibleFor) {
    const rf = String(responsibleFor || 'Employee').trim();
    if (rf === 'Employee & Company') return 'Employee and Company';
    if (rf === 'Company') return 'Company';
    return 'Employee';
}

function defaultGetEmpShare(fine, assignedEmployeeId) {
    if (!fine) return 0;
    if (assignedEmployeeId) {
        const resolved = resolveEmployeeFinePayableAmount(fine, assignedEmployeeId);
        if (resolved > 0) return resolved;
    }
    if ((fine.responsibleFor || '').toLowerCase() === 'company') return 0;

    const realEmployees = (fine.assignedEmployees || []).filter(
        (e) => e.employeeId && !['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(e.employeeId),
    );
    const record = assignedEmployeeId
        ? realEmployees.find((e) => e.employeeId === assignedEmployeeId)
        : realEmployees[0];

    // Only use individualAmount when explicitly set (> 0); default 0 must not block fineAmount.
    if (record?.individualAmount > 0) {
        return parseFloat(record.individualAmount);
    }

    const employeeAmount = parseFloat(fine.employeeAmount || 0);
    const companyAmount = parseFloat(fine.companyAmount || 0);
    const sCharge = parseFloat(fine.serviceCharge || 0);
    const fineAmount = parseFloat(fine.fineAmount || fine.totalFineAmount || 0);
    const rf = String(fine.responsibleFor || 'Employee').trim();

    if (realEmployees.length === 1 && companyAmount === 0) {
        return fineAmount || employeeAmount + sCharge;
    }
    if (rf === 'Employee & Company' && employeeAmount > 0) {
        return employeeAmount + sCharge / 2;
    }
    return Math.max(0, fineAmount - companyAmount) / (realEmployees.length || 1);
}

function resolveTotalFine(fine) {
    const total = parseFloat(fine.totalFineAmount);
    if (total > 0) return total;
    const fineAmount = parseFloat(fine.fineAmount);
    if (fineAmount > 0) return fineAmount;
    const emp = parseFloat(fine.employeeAmount || 0);
    const comp = parseFloat(fine.companyAmount || 0);
    const sc = parseFloat(fine.serviceCharge || 0);
    if (emp + comp + sc > 0) return emp + comp + sc;
    return 0;
}

export function isLossDamageFineType(fine) {
    if (!fine) return false;
    const t = String(fine.fineType || '').toLowerCase();
    if (t.includes('loss') && (t.includes('damage') || t.includes('&'))) return true;
    return Boolean(fine.assetId || fine.assetObjectId);
}

/** VEHICLE FINE REPORT, SAFETY FINE REPORT, LOSS & DAMAGE REPORT, … */
export function reportTitleForFine(fine) {
    const type = String(fine?.fineType || '').trim();
    if (!type) return 'FINE REPORT';
    return `${type.toUpperCase()} REPORT`;
}

export function reportPdfFileSlug(fine) {
    return String(fine?.fineType || 'Fine')
        .replace(/[^a-zA-Z0-9]+/g, '')
        .replace(/^$/, 'Fine');
}

export function reportPdfFileName(fine, suffix = '') {
    const id = fine?.fineId || fine?._id || 'fine';
    return `${reportPdfFileSlug(fine)}Report-${id}${suffix ? `-${suffix}` : ''}.pdf`;
}

export function reportPdfLabel(fine) {
    const type = String(fine?.fineType || '').trim();
    return type ? `${type} Report` : 'Fine Report';
}

export function buildAssetLossFineEmailFields(
    fine,
    {
        employeeName,
        hodName,
        assignedEmployeeId,
        fineSummaries = {},
        formatDate,
    },
) {
    const serviceCharge = parseFloat(fine.serviceCharge || 0) || 0;
    const discount = parseFloat(fine.discount || 0) || 0;
    const totalFine = resolveTotalFine(fine);
    const actualFineAmount = Math.max(0, totalFine - serviceCharge + discount);

    const isGroupFine = isMultiPartyFine(fine);

    const yourPayable = defaultGetEmpShare(fine, assignedEmployeeId);
    const duration = Math.max(1, parseInt(fine.payableDuration, 10) || 1);
    const monthlyDeduction = yourPayable / duration;
    const othersPayment = Math.max(0, totalFine - yourPayable);

    const purchaseDate = fine.assetPurchaseDate || '';
    const depreciation = parseFloat(fine.assetDepreciationAmount || 0) || 0;
    const purchaseCost = Math.max(0, actualFineAmount + depreciation) || parseFloat(fine.assetPurchaseCost || 0) || 0;

    const fmt = formatDate || formatFineCalendarDate;

    return {
        fineId: fine.fineId || '—',
        reportDate: fmt(fine.awardedDate || fine.createdAt),
        employeeName: employeeName || '—',
        hodName: hodName || '—',
        description: fine.description || '—',
        reportTitle: reportTitleForFine(fine),
        fineType: fine.fineType || 'Fine',
        assetPurchaseDate: purchaseDate ? fmt(purchaseDate) : '—',
        assetPurchaseCost: purchaseCost,
        assetAging: computeAssetAging(purchaseDate),
        fineCategory: isGroupFine ? 'Group Fine' : 'Single Fine',
        actualFineAmount,
        serviceCharge,
        discount,
        totalFine,
        payableTypeLabel: mapPayableType(fine.responsibleFor),
        yourFinePayment: yourPayable,
        othersPayment,
        monthlyDeduction,
        sourceOfDeduction: fine.sourceOfIncome || 'Salary',
        deductionStart: fineSummaries.startMonthYear || fine.monthStart || '—',
        deductionEnd: fineSummaries.endMonthYear || '—',
    };
}

export function parseAmountForWords(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') {
        return Math.floor(Math.abs(value));
    }
    const cleaned = String(value)
        .replace(/,/g, '')
        .replace(/\s*AED\s*/gi, '')
        .trim();
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? Math.floor(Math.abs(parsed)) : 0;
}

export function amountToWords(n) {
    const num = parseAmountForWords(n);
    if (num === 0) return 'ZERO';
    const ones = [
        '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
        'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
        'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
    ];
    const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

    const under1000 = (x) => {
        if (x < 20) return ones[x];
        if (x < 100) {
            const t = tens[Math.floor(x / 10)];
            const o = x % 10 ? ` ${ones[x % 10]}` : '';
            return `${t}${o}`.trim();
        }
        const h = ones[Math.floor(x / 100)];
        const rem = x % 100;
        return `${h} HUNDRED${rem ? ` ${under1000(rem)}` : ''}`;
    };

    const underMillion = (x) => {
        if (x < 1000) return under1000(x);
        const th = Math.floor(x / 1000);
        const rem = x % 1000;
        return `${under1000(th)} THOUSAND${rem ? ` ${under1000(rem)}` : ''}`.trim();
    };

    if (num < 1000000) return underMillion(num);

    const millions = Math.floor(num / 1000000);
    const rem = num % 1000000;
    return `${underMillion(millions)} MILLION${rem ? ` ${underMillion(rem)}` : ''}`.trim();
}

/**
 * Plain-text acknowledgement paragraph (employee name + payable amount in words).
 */
export function buildAssetLossFineAcknowledgementText(employeeName, payableAmount) {
    const name = String(employeeName || '—').trim() || '—';
    const amountWords = amountToWords(payableAmount);
    const aed = formatMoney(payableAmount);
    return (
        `I, Mr./Ms. ${name}, acknowledge that the fine stated above was incurred under my responsibility. ` +
        `I understand and accept accountability for ${amountWords} DIRHAMS (AED ${aed}) and ` +
        `authorize deduction of the specified amount from the source of income shown above.`
    );
}

/**
 * HTML acknowledgement paragraph with wrapping spans for name and amount.
 */
export function buildAssetLossFineAcknowledgementHtml(employeeName, payableAmount, { valueColor = '#cc0000' } = {}) {
    const name = String(employeeName || '—').trim() || '—';
    const amountWords = amountToWords(payableAmount);
    const aed = formatMoney(payableAmount);
    return (
        `I, Mr./Ms. <strong>${escapeHtml(name)}</strong>, acknowledge that the fine stated above was incurred under my responsibility. ` +
        `I understand and accept accountability for ` +
        `<strong style="color:${valueColor};">${escapeHtml(amountWords)} DIRHAMS (AED ${escapeHtml(aed)})</strong> and ` +
        `authorize deduction of the specified amount from the source of income shown above.`
    );
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export { formatMoney };

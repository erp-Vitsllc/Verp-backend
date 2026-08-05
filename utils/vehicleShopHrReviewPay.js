/**
 * Persist HR Approval company/employee pay into service remark so
 * Initiate Service and Accounts stay aligned with absolute amounts.
 */
export function applyShopHrPayTotalsToRemark(remark, { approvedAmount, companyPay, employeePay } = {}) {
    if (!remark || typeof remark !== 'object') return remark;

    const hasPayInput =
        approvedAmount != null || companyPay != null || employeePay != null;
    if (!hasPayInput) return remark;

    const approved = Math.max(
        0,
        Number(approvedAmount) ||
            Number(remark.hrReviewApprovedAmount) ||
            Number(remark.estimatedCost) ||
            0,
    );
    let company = Math.max(0, Number(companyPay));
    let employee = Math.max(0, Number(employeePay));
    if (!Number.isFinite(company)) company = Number(remark.hrReviewCompanyPay) || 0;
    if (!Number.isFinite(employee)) employee = Number(remark.hrReviewEmployeePay) || 0;

    if (approved > 0) {
        // Prefer employee when both provided; keep company = approved - employee.
        if (Number.isFinite(Number(employeePay))) {
            employee = Math.min(employee, approved);
            company = Math.max(0, approved - employee);
        } else if (Number.isFinite(Number(companyPay))) {
            company = Math.min(company, approved);
            employee = Math.max(0, approved - company);
        }
    }

    let paymentByMode = remark.paymentByMode || 'company';
    if (employee <= 0 && company > 0) paymentByMode = 'company';
    else if (company <= 0 && employee > 0) paymentByMode = 'person';
    else if (company > 0 && employee > 0) paymentByMode = 'split';

    const employeePct =
        approved > 0 ? Math.min(100, Math.max(0, Math.round((employee / approved) * 100))) : 0;
    const companyPct = Math.min(100, Math.max(0, 100 - employeePct));

    remark.hrReviewApprovedAmount = approved || remark.hrReviewApprovedAmount;
    remark.hrReviewCompanyPay = company;
    remark.hrReviewEmployeePay = employee;
    remark.estimatedCost = approved || remark.estimatedCost;
    remark.companyPayPercent = String(companyPct);
    remark.employeePayPercent = String(employeePct);
    remark.paymentByMode = paymentByMode;
    remark.companyPayAmount = company;
    remark.employeePayAmount = employee;

    return remark;
}

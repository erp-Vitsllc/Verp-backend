import EmployeeBasic from "../models/EmployeeBasic.js";

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Set contract joining date from the first visa issue date only.
 * Skips renewals and never overwrites an existing value.
 */
export async function setContractJoiningDateFromFirstVisa(
    employeeId,
    issueDate,
    { isRenewal = false } = {},
) {
    if (!employeeId || !issueDate || isRenewal) return false;

    const parsed = parseDate(issueDate);
    if (!parsed) return false;

    const basic = await EmployeeBasic.findOne({ employeeId })
        .select("contractJoiningDate")
        .lean();
    if (basic?.contractJoiningDate) return false;

    await EmployeeBasic.updateOne(
        { employeeId },
        { $set: { contractJoiningDate: parsed } },
    );
    return true;
}

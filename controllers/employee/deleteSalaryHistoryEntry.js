import mongoose from "mongoose";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import { resolveEmployeeId, getCompleteEmployee, syncSalaryTopLevelFromHistory } from "../../services/employeeService.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { awaitAdminDeletionArchive } from "../../utils/adminDeletionArchiveRun.js";
import { hasPermission } from "../../services/permissionService.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";
import { scheduleEmployeeProfileFileChangeHrEmailForRequest } from "../../utils/employeeInformativeHrNotify.js";

const monthKeyFromDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${d.getMonth()}`;
};

// @route   DELETE /api/Employee/:id/salary-history/:historyId
// @access  Admin or hrm_employees_view_salary delete permission
export const deleteSalaryHistoryEntry = async (req, res) => {
    try {
        const userId = req.user?.id || req.user?._id;
        const isAdminUser = await isReqUserAdmin(req.user);
        const hasSalaryDelete =
            userId && (await hasPermission(userId, "hrm_employees_view_salary", "delete"));
        if (!isAdminUser && !hasSalaryDelete) {
            return res.status(403).json({
                message: "You do not have permission to delete salary history records.",
            });
        }

        const { id, historyId } = req.params;
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const salaryDoc = await EmployeeSalary.findOne({ employeeId: employee.employeeId });
        if (!salaryDoc?.salaryHistory?.length) {
            return res.status(404).json({ message: "Salary history not found" });
        }

        const history = salaryDoc.salaryHistory;
        let target = null;

        if (mongoose.Types.ObjectId.isValid(historyId)) {
            target = history.find((h) => String(h._id) === String(historyId));
        }
        if (!target) {
            const idx = Number.parseInt(historyId, 10);
            if (Number.isInteger(idx) && idx >= 0 && idx < history.length) {
                target = history[idx];
            }
        }

        if (!target) {
            return res.status(404).json({ message: "Salary history entry not found" });
        }

        if (history.length <= 1) {
            return res.status(400).json({
                message: "At least one salary record is required and cannot be deleted.",
            });
        }

        const targetId = target._id;
        const monthKey = monthKeyFromDate(target.fromDate);
        const targetSnapshot = target.toObject ? target.toObject() : { ...target };

        if (isAdminUser) {
            await awaitAdminDeletionArchive(req, {
                moduleName: "Employee Salary History",
                recordId: employee.employeeId,
                details: `Salary history ${targetSnapshot?.month || monthKey || historyId}`,
                deletedPayload: { employeeId: employee.employeeId, salaryHistoryEntry: targetSnapshot },
            });
        }

        await EmployeeSalary.updateOne(
            { employeeId: employee.employeeId },
            { $pull: { salaryHistory: { _id: targetId } } },
        );

        if (monthKey) {
            const refreshed = await EmployeeSalary.findOne({ employeeId: employee.employeeId }).lean();
            const duplicateIds = (refreshed?.salaryHistory || [])
                .filter((h) => monthKeyFromDate(h.fromDate) === monthKey)
                .map((h) => h._id)
                .filter(Boolean);

            if (duplicateIds.length) {
                await EmployeeSalary.updateOne(
                    { employeeId: employee.employeeId },
                    { $pull: { salaryHistory: { _id: { $in: duplicateIds } } } },
                );
            }
        }

        await purgeEmployeeOldDocuments(employee.employeeId, {
            types: [...PURGE_TYPES.salary, `salary (${target.month || ""})`],
            purgeDeletedArchiveReason: true,
        });

        await syncSalaryTopLevelFromHistory(employee.employeeId);

        const completeEmployee = await getCompleteEmployee(employee.employeeId);
        if (!completeEmployee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        scheduleEmployeeProfileFileChangeHrEmailForRequest({
            employeeId: employee.employeeId,
            sectionKey: "salary",
            sectionLabel: "Salary History",
            action: "deleted",
            actor: req.user,
        });

        return res.status(200).json({
            message: "Salary history entry deleted successfully",
            employee: completeEmployee,
        });
    } catch (error) {
        console.error("deleteSalaryHistoryEntry:", error);
        return res.status(500).json({
            message: "Failed to delete salary history entry",
            error: error.message,
        });
    }
};

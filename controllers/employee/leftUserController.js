import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { checkLeftUserEligibility } from "../../utils/employeeLeftUserEligibility.js";
import { applyEmployeeLeftUserStatus, LEFT_USER_STATUS } from "../../utils/applyEmployeeLeftUserStatus.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import { queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { notifyLeftUserPendingHr } from "../../utils/employeeLeftUserWorkflow.js";

export const getLeftUserEligibility = async (req, res) => {
    try {
        const employee = await getCompleteEmployee(req.params.id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const result = await checkLeftUserEligibility(employee);
        return res.status(200).json(result);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};

export const markEmployeeLeftUser = async (req, res) => {
    try {
        const employee = await EmployeeBasic.findOne({
            $or: [{ employeeId: req.params.id }, { _id: req.params.id }],
        });

        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        if (employee.status === LEFT_USER_STATUS) {
            return res.status(400).json({ message: "Employee is already marked as Left User." });
        }

        const fullEmployee = await getCompleteEmployee(employee.employeeId);
        const { eligible, blockers } = await checkLeftUserEligibility(fullEmployee);

        if (!eligible) {
            return res.status(400).json({
                message: blockers[0]?.message || "Employee cannot be marked as Left User.",
                blockers,
            });
        }

        const isDesignatedHr = await isRequestUserDesignatedFlowchartHr(req);

        if (!isDesignatedHr) {
            await queueOrTriggerProfileChange({
                employeeId: employee.employeeId,
                actor: req.user,
                reason: "Left User status requested",
                employeeBasic: employee.toObject ? employee.toObject() : employee,
                changeEntry: {
                    card: "Work Details",
                    reason: "Mark as Left User",
                    section: "workDetails",
                    changeType: "update",
                    targetIndex: null,
                    previousData: { status: employee.status },
                    proposedData: { status: LEFT_USER_STATUS },
                },
            });

            try {
                await notifyLeftUserPendingHr({
                    req,
                    employee: {
                        _id: employee._id,
                        employeeId: employee.employeeId,
                        firstName: employee.firstName,
                        lastName: employee.lastName,
                        status: employee.status,
                    },
                    previousStatus: employee.status,
                });
            } catch (notifyErr) {
                console.error("[markEmployeeLeftUser] notifyLeftUserPendingHr:", notifyErr);
            }

            const completeEmployee = await getCompleteEmployee(employee.employeeId);
            delete completeEmployee.password;

            return res.status(200).json({
                message: "Left User change queued for HR activation approval.",
                queuedForHrApproval: true,
                employee: completeEmployee,
            });
        }

        await applyEmployeeLeftUserStatus(employee);

        const completeEmployee = await getCompleteEmployee(employee.employeeId);
        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee marked as Left User.",
            queuedForHrApproval: false,
            employee: completeEmployee,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};

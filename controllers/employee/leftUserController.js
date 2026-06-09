import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { getCompleteEmployee } from "../../services/employeeService.js";
import { checkLeftUserEligibility } from "../../utils/employeeLeftUserEligibility.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

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

        if (employee.status === "Left User") {
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

        employee.status = "Left User";
        employee.enablePortalAccess = false;
        if (String(employee.profileStatus || "").toLowerCase() === "active") {
            employee.profileStatus = "inactive";
        }
        await employee.save();

        await User.findOneAndUpdate(
            { employeeId: employee.employeeId },
            { $set: { enablePortalAccess: false } },
        );

        await triggerProfileReactivationIfNeeded({
            employeeId: employee.employeeId,
            actor: req.user,
            reason: "Employee marked as Left User",
            changeEntry: null,
            trackDefaultChange: true,
        });

        const completeEmployee = await getCompleteEmployee(employee.employeeId);
        delete completeEmployee.password;

        return res.status(200).json({
            message: "Employee marked as Left User.",
            employee: completeEmployee,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};

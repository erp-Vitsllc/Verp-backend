import EmployeeBasic from "../models/EmployeeBasic.js";
import { getDepartmentHOD } from "./getDepartmentHOD.js";

const pickEmployeeEmail = (emp) => (emp?.companyEmail || "").trim() || null;

/**
 * Resolve Flowchart HR to an EmployeeBasic document for dashboard + email.
 * @returns {{ employee: object, email: string } | { error: string, message: string }}
 */
export const resolveFlowchartHrEmployee = async () => {
    const hrFromFlow = await getDepartmentHOD("hr");
    if (!hrFromFlow) {
        return {
            error: "FLOWCHART_HR_MISSING",
            message:
                "No active HR is configured in the Flowchart. Add HR under Flowchart (category: hr, status: Active) before sending profile activation.",
        };
    }

    let doc = hrFromFlow;
    if (!doc._id && doc.employeeId) {
        const raw = String(doc.employeeId).trim();
        const parts = raw.split(/\s+/).filter(Boolean);
        const pattern = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
        const re = pattern ? new RegExp(`^${pattern}$`, "i") : null;
        doc = re
            ? await EmployeeBasic.findOne({ employeeId: { $regex: re } }).select(
                  "_id employeeId firstName lastName companyEmail workEmail personalEmail email"
              )
            : null;
        if (!doc) {
            return {
                error: "FLOWCHART_HR_UNRESOLVED",
                message:
                    "HR is listed in the Flowchart but is not linked to an employee record. Open Flowchart and link the HR row to an employee (empObjectId), or ensure the employeeId matches Employee Basic.",
            };
        }
    }

    if (!doc?._id) {
        return {
            error: "FLOWCHART_HR_UNRESOLVED",
            message:
                "HR is listed in the Flowchart but could not be matched to an employee record. Fix the Flowchart HR entry before sending profile activation.",
        };
    }

    const email = pickEmployeeEmail(doc);
    if (!email) {
        return {
            error: "HR_EMAIL_MISSING",
            message:
                "The Flowchart HR contact has no company email. First add company email address on the HR profile.",
        };
    }

    return { employee: doc, email };
};

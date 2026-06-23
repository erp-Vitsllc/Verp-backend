import EmployeeBasic from "../models/EmployeeBasic.js";
import {
    isProbationPeriodComplete,
    resolveProbationStartDate,
} from "./probationStartDate.js";

const SYNCABLE_STATUSES = new Set(["Probation", "Permanent"]);

/**
 * Sync Probation ↔ Permanent from employment-visa start date + probation months.
 * Runs on every employee profile load (refresh / login / get by id).
 */
export const syncProbationStatusFromEmploymentVisa = async (employeeBasic, visaRecord = null) => {
    if (!employeeBasic?._id) return employeeBasic;

    const currentStatus = String(employeeBasic.status || "").trim();
    if (!SYNCABLE_STATUSES.has(currentStatus)) return employeeBasic;

    const startDate = resolveProbationStartDate(employeeBasic, visaRecord);
    if (!startDate) return employeeBasic;

    const probationPeriod =
        employeeBasic.probationPeriod !== undefined && employeeBasic.probationPeriod !== null
            ? employeeBasic.probationPeriod
            : 6;

    const complete = isProbationPeriodComplete(startDate, probationPeriod);
    if (complete === null) return employeeBasic;

    let nextStatus = currentStatus;
    let nextProbationPeriod = employeeBasic.probationPeriod;

    if (complete && currentStatus === "Probation") {
        nextStatus = "Permanent";
        nextProbationPeriod = null;
    } else if (!complete && currentStatus === "Permanent") {
        nextStatus = "Probation";
        if (nextProbationPeriod === undefined || nextProbationPeriod === null) {
            nextProbationPeriod = 6;
        }
    }

    if (nextStatus === currentStatus) return employeeBasic;

    const update = {
        $set: {
            status: nextStatus,
            probationPeriod: nextProbationPeriod,
        },
    };
    if (nextStatus === "Permanent") {
        update.$unset = { probationChangeRequest: "" };
    }

    try {
        const updatedEmployee = await EmployeeBasic.findByIdAndUpdate(
            employeeBasic._id,
            update,
            { new: true },
        )
            .select("-documents.document.data -trainingDetails.certificate.data")
            .lean();

        console.log(
            `[ProbationSync] Employee ${employeeBasic.employeeId}: ${currentStatus} → ${nextStatus} (visa start ${startDate.toISOString().slice(0, 10)}, ${probationPeriod}mo)`,
        );

        return updatedEmployee || { ...employeeBasic, status: nextStatus, probationPeriod: nextProbationPeriod };
    } catch (error) {
        console.error(`[ProbationSync] Failed for ${employeeBasic.employeeId}:`, error);
        return employeeBasic;
    }
};

/** @deprecated Use syncProbationStatusFromEmploymentVisa */
export const checkAndUpdateProbationStatus = syncProbationStatusFromEmploymentVisa;

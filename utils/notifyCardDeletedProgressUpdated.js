import mongoose from "mongoose";
import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { resolveFlowchartHrEmployee } from "./resolveFlowchartHrEmployee.js";
import { resolveProfileActivationSubmitterId } from "./resolveProfileActivationSubmitterId.js";
import { actorDisplayName } from "./profileFileChangeHrNotify.js";

export const CARD_DELETED_PROGRESS_TYPE = "Card Deleted Progress";

/**
 * Dashboard bell notification after a profile card delete — visible on Company and Employee list pages.
 */
export async function notifyCardDeletedProgressUpdated({
    req,
    entityType,
    entityMongoId,
    entityDisplayId = "",
    entityName = "",
    cardLabel = "Card",
    cardKey = "",
    progressPercentage = null,
}) {
    try {
        if (!entityMongoId) return;

        const assigneeIds = new Set();
        const actorId = await resolveProfileActivationSubmitterId(req);
        if (actorId) assigneeIds.add(String(actorId));

        const hrResolved = await resolveFlowchartHrEmployee();
        if (hrResolved?.employee?._id) {
            assigneeIds.add(String(hrResolved.employee._id));
        }

        if (!assigneeIds.size) return;

        const extra3 = JSON.stringify({
            entityType,
            entityMongoId: String(entityMongoId),
            entityDisplayId: String(entityDisplayId || ""),
            cardKey: String(cardKey || ""),
            progressPercentage,
        });

        const requestId = new mongoose.Types.ObjectId();
        const actorName = actorDisplayName(req.user);
        const subjectName =
            entityName ||
            entityDisplayId ||
            (entityType === "company" ? "Company" : "Employee");

        await Promise.all(
            [...assigneeIds].map(async (assigneeId) => {
                const assignee = await EmployeeBasic.findById(assigneeId)
                    .select("employeeId firstName lastName")
                    .lean();
                if (!assignee?._id) return;

                await DashboardAction.create({
                    assignedTo: assignee._id,
                    assignedToEmpId: assignee.employeeId,
                    requestId,
                    requestType: CARD_DELETED_PROGRESS_TYPE,
                    status: "Pending",
                    subjectEmployeeId: String(entityDisplayId || entityMongoId),
                    subjectName,
                    requestedByName: actorName,
                    extra1: cardLabel,
                    extra2: "Card deleted and progress updated",
                    extra3,
                });
            }),
        );
    } catch (error) {
        console.error("[notifyCardDeletedProgressUpdated]", error?.message || error);
    }
}

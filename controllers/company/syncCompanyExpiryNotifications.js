import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { isRequestUserDesignatedFlowchartHr } from "../../utils/isDesignatedFlowchartHr.js";
import {
    reconcileCompanyDocumentExpiryDashboard,
    syncAllCompaniesDocumentExpiryDashboard,
} from "../../utils/processDocumentExpiryReminders.js";

const canSyncExpiryNotifications = async (req) =>
    (await isReqUserAdmin(req.user)) || (await isRequestUserDesignatedFlowchartHr(req));

/** Flowchart HR / admin: rebuild document-expiry dashboard tasks from live company profiles. */
export const syncCompanyExpiryNotifications = async (req, res) => {
    try {
        if (!(await canSyncExpiryNotifications(req))) {
            return res.status(403).json({ message: "Only Flowchart HR or admin can sync expiry notifications." });
        }

        await syncAllCompaniesDocumentExpiryDashboard();

        return res.status(200).json({
            message: "Company document expiry notifications synced.",
            ok: true,
        });
    } catch (error) {
        console.error("[syncCompanyExpiryNotifications]", error);
        return res.status(500).json({
            message: error.message || "Failed to sync company expiry notifications.",
        });
    }
};

/** Rebuild expiry dashboard tasks for one company (after document save). */
export const syncOneCompanyExpiryNotifications = async (req, res) => {
    try {
        if (!(await canSyncExpiryNotifications(req))) {
            return res.status(403).json({ message: "Only Flowchart HR or admin can sync expiry notifications." });
        }

        const { id } = req.params;
        await reconcileCompanyDocumentExpiryDashboard(id);

        return res.status(200).json({
            message: "Company document expiry notifications synced.",
            ok: true,
        });
    } catch (error) {
        console.error("[syncOneCompanyExpiryNotifications]", error);
        return res.status(500).json({
            message: error.message || "Failed to sync company expiry notifications.",
        });
    }
};

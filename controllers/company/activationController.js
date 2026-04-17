import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress, submitCompanyActivation } from "../../utils/companyActivation.js";
import { syncDashboardAction } from "../../utils/syncDashboard.js";
import { formatActivationAttachmentLine, shortenUrlsInString } from "../../utils/shortenUrlsInString.js";

const resolveCompanyById = async (id) => {
    return Company.findOne({
        $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
    });
};

export const submitCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason, description, attachment, attachmentName } = req.body || {};
        const company = await resolveCompanyById(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        if (!reason || !String(reason).trim() || !description || !String(description).trim()) {
            return res.status(400).json({
                message: "Reason and description are required for activation submission.",
            });
        }

        const reasonText = String(reason).trim();
        const descriptionText = String(description).trim();
        const rawAtt = attachment != null ? String(attachment).trim() : "";
        const attachmentLineFull = rawAtt ? `Attachment: ${rawAtt}` : null;
        const attachmentLineShort =
            formatActivationAttachmentLine(attachment, attachmentName) ||
            (rawAtt ? shortenUrlsInString(`Attachment: ${rawAtt}`) : null);

        const combinedFull = `Reason: ${reasonText}${descriptionText ? ` | Description: ${descriptionText}` : ""}${attachmentLineFull ? ` | ${attachmentLineFull}` : ""}`;
        const combinedDashboard = `Reason: ${reasonText}${descriptionText ? ` | Description: ${descriptionText}` : ""}${attachmentLineShort ? ` | ${attachmentLineShort}` : ""}`;
        const dashboardSummary = shortenUrlsInString(combinedDashboard);

        const result = await submitCompanyActivation({
            companyId: company._id,
            actor: req.user,
            reason: combinedFull,
            dashboardSummary,
            force: false,
        });

        if (!result.ok) {
            const status = result.blocked ? 400 : 500;
            return res.status(status).json({
                message: result.message,
                activationProgress: result.progress || calculateCompanyActivationProgress(company.toObject()),
            });
        }

        const refreshed = await Company.findById(company._id);
        return res.status(200).json({
            message: "Company sent for HR activation review successfully.",
            company: refreshed,
            activationProgress: calculateCompanyActivationProgress(refreshed.toObject()),
        });
    } catch (error) {
        console.error("submitCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to submit company activation request" });
    }
};

export const approveCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const company = await resolveCompanyById(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        company.status = "Active";
        company.activationStatus = "active";
        if (!Array.isArray(company.activationWorkflow)) company.activationWorkflow = [];
        company.activationWorkflow.push({
            role: "HR",
            assignedTo: req.user?._id || null,
            status: "active",
            assignedAt: new Date(),
            actionedAt: new Date(),
            comment: "Company activation approved",
        });
        await company.save();

        try {
            await syncDashboardAction({
                requestId: company._id,
                requestType: "Company Activation",
                status: "Approved",
                actionedBy: req.user?.employeeObjectId || req.user?._id,
                comment: "Company activation approved",
            });
        } catch (syncErr) {
            console.error("[approveCompanyActivationRequest] Dashboard sync error:", syncErr);
        }

        return res.status(200).json({
            message: "Company activation approved successfully.",
            company,
            activationProgress: calculateCompanyActivationProgress(company.toObject()),
        });
    } catch (error) {
        console.error("approveCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to approve company activation request" });
    }
};

export const rejectCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};
        const company = await resolveCompanyById(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        company.status = "Inactive";
        company.activationStatus = "rejected";
        if (!Array.isArray(company.activationWorkflow)) company.activationWorkflow = [];
        company.activationWorkflow.push({
            role: "HR",
            assignedTo: req.user?._id || null,
            status: "rejected",
            assignedAt: new Date(),
            actionedAt: new Date(),
            comment: reason || "Company activation rejected",
        });
        await company.save();

        try {
            await syncDashboardAction({
                requestId: company._id,
                requestType: "Company Activation",
                status: "Rejected",
                actionedBy: req.user?.employeeObjectId || req.user?._id,
                comment: reason || "Company activation rejected",
            });
        } catch (syncErr) {
            console.error("[rejectCompanyActivationRequest] Dashboard sync error:", syncErr);
        }

        return res.status(200).json({
            message: "Company activation rejected.",
            company,
            activationProgress: calculateCompanyActivationProgress(company.toObject()),
        });
    } catch (error) {
        console.error("rejectCompanyActivationRequest error:", error);
        return res.status(500).json({ message: error.message || "Failed to reject company activation request" });
    }
};

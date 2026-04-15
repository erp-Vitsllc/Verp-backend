import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress, submitCompanyActivation } from "../../utils/companyActivation.js";

const resolveCompanyById = async (id) => {
    return Company.findOne({
        $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }],
    });
};

export const submitCompanyActivationRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const company = await resolveCompanyById(id);
        if (!company) return res.status(404).json({ message: "Company not found" });

        const result = await submitCompanyActivation({
            companyId: company._id,
            actor: req.user,
            reason: "Company submitted for activation",
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

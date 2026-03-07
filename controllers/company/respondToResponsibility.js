import Company from "../../models/Company.js";
import DashboardAction from "../../models/DashboardAction.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import AssetItem from "../../models/AssetItem.js";
import AssetHistory from "../../models/AssetHistory.js";

/**
 * @desc    Approve or Reject a responsibility assignment
 * @route   PUT /api/Company/:id/respond-responsibility
 * @access  Private
 */
export const respondToResponsibility = async (req, res) => {
    try {
        const { id } = req.params; // Company ObjectId or companyId
        const { action, actionId, category } = req.body; // 'Approve' or 'Reject', dashboardAction ID, category name

        if (!['Approve', 'Reject'].includes(action)) {
            return res.status(400).json({ message: "Invalid action." });
        }

        // 1. Find the company
        let company = await Company.findOne({
            $or: [{ _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }, { companyId: id }]
        });

        if (!company) {
            return res.status(404).json({ message: "Company not found" });
        }

        // 2. Find the dashboard action
        const dashboardAction = await DashboardAction.findById(actionId);
        if (!dashboardAction) {
            return res.status(404).json({ message: "Dashboard action not found" });
        }

        if (dashboardAction.status !== 'Pending') {
            return res.status(400).json({ message: "Action already processed." });
        }

        // 3. Update Company responsibilities
        const isAdmin = ['Admin', 'CEO', 'Director', 'General Manager'].includes(req.user.role) || req.user.isAdmin;

        if (dashboardAction.isGlobal) {
            const allCompanies = await Company.find({});
            for (const comp of allCompanies) {
                const resps = comp.responsibilities || [];
                // If it's the target employee or an admin, they can process it
                const index = resps.findIndex(r =>
                    r.category === category &&
                    (isAdmin || r.empObjectId?.toString() === req.user.employeeObjectId?.toString()) &&
                    r.status === 'Pending'
                );

                if (index !== -1) {
                    if (action === 'Approve') {
                        resps[index].status = 'Active';
                        // Remove OLD Active ones for this category
                        comp.responsibilities = resps.filter((r, i) =>
                            i === index || r.category !== category || r.status !== 'Active'
                        );
                    } else {
                        comp.responsibilities.splice(index, 1);
                    }
                    await comp.save();
                }
            }
        } else {
            const responsibilities = company.responsibilities || [];
            const index = responsibilities.findIndex(r =>
                r.category === category &&
                (isAdmin || r.empObjectId?.toString() === req.user.employeeObjectId?.toString()) &&
                r.status === 'Pending'
            );

            if (index === -1) {
                return res.status(404).json({ message: "Pending responsibility not found for processing." });
            }

            if (action === 'Approve') {
                responsibilities[index].status = 'Active';
                company.responsibilities = responsibilities.filter((r, idx) =>
                    idx === index || r.category !== category || r.status !== 'Active'
                );
            } else {
                company.responsibilities.splice(index, 1);
            }
            await company.save();
        }

        // 4. If Asset Controller approved, assign unassigned assets to them
        if (action === 'Approve' && category === 'assetcontroller') {
            try {
                const unassignedAssets = await AssetItem.find({
                    status: { $in: ['Unassigned', 'Returned'] }
                });

                const currentEmpId = req.user.employeeObjectId;
                const newController = await EmployeeBasic.findById(currentEmpId).select('_id employeeId');
                const actorName = req.user.name || 'New Controller';

                if (unassignedAssets.length > 0) {
                    await AssetItem.updateMany(
                        { _id: { $in: unassignedAssets.map(a => a._id) } },
                        {
                            $set: {
                                assignedTo: currentEmpId,
                                assignedBy: currentEmpId,
                                acceptanceStatus: 'Accepted'
                            }
                        }
                    );

                    // Log history for each
                    const historyEntries = unassignedAssets.map(a => ({
                        assetId: a._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `Responsibility approved. Asset transitioned to new controller: ${actorName}`,
                        date: new Date(),
                        details: { type: 'ControllerHandover', role: 'assetcontroller' }
                    }));
                    await AssetHistory.insertMany(historyEntries);

                    console.log(`[respondToResponsibility] Assigned ${unassignedAssets.length} assets to new controller ${actorName}`);
                }

                // Reassign 'Draft' assets that require action to the new controller
                const draftAssets = await AssetItem.find({ status: 'Draft', actionRequiredBy: { $ne: null } });
                if (draftAssets.length > 0) {
                    await AssetItem.updateMany(
                        { _id: { $in: draftAssets.map(a => a._id) } },
                        { $set: { actionRequiredBy: currentEmpId } }
                    );

                    // Update Dashboard Actions for these drafts
                    await DashboardAction.updateMany(
                        {
                            requestId: { $in: draftAssets.map(a => a._id) },
                            requestType: 'Asset Approval',
                            status: 'Pending'
                        },
                        {
                            $set: {
                                assignedTo: currentEmpId,
                                assignedToEmpId: newController ? newController.employeeId : null
                            }
                        }
                    );

                    console.log(`[respondToResponsibility] Reassigned ${draftAssets.length} Draft assets to new controller ${actorName}`);
                }

            } catch (assetErr) {
                console.error("[respondToResponsibility] Asset assignment failed:", assetErr);
            }
        }

        // 5. Update Dashboard Action
        dashboardAction.status = action === 'Approve' ? 'Approved' : 'Rejected';
        dashboardAction.actionedDate = new Date();
        dashboardAction.actionedBy = req.user.employeeObjectId;
        await dashboardAction.save();

        res.status(200).json({
            message: `Responsibility ${action.toLowerCase()}ed successfully`,
            company: company
        });

    } catch (error) {
        console.error("Error responding to responsibility:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

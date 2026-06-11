import mongoose from "mongoose";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { isReqUserAdmin, scheduleManagementAdminDeletionEmail } from "../../utils/sendAdminDeletionNotificationEmails.js";

function buildEmployeeLookupFilter(id) {
    if (mongoose.Types.ObjectId.isValid(id) && String(id).length === 24) {
        return { _id: new mongoose.Types.ObjectId(id) };
    }
    return { employeeId: id };
}

function scheduleOldDocumentDeletionEmail(req, opts) {
    setImmediate(() => {
        scheduleManagementAdminDeletionEmail(req, opts);
    });
}

// @desc    Delete a document from employee's oldDocuments list (Archive)
// @route   DELETE /api/Employee/:id/old-document/:target
// @access  Private (Admin Only)
export const deleteOldDocument = async (req, res) => {
    try {
        const isAdmin = await isReqUserAdmin(req.user);
        if (!isAdmin) {
            return res.status(403).json({ message: "Only administrator can delete archived employee documents." });
        }

        const { id, target } = req.params;
        const employeeFilter = buildEmployeeLookupFilter(id);
        const targetStr = String(target || "").trim();
        const isMongoIdTarget = /^[0-9a-fA-F]{24}$/.test(targetStr);

        let archivedDoc = null;
        let employeeIdLabel = null;

        if (isMongoIdTarget) {
            const targetOid = new mongoose.Types.ObjectId(targetStr);
            const before = await EmployeeBasic.findOneAndUpdate(
                { ...employeeFilter, "oldDocuments._id": targetOid },
                { $pull: { oldDocuments: { _id: targetOid } } },
                { select: "employeeId oldDocuments", returnDocument: "before" },
            ).lean();

            if (!before) {
                const exists = await EmployeeBasic.findOne(employeeFilter).select("_id").lean();
                if (!exists) {
                    return res.status(404).json({ message: "Employee not found" });
                }
                return res.status(400).json({ message: "Document not found in archive" });
            }

            archivedDoc = (before.oldDocuments || []).find((d) => String(d._id) === targetStr);
            employeeIdLabel = before.employeeId;
        } else {
            const indexValue = parseInt(targetStr, 10);
            if (isNaN(indexValue) || indexValue < 0) {
                return res.status(400).json({ message: "Document not found in archive" });
            }

            const employee = await EmployeeBasic.findOne(employeeFilter).select("employeeId oldDocuments");
            if (!employee) {
                return res.status(404).json({ message: "Employee not found" });
            }

            if (!employee.oldDocuments || employee.oldDocuments.length === 0) {
                return res.status(404).json({ message: "No archived documents found" });
            }

            if (indexValue >= employee.oldDocuments.length) {
                return res.status(400).json({ message: "Document not found in archive" });
            }

            archivedDoc = employee.oldDocuments[indexValue];
            employeeIdLabel = employee.employeeId;
            const archivedId = archivedDoc?._id;

            if (archivedId) {
                await EmployeeBasic.updateOne(
                    employeeFilter,
                    { $pull: { oldDocuments: { _id: archivedId } } },
                );
            } else {
                employee.oldDocuments.splice(indexValue, 1);
                employee.markModified("oldDocuments");
                await employee.save();
            }
        }

        if (!archivedDoc) {
            return res.status(400).json({ message: "Document not found in archive" });
        }

        res.status(200).json({
            message: "Archived document deleted successfully",
            deleted: true,
            deletedId: archivedDoc._id ? String(archivedDoc._id) : null,
        });

        scheduleOldDocumentDeletionEmail(req, {
            moduleName: "Employee Old Document",
            recordId: employeeIdLabel,
            details: (archivedDoc?.type || "Archived document").toString(),
            deletedPayload: { employeeId: employeeIdLabel, document: archivedDoc },
        });
    } catch (error) {
        console.error("Error deleting archived document:", error);
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

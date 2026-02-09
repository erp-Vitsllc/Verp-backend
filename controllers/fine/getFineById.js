import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";

export const getFineById = async (req, res) => {
    try {
        let { id } = req.params;

        // Sanitize ID (remove artifacts like ":1")
        if (id && typeof id === 'string' && id.includes(':')) {
            id = id.split(':')[0].trim();
        }

        let fine;

        // Check if id is a valid MongoDB ObjectId
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);

        if (isValidObjectId) {
            // Try matching either _id or fineId (in case fineId happens to look like an objectId, unlikely but safe)
            fine = await Fine.findOne({
                $or: [{ _id: id }, { fineId: id }]
            })
                .populate('createdBy', 'firstName lastName email department designation')
                .populate('managerApprovedBy', 'firstName lastName email department designation employeeId')
                .populate('hrApprovedBy', 'firstName lastName email department designation employeeId')
                .populate('accountsApprovedBy', 'firstName lastName email department designation employeeId')
                .populate('approvedBy', 'firstName lastName email department designation employeeId')
                .populate('rejectedBy', 'firstName lastName email department designation')
                .populate('submittedTo', 'firstName lastName email department designation')
                .lean();
        } else {
            // Not an ObjectId, so must be a custom fineId
            fine = await Fine.findOne({ fineId: id })
                .populate('createdBy', 'name email department designation')
                .populate('hrApprovedBy', 'name email department designation employeeId')
                .populate('accountsApprovedBy', 'name email department designation employeeId')
                .populate('approvedBy', 'name email department designation employeeId')
                .lean();
        }

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        // Generate signed URL if attachment exists
        if (fine.attachment?.publicId) {
            try {
                const signedUrl = await getSignedFileUrl(fine.attachment.publicId);
                fine.attachment.url = signedUrl;
            } catch (err) {
                console.error("Error signing attachment URL:", err);
                // Keep original URL or handle error as needed
            }
        }

        // Populate Manager Info for Frontend Permission Check
        if (fine.assignedEmployees && fine.assignedEmployees.length > 0) {
            const empIds = fine.assignedEmployees.map(e => e.employeeId);
            const employees = await EmployeeBasic.find({ employeeId: { $in: empIds } })
                .select('employeeId primaryReportee')
                .populate('primaryReportee', 'email companyEmail firstName lastName employeeId')
                .lean();

            // Merge back
            fine.assignedEmployees = fine.assignedEmployees.map(assigned => {
                const empDetails = employees.find(e => e.employeeId === assigned.employeeId);
                return {
                    ...assigned,
                    managerInfo: empDetails?.primaryReportee || null
                };
            });
        }

        // Determine the primary employee for context (Context Aware)
        // Check assignedEmployees first, then fallback to legacy/direct employeeId if present
        const targetEmployeeId = fine.assignedEmployees?.[0]?.employeeId || fine.employeeId;

        // Fetch current HODs for display fallbacks in tracker
        // Passes the employee ID to find THEIR company's specific responsibilities
        const hrHOD = await getDepartmentHOD('hr', targetEmployeeId);
        const accountsHOD = await getDepartmentHOD('finance', targetEmployeeId);
        const ceoHOD = await getManagementHOD(targetEmployeeId);

        return res.status(200).json({
            ...fine,
            hrHODName: hrHOD ? `${hrHOD.firstName} ${hrHOD.lastName}` : 'Unknown',
            hrHODId: hrHOD ? hrHOD.employeeId : null,
            accountsHODName: accountsHOD ? `${accountsHOD.firstName} ${accountsHOD.lastName}` : 'Unknown',
            accountsHODId: accountsHOD ? accountsHOD.employeeId : null,
            ceoName: ceoHOD ? `${ceoHOD.firstName} ${ceoHOD.lastName}` : 'Unknown',
            ceoEmployeeId: ceoHOD ? ceoHOD.employeeId : null
        });
    } catch (error) {
        console.error('Error fetching fine:', error);
        return res.status(500).json({
            message: "Failed to fetch fine details",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

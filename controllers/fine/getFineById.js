import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { isUserAdministrator } from "../../services/permissionService.js";

export const getFineById = async (req, res) => {
    try {
        let { id } = req.params;

        // Clean ID: strip artifacts like ":1"
        if (id && typeof id === 'string') {
            try {
                id = decodeURIComponent(id);
            } catch (e) {
                // ignore
            }
            if (id.includes(':')) {
                id = id.split(':')[0];
            }
            id = id.trim();
        }

        let fine;
        let relatedFines = [];

        // Check if id is a valid MongoDB ObjectId
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);

        if (isValidObjectId) {
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
                .populate('workflow.assignedTo', 'firstName lastName employeeId')
                .populate('company', 'companyId _id name') // Populate company to get companyId and name
                .lean();
        } else {
            fine = await Fine.findOne({ fineId: id })
                .populate('createdBy', 'firstName lastName email department designation')
                .populate('hrApprovedBy', 'firstName lastName email department designation employeeId')
                .populate('accountsApprovedBy', 'firstName lastName email department designation employeeId')
                .populate('approvedBy', 'firstName lastName email department designation employeeId')
                .populate('workflow.assignedTo', 'firstName lastName employeeId')
                .populate('company', 'companyId _id name') // Populate company to get companyId and name
                .lean();
        }

        // --- SYNTHESIZE GROUPED FINE IF SIBLINGS EXIST ---
        // Determine the base ID
        let baseIdToUse = id;
        if (fine) {
            baseIdToUse = fine.fineId.split('-').length > 3 ? fine.fineId.split('-').slice(0, 3).join('-') : fine.fineId;
        } else {
            baseIdToUse = id.split('-').length > 3 ? id.split('-').slice(0, 3).join('-') : id;
        }

        const baseIdRegex = new RegExp(`^${baseIdToUse}(-[A-Z0-9]+)?$`, 'i');
        relatedFines = await Fine.find({ fineId: baseIdRegex })
            .populate('createdBy', 'firstName lastName email department designation')
            .populate('hrApprovedBy', 'firstName lastName email department designation employeeId')
            .populate('accountsApprovedBy', 'firstName lastName email department designation employeeId')
            .populate('approvedBy', 'firstName lastName email department designation employeeId')
            .populate('rejectedBy', 'firstName lastName email department designation')
            .populate('submittedTo', 'firstName lastName email department designation')
            .populate('workflow.assignedTo', 'firstName lastName employeeId')
            .populate('company', 'companyId _id name') // Populate company to get companyId and name
            .sort({ fineId: 1 })
            .lean();

        if (relatedFines.length > 1) {
            // Group Fine synthesized view
            const first = relatedFines[0];
            fine = { ...first }; // copy common props

            const allAssigned = [];
            let totalFineAmt = 0;
            let totalEmpAmt = 0;
            let totalCompAmt = 0;
            let totalServiceCharge = 0;

            relatedFines.forEach(rf => {
                if (rf.assignedEmployees) {
                    // Enrich each entry with its specific record fineId and amounts for edit modal
                    const enriched = rf.assignedEmployees.map(e => {
                        const isCompanyRecord = e.employeeId === 'VEGA-HR-0000';
                        // individualAmount = total (base + service charge) for display
                        let individualAmt = e.individualAmount;
                        if (!individualAmt) {
                            individualAmt = (parseFloat(rf.employeeAmount) || 0) + (parseFloat(rf.companyAmount) || 0) + (parseFloat(rf.serviceCharge) || 0);
                        }
                        // Base amount (without service charge) - for edit form per-person input
                        const baseAmount = parseFloat(rf.employeeAmount) || 0;
                        return {
                            ...e,
                            fineId: rf.fineId,
                            fineStatus: rf.fineStatus,
                            individualAmount: individualAmt,
                            fineAmount: baseAmount, // Base amount for edit form input
                            employeeAmount: baseAmount, // Explicit base for edit modal
                            payableDuration: rf.payableDuration || e.payableDuration
                        };
                    });
                    allAssigned.push(...enriched);
                }

                // FIX: If this record is the company's portion (VEGA-HR-0000), 
                // its employeeAmount IS the company liability.
                const hasCompanyPlaceholder = rf.assignedEmployees?.some(e => e.employeeId === 'VEGA-HR-0000');
                
                if (hasCompanyPlaceholder) {
                    totalCompAmt += parseFloat(rf.employeeAmount) || 0;
                } else {
                    totalEmpAmt += parseFloat(rf.employeeAmount) || 0;
                    totalCompAmt += parseFloat(rf.companyAmount) || 0;
                }
                
                // Sum service charge from all records (it's already distributed per employee)
                totalServiceCharge += parseFloat(rf.serviceCharge) || 0;
                
                // fineAmount already includes service charge per record, so sum it up
                totalFineAmt += parseFloat(rf.fineAmount) || 0;
                
                // Ensure company ID and details are preserved
                if (rf.company && !fine.company) {
                    fine.company = rf.company;
                } else if (rf.company && fine.company && !fine.company.companyId && rf.company.companyId) {
                    // Merge company details if missing
                    fine.company = { ...fine.company, ...rf.company };
                }
            });

            // Update synthesized fields
            fine.fineId = baseIdToUse; // use base ID
            fine.isGroupView = true;
            fine.assignedEmployees = allAssigned;
            fine.fineAmount = totalFineAmt.toFixed(2); // Total includes service charge (sum of all rf.fineAmount)
            fine.employeeAmount = totalEmpAmt.toFixed(2);
            fine.companyAmount = totalCompAmt.toFixed(2);
            fine.serviceCharge = totalServiceCharge.toFixed(2); // Total service charge for the group
            // Calculate totalFineAmount from components: employeeAmount + companyAmount + serviceCharge
            fine.totalFineAmount = (totalEmpAmt + totalCompAmt + totalServiceCharge).toFixed(2);
        } else if (relatedFines.length === 1 && !fine) {
            fine = relatedFines[0];
            // Ensure totalFineAmount is set for single fines too
            if (!fine.totalFineAmount) {
                const empAmt = parseFloat(fine.employeeAmount || 0);
                const compAmt = parseFloat(fine.companyAmount || 0);
                const servCharge = parseFloat(fine.serviceCharge || 0);
                fine.totalFineAmount = (empAmt + compAmt + servCharge).toFixed(2);
            }
            // Enrich assignedEmployees for edit: add employeeAmount (base) per person
            if (fine.assignedEmployees && fine.assignedEmployees.length > 0) {
                fine.assignedEmployees = fine.assignedEmployees.map(e => ({
                    ...e,
                    employeeAmount: e.employeeAmount ?? fine.employeeAmount,
                    fineAmount: (e.employeeAmount ?? fine.employeeAmount) ?? e.fineAmount,
                    payableDuration: e.payableDuration ?? fine.payableDuration
                }));
            }
        }

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        // Visibility: Draft - only creator sees; Admin sees all
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isCreator = fine.createdBy && (fine.createdBy._id?.toString() || fine.createdBy.toString()) === req.user?.id;
        if (!isAdmin && fine.fineStatus === 'Draft' && !isCreator) {
            return res.status(403).json({ message: "Access denied. Draft fines are visible only to the creator." });
        }

        // Ensure totalFineAmount is always set (fallback for any edge cases)
        if (!fine.totalFineAmount) {
            const empAmt = parseFloat(fine.employeeAmount || 0);
            const compAmt = parseFloat(fine.companyAmount || 0);
            const servCharge = parseFloat(fine.serviceCharge || 0);
            fine.totalFineAmount = (empAmt + compAmt + servCharge).toFixed(2);
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
        // Skip 'VEGA-HR-0000' (Company share record) to find the actual company of the group
        const realEmployee = fine.assignedEmployees?.find(e => e.employeeId && e.employeeId !== 'VEGA-HR-0000');
        const targetEmployeeId = realEmployee?.employeeId || (fine.assignedEmployees?.[0]?.employeeId) || fine.employeeId;

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

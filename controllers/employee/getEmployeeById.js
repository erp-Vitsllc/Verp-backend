import { getCompleteEmployee, saveEmployeeData } from "../../services/employeeService.js";
import AssetItem from "../../models/AssetItem.js";
import Fine from "../../models/Fine.js";
import Reward from "../../models/Reward.js";
import Loan from "../../models/Loan.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { ensureProbationRequestForEmployee } from "../../utils/sendProbationWorkflowEmail.js";

// Get single employee by ID
export const getEmployeeById = async (req, res) => {
    try {
        const { id } = req.params;

        // Validate ID parameter
        if (!id || id.trim() === '') {
            return res.status(400).json({ message: "Employee ID is required" });
        }

        console.log(`[getEmployeeById] Fetching employee with ID: ${id}`);
        const employee = await getCompleteEmployee(id);

        if (!employee) {
            console.log(`[getEmployeeById] Employee not found: ${id}`);
            return res.status(404).json({ message: "Employee not found" });
        }

        // Probation workflow auto-trigger:
        // after probation completes, create approval request instead of auto-switching to Permanent.
        try {
            const employeeDoc = await EmployeeBasic.findById(employee._id);
            if (employeeDoc) {
                const created = await ensureProbationRequestForEmployee(employeeDoc);
                if (created) {
                    employee.probationChangeRequest = employeeDoc.probationChangeRequest;
                }
            }
        } catch (probErr) {
            console.error("[getEmployeeById] Probation workflow trigger failed:", probErr);
        }

        // Remove password from response
        if (employee.password) {
            delete employee.password;
        }

        // Check for Visa Expiry and Auto-Inactivate
        if (employee.profileStatus === 'active' && employee.visaDetails) {
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Compare dates without time

            let isExpired = false;
            const visaTypes = ['visit', 'employment', 'spouse'];

            for (const type of visaTypes) {
                const visa = employee.visaDetails[type];
                if (visa && visa.expiryDate) {
                    const expiryDate = new Date(visa.expiryDate);
                    if (expiryDate <= today) {
                        isExpired = true;
                        break;
                    }
                }
            }

            if (isExpired) {
                console.log(`[getEmployeeById] Active employee ${id} has expired visa. Auto-setting to inactive.`);
                try {
                    await saveEmployeeData(id, { profileStatus: 'inactive' });
                    employee.profileStatus = 'inactive'; // Update local object for response
                } catch (updateError) {
                    console.error('[getEmployeeById] Failed to auto-inactivate employee:', updateError);
                }
            }
        }

        // Fetch Fines and Rewards
        try {
            const fines = await Fine.find({
                "assignedEmployees.employeeId": employee.employeeId,
                fineStatus: { $in: ["Approved", "Paid"] }
            }).sort({ createdAt: -1 }).lean();

            const rewards = await Reward.find({
                employeeId: employee.employeeId,
                rewardStatus: 'Approved'
            }).sort({ createdAt: -1 }).lean();

            // Fetch Approved Loans and Advances
            const loans = await Loan.find({
                employeeId: employee.employeeId,
                status: { $in: ["Approved", "Paid"] }
            }).sort({ createdAt: -1 }).lean();

            // Fetch assets the employee currently holds.
            // Do not include actionRequiredBy-only records here, so role-reassignment
            // assets stay visible under the previous holder until target acceptance.
            const heldStatuses = ['Assigned', 'Pending', 'On Leave', 'Out of Service', 'Returned', 'Service'];
            let assets = await AssetItem.find({
                $or: [
                    {
                        assignedTo: employee._id,
                        acceptanceStatus: { $in: ['Accepted', 'Pending'] },
                        status: { $in: heldStatuses }
                    },
                    { assignedBy: employee._id, status: 'Returned' }
                ]
            }).populate('typeId categoryId assignedTo assignedBy acceptedBy').lean();

            console.log(`[getEmployeeById] Fetching assets for employee ${employee._id} (${employee.firstName})`);
            console.log(`[getEmployeeById] Found ${assets.length} assets. Statuses:`, assets.map(a => `${a.assetId}:${a.acceptanceStatus}`));

            // Sign URLs for asset invoices
            assets = await Promise.all(assets.map(async (asset) => {
                if (asset.invoiceFile) {
                    try {
                        const signedUrl = await getSignedFileUrl(asset.invoiceFile);
                        return { ...asset, invoiceFile: signedUrl };
                    } catch (err) {
                        console.error(`[getEmployeeById] Failed to sign invoice URL for asset ${asset.assetId}:`, err);
                        return asset;
                    }
                }
                return asset;
            }));

            employee.fines = fines || [];
            employee.rewards = rewards || [];
            employee.loans = loans || [];
            employee.loanAmount = 0; // Placeholder for future Loan module logic if needed
            employee.assets = assets || []; // Add assets to main employee object

            // Also add to salary object if it exists (as per request "salary tab under asset tab")
            if (employee.monthlySalary !== undefined || employee.totalSalary !== undefined) {
                // If salary object structure exists implicitly or explicitly
                employee.salaryAssets = assets || [];
            }
            // Add explicitly to salary result if structure allows (salary is spread in getCompleteEmployee return)
            // Since getCompleteEmployee flattens salary fields into root, we don't have a 'salary' object per se in the final response except what's reconstructed or passed.
            // But wait, getCompleteEmployee returns salary fields merged into root.
            // So user probably means UI tab.
            // Adding 'assets' to root should be sufficient for frontend to pick it up.
        } catch (err) {
            console.error('[getEmployeeById] Error fetching fines/rewards/assets:', err);
            employee.fines = [];
            employee.rewards = [];
            employee.loans = [];
            employee.assets = [];
            employee.loanAmount = 0;
        }

        console.log(`[getEmployeeById] Successfully fetched employee: ${employee.employeeId || id}`);

        // Calculate approximate response size for logging
        const responseSize = JSON.stringify(employee).length;
        console.log(`[getEmployeeById] Response size: ${(responseSize / 1024).toFixed(2)} KB`);

        // Set response headers for better handling
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', responseSize);

        return res.status(200).json({
            message: "Employee fetched successfully",
            employee,
        });
    } catch (error) {
        console.error('[getEmployeeById] Error:', error);
        console.error('[getEmployeeById] Stack:', error.stack);
        return res.status(500).json({
            message: error.message || "Internal server error while fetching employee",
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};




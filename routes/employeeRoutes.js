import express from "express";
import { getEmployees } from "../controllers/employee/getEmployees.js";
import { getEmployeeById } from "../controllers/employee/getEmployeeById.js";
import { addEmployee } from "../controllers/employee/addEmployee.js";
import { updateEmployee } from "../controllers/employee/updateEmployee.js";
import { updateBasicDetails } from "../controllers/employee/updateBasicDetails.js";
import { addEmergencyContact } from "../controllers/employee/addEmergencyContact.js";
import { updateEmergencyContact } from "../controllers/employee/updateEmergencyContact.js";
import { deleteEmergencyContact } from "../controllers/employee/deleteEmergencyContact.js";
import { sendApprovalEmail } from "../controllers/employee/sendApprovalEmail.js";
import { approveProfile } from "../controllers/employee/approveProfile.js";
import { holdProfile } from "../controllers/employee/holdProfile.js";
import { rejectProfile } from "../controllers/employee/rejectProfile.js";
import { discardEmployeePendingActivationEntry } from "../controllers/employee/discardEmployeePendingActivationEntry.js";
import { deleteEmployee } from "../controllers/employee/deleteEmployee.js";
import { updateVisaDetails } from "../controllers/employee/updateVisaDetails.js";
import { deleteVisaDetails } from "../controllers/employee/deleteVisaDetails.js";
import { updateProfileStatus } from "../controllers/employee/updateProfileStatus.js";
import { updateEmiratesIdDetails } from "../controllers/employee/updateEmiratesIdDetails.js";
import { updateLabourCardDetails } from "../controllers/employee/updateLabourCardDetails.js";
import { updateMedicalInsuranceDetails } from "../controllers/employee/updateMedicalInsuranceDetails.js";
import { updatePassportDetails } from "../controllers/employee/updatePassportDetails.js";
import { updateDrivingLicenseDetails } from "../controllers/employee/updateDrivingLicenseDetails.js";
import { deletePassportDetails } from "../controllers/employee/deletePassportDetails.js";
import { deleteEmiratesIdDetails } from "../controllers/employee/deleteEmiratesIdDetails.js";
import { deleteLabourCardDetails } from "../controllers/employee/deleteLabourCardDetails.js";
import { deleteMedicalInsuranceDetails } from "../controllers/employee/deleteMedicalInsuranceDetails.js";
import { deleteDrivingLicenseDetails } from "../controllers/employee/deleteDrivingLicenseDetails.js";
import { deleteWorkDetailsCard } from "../controllers/employee/deleteWorkDetailsCard.js";
import { deleteSignatureCard } from "../controllers/employee/deleteSignatureCard.js";
import { deleteSalaryHistoryEntry } from "../controllers/employee/deleteSalaryHistoryEntry.js";
import { updateWorkDetails } from "../controllers/employee/updateWorkDetails.js";
import { addEducation } from "../controllers/employee/addEducation.js";
import { updateEducation } from "../controllers/employee/updateEducation.js";
import { deleteEducation } from "../controllers/employee/deleteEducation.js";
import { addExperience } from "../controllers/employee/addExperience.js";
import { updateExperience } from "../controllers/employee/updateExperience.js";
import { deleteExperience } from "../controllers/employee/deleteExperience.js";
import { addTraining } from "../controllers/employee/addTraining.js";
import { updateTraining } from "../controllers/employee/updateTraining.js";
import { deleteTraining } from "../controllers/employee/deleteTraining.js";
import { uploadProfilePicture } from "../controllers/employee/uploadProfilePicture.js";
import { uploadSignature } from "../controllers/employee/uploadSignature.js";
import { uploadDocument } from "../controllers/employee/uploadDocument.js";
import { deleteDocument } from "../controllers/employee/deleteDocument.js";
import {
    submitEmployeeDocumentNotRenewRequest,
    respondEmployeeDocumentNotRenewRequest,
} from "../controllers/employee/employeeNotRenewController.js";
import { addDocument } from "../controllers/employee/addDocument.js";
import { updateDocument } from "../controllers/employee/updateDocument.js";
import { protect } from "../middleware/authMiddleware.js";
import { rejectLeftUserProfileWrite } from "../middleware/employeeLeftUserMiddleware.js";
import {
    checkPermission,
    checkPermissionAny,
    checkBasicDetailsPatchPermission,
    checkEmployeeCardDeletePermission,
    checkEmployeeProfileActivationAction,
    checkEmployeeManualDocumentEdit,
    checkEmployeeOldDocumentDelete,
    checkLoanOrAdvanceCreatePermission,
    checkLoanMutatePermission,
    checkLoanViewPermission,
} from "../middleware/permissionMiddleware.js";
import { deleteOldDocument } from "../controllers/employee/deleteOldDocument.js";
import { getEmployeeDocument } from "../controllers/employee/getEmployeeDocument.js";
import { getReporteeOptions } from "../controllers/employee/getReporteeOptions.js";

const router = express.Router();
const blockLeftUserWrites = rejectLeftUserProfileWrite();

import { getLoanEligibleEmployees } from "../controllers/employee/getLoanEligibleEmployees.js";
import { requestNotice, updateNoticeStatus } from "../controllers/employee/noticeController.js";
import { getLeftUserEligibility, markEmployeeLeftUser, returnEmployeeFromLeftUser } from "../controllers/employee/leftUserController.js";
import { requestLoan } from "../controllers/employee/requestLoan.js";
import { getLoans } from "../controllers/employee/getLoans.js";
import { getLoanById } from "../controllers/employee/getLoanById.js";
import { approveLoan } from "../controllers/employee/approveLoan.js";
import { updateLoanDetails, updateLoanPartyPayable } from "../controllers/employee/updateLoanDetails.js";
import { retryLoanZohoExpense } from "../controllers/employee/retryLoanZohoExpense.js";
import { getPendingLoanDashboardInbox } from "../controllers/employee/getPendingLoanDashboardInbox.js";
import { getLoanPdf } from "../controllers/employee/getLoanPdf.js";
import { downloadLoanAcknowledgmentPdf } from "../controllers/employee/downloadLoanAcknowledgmentPdf.js";
import { downloadEmployeeAssetListPdf } from "../controllers/employee/downloadEmployeeAssetListPdf.js";
import { deleteLoan } from "../controllers/employee/deleteLoan.js";
import {
    requestProbationChange,
    confirmProbationByHOD,
    employeeRespondProbationChange,
    finalizeProbationByHR,
} from "../controllers/employee/probationController.js";


// All employee routes require authentication
router.use(protect);

// Get current employee profile
router.get("/me", async (req, res) => {
    try {
        const { getCompleteEmployee } = await import("../services/employeeService.js");

        // Try searching by employeeObjectId (preferred)
        let employee = null;
        if (req.user.employeeObjectId) {
            employee = await getCompleteEmployee(req.user.employeeObjectId);
        }

        // Fallback to searching by employeeId string if not found by ObjectId
        if (!employee && req.user.employeeId) {
            console.log(`[Employee Routes] /me: Employee not found by ObjectId ${req.user.employeeObjectId}, trying employeeId: ${req.user.employeeId}`);
            employee = await getCompleteEmployee(req.user.employeeId);
        }

        if (!employee) {
            // If still not found, it might be a user without an employee record (e.g. system admin)
            // Return user info from req.user instead of failing with 404
            console.log(`[Employee Routes] /me: No linked employee found for user ${req.user.id}. Returning user info.`);
            return res.json({
                ...req.user,
                isOnlyUser: true,
                message: "No linked employee record found"
            });
        }

        res.json(employee);
    } catch (error) {
        console.error("Error in /me:", error);
        res.status(500).json({ message: "Server Error", error: error.message });
    }
});

// Get loan eligible employees — needed when creating Loan/Advance
router.get("/loan-eligible", checkLoanMutatePermission(), getLoanEligibleEmployees);

// Loan / Advance create — keep beside other static paths (before GET /:id)
router.post("/request-loan", checkLoanOrAdvanceCreatePermission(), requestLoan);
// Browsers/tools sometimes probe with GET; do not fall through to getEmployeeById("request-loan")
router.get("/request-loan", (req, res) => {
    res.set("Allow", "POST");
    return res.status(405).json({
        message: "Use POST /api/Employee/request-loan to create a loan or advance.",
    });
});

import { getDashboardStats } from "../controllers/stats/getDashboardStats.js";
import { getUserActivityStats } from "../controllers/stats/getUserActivityStats.js";
import { deleteDashboardAction } from "../controllers/stats/deleteDashboardAction.js";
import { deleteProfileActivationDashboardByRequest } from "../controllers/stats/deleteProfileActivationDashboardByRequest.js";
import { deleteCompanyActivationDashboardByRequest } from "../controllers/stats/deleteCompanyActivationDashboardByRequest.js";
import { getHierarchy } from "../controllers/employee/getHierarchy.js";
import { getTeamStats } from "../controllers/stats/getTeamStats.js";

import { getNextEmployeeId } from "../controllers/employee/getNextEmployeeId.js";
import { getDrivingLicenseHolders } from "../controllers/employee/getDrivingLicenseHolders.js";

// Employee list - requires view permission
router.get("/", checkPermission('hrm_employees_list', 'view'), getEmployees);
router.get(
    "/driving-license-holders",
    checkPermission('hrm_employees_list', 'view'),
    getDrivingLicenseHolders,
);
router.get("/reportee-options", checkPermission('hrm_employees_view_work', 'view'), getReporteeOptions);

// Get next employee ID - requires create permission (or just authenticated)
router.get("/next-id", checkPermissionAny('hrm_employees_add', ['view', 'create']), getNextEmployeeId);

// Dashboard Hierarchy - basic access for anyone logged in
router.get("/dashboard/hierarchy", getHierarchy);

// Team Stats - basic access
router.get("/dashboard/team-stats", getTeamStats);

// Dashboard Stats - requires view permission (General HR view)
router.get("/dashboard/stats", checkPermission('hrm_employees_list', 'view'), getDashboardStats);

// User Specific Stats - basic access for anyone logged in
router.get("/dashboard/user-stats", getUserActivityStats);

// Dismiss a dashboard notification row (own assignee or admin)
router.delete("/dashboard/actions/:actionId", deleteDashboardAction);
// Dismiss all Profile Activation rows for one employee request (when client only has requestId)
router.delete(
    "/dashboard/profile-activation/:requestId",
    deleteProfileActivationDashboardByRequest,
);
router.delete(
    "/dashboard/company-activation/:requestId",
    deleteCompanyActivationDashboardByRequest,
);

// Add employee - requires create permission
router.post("/", checkPermission('hrm_employees_add', 'create'), addEmployee);

// Specific routes MUST come before generic :id routes
// Update basic details - requires edit permission
router.patch("/basic-details/:id", checkBasicDetailsPatchPermission(), blockLeftUserWrites, updateBasicDetails);

// Salary history row delete — salary delete permission (not basic-details patch)
router.delete(
    "/:id/salary-history/:historyId",
    checkPermission("hrm_employees_view_salary", "delete"),
    blockLeftUserWrites,
    deleteSalaryHistoryEntry,
);

// Update work details - requires edit permission
router.patch("/work-details/:id", checkPermission('hrm_employees_view_work', 'edit'), updateWorkDetails);
router.delete("/work-details/:id", checkEmployeeCardDeletePermission('hrm_employees_view_work'), blockLeftUserWrites, deleteWorkDetailsCard);

// Update passport - requires edit permission
router.patch("/passport/:id", checkPermission('hrm_employees_view_passport', 'edit'), blockLeftUserWrites, updatePassportDetails);
router.delete("/passport/:id", checkEmployeeCardDeletePermission('hrm_employees_view_passport'), blockLeftUserWrites, deletePassportDetails);

// Update visa - requires edit permission
router.patch("/visa/:id", checkPermission('hrm_employees_view_visa', 'edit'), blockLeftUserWrites, updateVisaDetails);
router.delete("/visa/:id/:type", checkPermission('hrm_employees_view_visa', 'edit'), blockLeftUserWrites, deleteVisaDetails);

// Update Emirates ID - requires edit permission
router.patch("/emirates-id/:id", checkPermission('hrm_employees_view_passport', 'edit'), blockLeftUserWrites, updateEmiratesIdDetails);
router.delete("/emirates-id/:id", checkEmployeeCardDeletePermission('hrm_employees_view_passport'), blockLeftUserWrites, deleteEmiratesIdDetails);

// Update Labour Card - requires edit permission
router.patch("/labour-card/:id", checkPermission('hrm_employees_view_passport', 'edit'), blockLeftUserWrites, updateLabourCardDetails);
router.delete("/labour-card/:id", checkEmployeeCardDeletePermission('hrm_employees_view_passport'), blockLeftUserWrites, deleteLabourCardDetails);

// Update Medical Insurance - requires edit permission
router.patch("/medical-insurance/:id", checkPermission('hrm_employees_view_passport', 'edit'), blockLeftUserWrites, updateMedicalInsuranceDetails);
router.delete("/medical-insurance/:id", checkEmployeeCardDeletePermission('hrm_employees_view_passport'), blockLeftUserWrites, deleteMedicalInsuranceDetails);

// Update Driving License - requires edit permission
router.patch("/driving-license/:id", checkPermission('hrm_employees_view_passport', 'edit'), blockLeftUserWrites, updateDrivingLicenseDetails);
router.delete("/driving-license/:id", checkEmployeeCardDeletePermission('hrm_employees_view_passport'), blockLeftUserWrites, deleteDrivingLicenseDetails);

// Upload profile picture - requires edit permission
router.post("/upload-profile-picture/:id", checkPermission('hrm_employees_view_basic', 'edit'), blockLeftUserWrites, uploadProfilePicture);

// Upload e-signature - requires work details edit permission
router.post("/:id/upload-signature", checkPermission('hrm_employees_view_work', 'edit'), blockLeftUserWrites, uploadSignature);
router.delete("/:id/signature", checkEmployeeCardDeletePermission('hrm_employees_view_work'), blockLeftUserWrites, deleteSignatureCard);

// Upload document to Cloudinary - requires edit permission
router.post("/upload-document/:id", checkEmployeeManualDocumentEdit(), blockLeftUserWrites, uploadDocument);
router.post("/:id/document", checkEmployeeManualDocumentEdit(), blockLeftUserWrites, addDocument);
router.patch("/:id/document/:index", checkEmployeeManualDocumentEdit(), blockLeftUserWrites, updateDocument);
router.delete("/:id/document/:index", checkEmployeeManualDocumentEdit(), blockLeftUserWrites, deleteDocument);
router.delete("/:id/old-document/:target", checkEmployeeOldDocumentDelete(), blockLeftUserWrites, deleteOldDocument);
router.post("/:id/document-not-renew-requests", blockLeftUserWrites, submitEmployeeDocumentNotRenewRequest);
router.post("/:id/document-not-renew-requests/:requestId/respond", respondEmployeeDocumentNotRenewRequest);

// All :id specific routes must come before the generic :id route
// Emergency contacts - requires edit permission
router.post("/:id/emergency-contact", checkPermission('hrm_employees_view_emergency', 'create'), blockLeftUserWrites, addEmergencyContact);
router.patch("/:id/emergency-contact/:contactId", checkPermission('hrm_employees_view_emergency', 'edit'), blockLeftUserWrites, updateEmergencyContact);
router.delete("/:id/emergency-contact/:contactId", checkPermission('hrm_employees_view_emergency', 'delete'), blockLeftUserWrites, deleteEmergencyContact);

// Education - requires edit permission
router.post("/:id/education", checkPermission('hrm_employees_view_education', 'create'), blockLeftUserWrites, addEducation);
router.patch("/:id/education/:educationId", checkPermission('hrm_employees_view_education', 'edit'), blockLeftUserWrites, updateEducation);
router.delete("/:id/education/:educationId", checkPermission('hrm_employees_view_education', 'delete'), blockLeftUserWrites, deleteEducation);

// Experience - requires edit permission
router.post("/:id/experience", checkPermission('hrm_employees_view_experience', 'create'), blockLeftUserWrites, addExperience);
router.patch("/:id/experience/:experienceId", checkPermission('hrm_employees_view_experience', 'edit'), blockLeftUserWrites, updateExperience);
router.delete("/:id/experience/:experienceId", checkPermission('hrm_employees_view_experience', 'delete'), blockLeftUserWrites, deleteExperience);

// Training - requires edit permission
router.post("/:id/training", checkPermission('hrm_employees_list', 'edit'), blockLeftUserWrites, addTraining);
router.patch("/:id/training/:trainingId", checkPermission('hrm_employees_list', 'edit'), blockLeftUserWrites, updateTraining);
router.delete("/:id/training/:trainingId", checkPermission('hrm_employees_list', 'edit'), blockLeftUserWrites, deleteTraining);

// Send for activation (notify HR) — view + create on Employees or Profile Activation (see middleware)
router.post("/:id/send-approval-email", checkEmployeeProfileActivationAction(), blockLeftUserWrites, sendApprovalEmail);

// Approve / hold / reject — designated HR or admin enforced in controllers
router.post("/:id/approve-profile", checkEmployeeProfileActivationAction(), approveProfile);

router.post("/:id/hold-profile", checkEmployeeProfileActivationAction(), holdProfile);

router.post("/:id/reject-profile", checkEmployeeProfileActivationAction(), rejectProfile);

router.delete(
    "/:id/pending-activation-entry/:entryId",
    checkPermission("hrm_employees_list", "edit"),
    discardEmployeePendingActivationEntry,
);

router.patch("/:id/profile-status", checkEmployeeProfileActivationAction(), blockLeftUserWrites, updateProfileStatus);

// Notice Request - requires work details edit permission
router.post("/:id/request-notice", checkPermission('hrm_employees_view_work', 'edit'), blockLeftUserWrites, requestNotice);

// Update Notice Status (Approve/Reject) - requires work details edit permission
router.patch("/:id/update-notice-status", checkPermission('hrm_employees_view_work', 'edit'), blockLeftUserWrites, updateNoticeStatus);

// Left User eligibility and mark-as-left — work details edit permission
router.get("/:id/left-user-eligibility", checkPermission('hrm_employees_view_work', 'edit'), getLeftUserEligibility);
router.post("/:id/mark-left-user", checkPermission('hrm_employees_view_work', 'edit'), markEmployeeLeftUser);
router.post("/:id/return-left-user", returnEmployeeFromLeftUser);

// Probation change workflow
router.post("/:id/probation/request", checkPermission('hrm_employees_view_work', 'edit'), blockLeftUserWrites, requestProbationChange);
router.post("/:id/probation/hod-confirm", checkPermission('hrm_employees_view_work', 'edit'), blockLeftUserWrites, confirmProbationByHOD);
router.post("/:id/probation/employee-respond", employeeRespondProbationChange);
router.post("/:id/probation/hr-finalize", checkPermission('hrm_employees_view_work', 'edit'), blockLeftUserWrites, finalizeProbationByHR);

// Assignee-only pending inbox (same pattern as Reward / Fine / Assets bells)
router.get("/loans/dashboard/pending-inbox", checkLoanViewPermission(), getPendingLoanDashboardInbox);
// Approval — workflow validates actor inside the handler (parent Edit is disabled in the chart)
router.put("/loans/:id/status", approveLoan);
router.put("/loans/:id/party-payable", checkLoanViewPermission(), updateLoanPartyPayable);
router.post("/loans/:id/retry-zoho-expense", checkLoanViewPermission(), retryLoanZohoExpense);
router.put("/loans/:id", checkLoanMutatePermission(), updateLoanDetails);
router.get("/loans/:id/pdf", checkLoanViewPermission(), getLoanPdf);
router.get("/loans/:id/acknowledgment-pdf", checkLoanViewPermission(), downloadLoanAcknowledgmentPdf);
router.get("/loans", checkLoanViewPermission(), getLoans);
router.get("/loans/:id", checkLoanViewPermission(), getLoanById);
router.delete("/loans/:id", deleteLoan); // handler restricts delete to admin


// Get specific document - requires view permission
router.get("/:id/document", checkPermission('hrm_employees_view', 'view'), getEmployeeDocument);

// Employee asset list PDF (Salary tab → Assets)
router.get("/:id/asset-list/pdf", checkPermission('hrm_employees_view', 'view'), downloadEmployeeAssetListPdf);

// Generic :id routes must come last
// Get employee by ID - requires view permission
router.get("/:id", checkPermission('hrm_employees_view', 'view'), getEmployeeById);

// Update employee - requires edit permission
router.put("/:id", checkPermission('hrm_employees_list', 'edit'), blockLeftUserWrites, updateEmployee);

// Delete employee - requires delete permission
router.delete("/:id", checkPermission('hrm_employees_list', 'delete'), deleteEmployee);

export default router;


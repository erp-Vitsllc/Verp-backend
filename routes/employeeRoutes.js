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
import {
    checkPermission,
    checkPermissionAny,
    checkBasicDetailsPatchPermission,
    checkEmployeeProfileActivationAction,
    checkEmployeeManualDocumentEdit,
    checkEmployeeOldDocumentDelete,
} from "../middleware/permissionMiddleware.js";
import { deleteOldDocument } from "../controllers/employee/deleteOldDocument.js";
import { getEmployeeDocument } from "../controllers/employee/getEmployeeDocument.js";
import { getReporteeOptions } from "../controllers/employee/getReporteeOptions.js";

const router = express.Router();

import { getLoanEligibleEmployees } from "../controllers/employee/getLoanEligibleEmployees.js";
import { requestNotice, updateNoticeStatus } from "../controllers/employee/noticeController.js";
import { getLeftUserEligibility, markEmployeeLeftUser } from "../controllers/employee/leftUserController.js";
import { requestLoan } from "../controllers/employee/requestLoan.js";
import { getLoans } from "../controllers/employee/getLoans.js";
import { getLoanById } from "../controllers/employee/getLoanById.js";
import { approveLoan } from "../controllers/employee/approveLoan.js";
import { updateLoanDetails } from "../controllers/employee/updateLoanDetails.js";
import { getLoanPdf } from "../controllers/employee/getLoanPdf.js";
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

// Get loan eligible employees - requires view permission
// Place this BEFORE /:id routes to prevent conflict
router.get("/loan-eligible", getLoanEligibleEmployees);

import { getDashboardStats } from "../controllers/stats/getDashboardStats.js";
import { getUserActivityStats } from "../controllers/stats/getUserActivityStats.js";
import { deleteDashboardAction } from "../controllers/stats/deleteDashboardAction.js";
import { deleteProfileActivationDashboardByRequest } from "../controllers/stats/deleteProfileActivationDashboardByRequest.js";
import { deleteCompanyActivationDashboardByRequest } from "../controllers/stats/deleteCompanyActivationDashboardByRequest.js";
import { getHierarchy } from "../controllers/employee/getHierarchy.js";
import { getTeamStats } from "../controllers/stats/getTeamStats.js";

import { getNextEmployeeId } from "../controllers/employee/getNextEmployeeId.js";

// Employee list - requires view permission
router.get("/", checkPermission('hrm_employees_list', 'view'), getEmployees);
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
router.patch("/basic-details/:id", checkBasicDetailsPatchPermission(), updateBasicDetails);

// Salary history row delete — salary delete permission (not basic-details patch)
router.delete(
    "/:id/salary-history/:historyId",
    checkPermission("hrm_employees_view_salary", "delete"),
    deleteSalaryHistoryEntry,
);

// Update work details - requires edit permission
router.patch("/work-details/:id", checkPermission('hrm_employees_view_work', 'edit'), updateWorkDetails);
router.delete("/work-details/:id", checkPermission('hrm_employees_view_work', 'delete'), deleteWorkDetailsCard);

// Update passport - requires edit permission
router.patch("/passport/:id", checkPermission('hrm_employees_view_passport', 'edit'), updatePassportDetails);
router.delete("/passport/:id", checkPermission('hrm_employees_view_passport', 'delete'), deletePassportDetails);

// Update visa - requires edit permission
router.patch("/visa/:id", checkPermission('hrm_employees_view_visa', 'edit'), updateVisaDetails);
router.delete("/visa/:id/:type", checkPermission('hrm_employees_view_visa', 'edit'), deleteVisaDetails);

// Update Emirates ID - requires edit permission
router.patch("/emirates-id/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateEmiratesIdDetails);
router.delete("/emirates-id/:id", checkPermission('hrm_employees_view_passport', 'delete'), deleteEmiratesIdDetails);

// Update Labour Card - requires edit permission
router.patch("/labour-card/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateLabourCardDetails);
router.delete("/labour-card/:id", checkPermission('hrm_employees_view_passport', 'delete'), deleteLabourCardDetails);

// Update Medical Insurance - requires edit permission
router.patch("/medical-insurance/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateMedicalInsuranceDetails);
router.delete("/medical-insurance/:id", checkPermission('hrm_employees_view_passport', 'delete'), deleteMedicalInsuranceDetails);

// Update Driving License - requires edit permission
router.patch("/driving-license/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateDrivingLicenseDetails);
router.delete("/driving-license/:id", checkPermission('hrm_employees_view_passport', 'delete'), deleteDrivingLicenseDetails);

// Upload profile picture - requires edit permission
router.post("/upload-profile-picture/:id", checkPermission('hrm_employees_view_basic', 'edit'), uploadProfilePicture);

// Upload e-signature - requires work details edit permission
router.post("/:id/upload-signature", checkPermission('hrm_employees_view_work', 'edit'), uploadSignature);
router.delete("/:id/signature", checkPermission('hrm_employees_view_work', 'delete'), deleteSignatureCard);

// Upload document to Cloudinary - requires edit permission
router.post("/upload-document/:id", checkEmployeeManualDocumentEdit(), uploadDocument);
router.post("/:id/document", checkEmployeeManualDocumentEdit(), addDocument);
router.patch("/:id/document/:index", checkEmployeeManualDocumentEdit(), updateDocument);
router.delete("/:id/document/:index", checkEmployeeManualDocumentEdit(), deleteDocument);
router.delete("/:id/old-document/:target", checkEmployeeOldDocumentDelete(), deleteOldDocument);
router.post("/:id/document-not-renew-requests", submitEmployeeDocumentNotRenewRequest);
router.post("/:id/document-not-renew-requests/:requestId/respond", respondEmployeeDocumentNotRenewRequest);

// All :id specific routes must come before the generic :id route
// Emergency contacts - requires edit permission
router.post("/:id/emergency-contact", checkPermission('hrm_employees_view_emergency', 'create'), addEmergencyContact);
router.patch("/:id/emergency-contact/:contactId", checkPermission('hrm_employees_view_emergency', 'edit'), updateEmergencyContact);
router.delete("/:id/emergency-contact/:contactId", checkPermission('hrm_employees_view_emergency', 'delete'), deleteEmergencyContact);

// Education - requires edit permission
router.post("/:id/education", checkPermission('hrm_employees_view_education', 'create'), addEducation);
router.patch("/:id/education/:educationId", checkPermission('hrm_employees_view_education', 'edit'), updateEducation);
router.delete("/:id/education/:educationId", checkPermission('hrm_employees_view_education', 'delete'), deleteEducation);

// Experience - requires edit permission
router.post("/:id/experience", checkPermission('hrm_employees_view_experience', 'create'), addExperience);
router.patch("/:id/experience/:experienceId", checkPermission('hrm_employees_view_experience', 'edit'), updateExperience);
router.delete("/:id/experience/:experienceId", checkPermission('hrm_employees_view_experience', 'delete'), deleteExperience);

// Training - requires edit permission
router.post("/:id/training", checkPermission('hrm_employees_list', 'edit'), addTraining);
router.patch("/:id/training/:trainingId", checkPermission('hrm_employees_list', 'edit'), updateTraining);
router.delete("/:id/training/:trainingId", checkPermission('hrm_employees_list', 'edit'), deleteTraining);

// Send for activation (notify HR) — view + create on Employees or Profile Activation (see middleware)
router.post("/:id/send-approval-email", checkEmployeeProfileActivationAction(), sendApprovalEmail);

// Approve / hold / reject — designated HR enforced in controllers; still require some employee access
router.post("/:id/approve-profile", checkPermission("hrm_employees_view", "view"), approveProfile);

router.post("/:id/hold-profile", checkPermission("hrm_employees_view", "view"), holdProfile);

router.post("/:id/reject-profile", checkPermission("hrm_employees_view", "view"), rejectProfile);

router.patch("/:id/profile-status", checkEmployeeProfileActivationAction(), updateProfileStatus);

// Notice Request - requires work details edit permission
router.post("/:id/request-notice", checkPermission('hrm_employees_view_work', 'edit'), requestNotice);

// Update Notice Status (Approve/Reject) - requires work details edit permission
router.patch("/:id/update-notice-status", checkPermission('hrm_employees_view_work', 'edit'), updateNoticeStatus);

// Left User eligibility and mark-as-left — work details edit permission
router.get("/:id/left-user-eligibility", checkPermission('hrm_employees_view_work', 'edit'), getLeftUserEligibility);
router.post("/:id/mark-left-user", checkPermission('hrm_employees_view_work', 'edit'), markEmployeeLeftUser);

// Probation change workflow
router.post("/:id/probation/request", checkPermission('hrm_employees_view_work', 'edit'), requestProbationChange);
router.post("/:id/probation/hod-confirm", checkPermission('hrm_employees_view_work', 'edit'), confirmProbationByHOD);
router.post("/:id/probation/employee-respond", employeeRespondProbationChange);
router.post("/:id/probation/hr-finalize", checkPermission('hrm_employees_view_work', 'edit'), finalizeProbationByHR);

// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
// Using 'view' permission on 'hrm_loan' for now as basic access check
// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
// Using 'view' permission on 'hrm_loan' for now as basic access check
// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
// Using 'view' permission on 'hrm_loan' for now as basic access check
// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
router.post("/request-loan", requestLoan);
// Approve/Reject Loan - requires edit permission
router.put("/loans/:id/status", checkPermission('hrm_loan', 'edit'), approveLoan);
router.put("/loans/:id", updateLoanDetails); // temporarily open; handler still validates ownership/flow
router.get("/loans/:id/pdf", getLoanPdf); // temporarily open for all authenticated users
router.get("/loans", getLoans); // temporarily open for all authenticated users
router.get("/loans/:id", getLoanById); // temporarily open for all authenticated users
router.delete("/loans/:id", deleteLoan); // temporarily open; handler checks role/ownership


// Get specific document - requires view permission
router.get("/:id/document", checkPermission('hrm_employees_view', 'view'), getEmployeeDocument);

// Generic :id routes must come last
// Get employee by ID - requires view permission
router.get("/:id", checkPermission('hrm_employees_view', 'view'), getEmployeeById);

// Update employee - requires edit permission
router.put("/:id", checkPermission('hrm_employees_list', 'edit'), updateEmployee);

// Delete employee - requires delete permission
router.delete("/:id", checkPermission('hrm_employees_list', 'delete'), deleteEmployee);

export default router;


import express from "express";
import { getEmployees } from "../controllers/employee/getEmployees.js";
import { getEmployeeById } from "../controllers/employee/getEmployeeById.js";
import { addEmployee } from "../controllers/employee/addEmployee.js";
// import { updateEmployee } from "../controllers/employee/updateEmployee.js";
import { updateBasicDetails } from "../controllers/employee/updateBasicDetails.js";
import { addEmergencyContact } from "../controllers/employee/addEmergencyContact.js";
import { updateEmergencyContact } from "../controllers/employee/updateEmergencyContact.js";
import { deleteEmergencyContact } from "../controllers/employee/deleteEmergencyContact.js";
import { sendApprovalEmail } from "../controllers/employee/sendApprovalEmail.js";
import { approveProfile } from "../controllers/employee/approveProfile.js";
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
import { addDocument } from "../controllers/employee/addDocument.js";
import { updateDocument } from "../controllers/employee/updateDocument.js";
import { protect } from "../middleware/authMiddleware.js";
import { checkPermission } from "../middleware/permissionMiddleware.js";
import { getEmployeeDocument } from "../controllers/employee/getEmployeeDocument.js";

const router = express.Router();

import { getLoanEligibleEmployees } from "../controllers/employee/getLoanEligibleEmployees.js";
import { requestNotice, updateNoticeStatus } from "../controllers/employee/noticeController.js";
import { requestLoan } from "../controllers/employee/requestLoan.js";
import { getLoans } from "../controllers/employee/getLoans.js";
import { getLoanById } from "../controllers/employee/getLoanById.js";
import { approveLoan } from "../controllers/employee/approveLoan.js";
import { updateLoanDetails } from "../controllers/employee/updateLoanDetails.js";
import { getLoanPdf } from "../controllers/employee/getLoanPdf.js";


// All employee routes require authentication
router.use(protect);

// Get current employee profile
router.get("/me", async (req, res) => {
    try {
        const { getCompleteEmployee } = await import("../services/employeeService.js");
        const employee = await getCompleteEmployee(req.user.employeeObjectId);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }
        res.json(employee);
    } catch (error) {
        console.error("Error in /me:", error);
        res.status(500).json({ message: "Server Error" });
    }
});

// Get loan eligible employees - requires view permission
// Place this BEFORE /:id routes to prevent conflict
router.get("/loan-eligible", checkPermission('hrm_loan', 'view'), getLoanEligibleEmployees);

import { getDashboardStats } from "../controllers/stats/getDashboardStats.js";
import { getUserActivityStats } from "../controllers/stats/getUserActivityStats.js";
import { getHierarchy } from "../controllers/employee/getHierarchy.js";
import { getTeamStats } from "../controllers/stats/getTeamStats.js";

import { getNextEmployeeId } from "../controllers/employee/getNextEmployeeId.js";

// Employee list - requires view permission
router.get("/", checkPermission('hrm_employees_list', 'view'), getEmployees);

// Get next employee ID - requires create permission (or just authenticated)
router.get("/next-id", checkPermission('hrm_employees_add', 'create'), getNextEmployeeId);

// Dashboard Hierarchy - basic access for anyone logged in
router.get("/dashboard/hierarchy", getHierarchy);

// Team Stats - basic access
router.get("/dashboard/team-stats", getTeamStats);

// Dashboard Stats - requires view permission (General HR view)
router.get("/dashboard/stats", checkPermission('hrm_employees_list', 'view'), getDashboardStats);

// User Specific Stats - basic access for anyone logged in
router.get("/dashboard/user-stats", getUserActivityStats);

// Add employee - requires create permission
router.post("/", checkPermission('hrm_employees_add', 'create'), addEmployee);

// Specific routes MUST come before generic :id routes
// Update basic details - requires edit permission
router.patch("/basic-details/:id", checkPermission('hrm_employees_view_basic', 'edit'), updateBasicDetails);

// Update work details - requires edit permission
router.patch("/work-details/:id", checkPermission('hrm_employees_view_work', 'edit'), updateWorkDetails);

// Update passport - requires edit permission
router.patch("/passport/:id", checkPermission('hrm_employees_view_passport', 'edit'), updatePassportDetails);

// Update visa - requires edit permission
router.patch("/visa/:id", checkPermission('hrm_employees_view_visa', 'edit'), updateVisaDetails);
router.delete("/visa/:id/:type", checkPermission('hrm_employees_view_visa', 'edit'), deleteVisaDetails);

// Update Emirates ID - requires edit permission
router.patch("/emirates-id/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateEmiratesIdDetails);

// Update Labour Card - requires edit permission
router.patch("/labour-card/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateLabourCardDetails);

// Update Medical Insurance - requires edit permission
router.patch("/medical-insurance/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateMedicalInsuranceDetails);

// Update Driving License - requires edit permission
router.patch("/driving-license/:id", checkPermission('hrm_employees_view_passport', 'edit'), updateDrivingLicenseDetails);

// Upload profile picture - requires edit permission
router.post("/upload-profile-picture/:id", checkPermission('hrm_employees_view_basic', 'edit'), uploadProfilePicture);

// Upload e-signature - requires work details edit permission
router.post("/:id/upload-signature", checkPermission('hrm_employees_view_work', 'edit'), uploadSignature);

// Upload document to Cloudinary - requires edit permission
router.post("/upload-document/:id", checkPermission('hrm_employees_view', 'edit'), uploadDocument);
router.post("/:id/document", checkPermission('hrm_employees_view', 'edit'), addDocument);
router.patch("/:id/document/:index", checkPermission('hrm_employees_view', 'edit'), updateDocument);
router.delete("/:id/document/:index", checkPermission('hrm_employees_view', 'edit'), deleteDocument);

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
router.post("/:id/training", checkPermission('hrm_employees_view_training', 'create'), addTraining);
router.patch("/:id/training/:trainingId", checkPermission('hrm_employees_view_training', 'edit'), updateTraining);
router.delete("/:id/training/:trainingId", checkPermission('hrm_employees_view_training', 'delete'), deleteTraining);

// Send approval email - requires edit permission
router.post("/:id/send-approval-email", checkPermission('hrm_employees', 'edit'), sendApprovalEmail);

// Approve profile - requires edit permission
router.post("/:id/approve-profile", checkPermission('hrm_employees', 'edit'), approveProfile);

// Reject profile - requires edit permission
router.post("/:id/reject-profile", checkPermission('hrm_employees', 'edit'), rejectProfile);

// Update profile status (Downgrade/Reset) - requires edit permission
router.patch("/:id/profile-status", checkPermission('hrm_employees', 'edit'), updateProfileStatus);

// Notice Request - requires work details edit permission
router.post("/:id/request-notice", checkPermission('hrm_employees_view_work', 'edit'), requestNotice);

// Update Notice Status (Approve/Reject) - requires work details edit permission
router.patch("/:id/update-notice-status", checkPermission('hrm_employees_view_work', 'edit'), updateNoticeStatus);

// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
// Using 'view' permission on 'hrm_loan' for now as basic access check
// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
// Using 'view' permission on 'hrm_loan' for now as basic access check
// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
// Using 'view' permission on 'hrm_loan' for now as basic access check
// Request Loan/Advance - requires view permission (anyone can apply usually, or restricted?)
router.post("/request-loan", checkPermission('hrm_loan', 'view'), requestLoan);
// Approve/Reject Loan - requires edit permission
router.put("/loans/:id/status", checkPermission('hrm_loan', 'edit'), approveLoan);
router.put("/loans/:id", checkPermission('hrm_loan', 'view'), updateLoanDetails); // Use 'view' permission for user self-edit or specific check? logic inside
router.get("/loans/:id/pdf", checkPermission('hrm_loan', 'view'), getLoanPdf); // New PDF Download Route
router.get("/loans", checkPermission('hrm_loan', 'view'), getLoans);
router.get("/loans/:id", checkPermission('hrm_loan', 'view'), getLoanById);


// Get specific document - requires view permission
router.get("/:id/document", checkPermission('hrm_employees_view', 'view'), getEmployeeDocument);

// Generic :id routes must come last
// Get employee by ID - requires view permission
router.get("/:id", checkPermission('hrm_employees_view', 'view'), getEmployeeById);

// Delete employee - requires delete permission
router.delete("/:id", checkPermission('hrm_employees', 'delete'), deleteEmployee);

export default router;


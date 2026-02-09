import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { sendFineConfirmedEmail } from "../../utils/sendFineConfirmedEmail.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { sendHODAuthorizationEmail } from "../../utils/sendHODAuthorizationEmail.js";
import { sendFineStageEmail } from "../../utils/sendFineStageEmail.js";
import { isValidStorageUrl } from "../../utils/validationHelper.js";

/**
 * Approve Fine - Sequential Workflow
 * Sequence: Reportee -> HR -> Accounts -> CEO -> Approved
 */
export const approveFine = async (req, res) => {
    let { id } = req.params;

    // Sanitize ID (remove artifacts like ":1")
    if (id && typeof id === 'string' && id.includes(':')) {
        id = id.split(':')[0].trim();
    }

    try {
        // 1. Fetch Fine
        let fine;
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        if (isValidObjectId) {
            fine = await Fine.findOne({ $or: [{ _id: id }, { fineId: id }] });
        } else {
            fine = await Fine.findOne({ fineId: id });
        }

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        // 2. Identify Logged-In User
        let userBasic = null;
        if (req.user.employeeId) {
            userBasic = await EmployeeBasic.findOne({ employeeId: req.user.employeeId });
        } else if (req.user.companyEmail) {
            userBasic = await EmployeeBasic.findOne({ companyEmail: req.user.companyEmail });
        } else if (req.user.email) {
            userBasic = await EmployeeBasic.findOne({ $or: [{ companyEmail: req.user.email }, { email: req.user.email }, { workEmail: req.user.email }] });
        }

        // Admin Override 
        const isAdmin = req.user.isAdmin === true;
        if (!userBasic && !isAdmin) {
            return res.status(403).json({ message: "User not recognized as an employee." });
        }

        // 3. Determine User Roles
        const dept = (userBasic?.department || '').toLowerCase();
        const desig = (userBasic?.designation || '').toLowerCase();


        const isManagement = dept.includes('management') && ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m'].includes(desig);
        const isHR = dept.includes('hr') || dept.includes('human resource') || dept.includes('hrm') || dept.includes('human resources') || desig.includes('hr');
        const isAccounts = dept.includes('account') || dept.includes('finance') || dept.includes('payroll') || desig.includes('account');

        // Reportee/Manager Check logic
        let isAuthorizedManager = false;

        console.log("ApproveFine: Start", { fineId: fine.fineId, status: fine.fineStatus, userId: req.user._id, userEmpId: userBasic?.employeeId });

        // 0. Primary Reportee Check (Hierarchy Fallback)
        // Explicitly check if the current user is the Manager of the fined employee
        if (fine.assignedEmployees && fine.assignedEmployees.length > 0) {
            const finedEmpId = fine.assignedEmployees[0].employeeId;
            if (finedEmpId) {
                const finedEmp = await EmployeeBasic.findOne({ employeeId: finedEmpId }).select('primaryReportee');
                if (finedEmp && finedEmp.primaryReportee) {
                    // Check against User linked to that Reportee (EmployeeBasic Ref)
                    // Does req.user (User) match the primaryReportee (EmployeeBasic ID)?
                    // We need to match User -> EmployeeBasic
                    // NOTE: This comparison assumes 'primaryReportee' is an ObjectId referencing EmployeeBasic
                    // AND 'userBasic' is the full EmployeeBasic document of the logged-in user.
                    // So we must compare finedEmp.primaryReportee (ObjectId) with userBasic._id (ObjectId).
                    // Previous attempt compared with userBasic._id which IS CORRECT.
                    if (userBasic && String(finedEmp.primaryReportee) === String(userBasic._id)) {
                        isAuthorizedManager = true;
                    }
                }
                console.log("ApproveFine: Checked Hierarchy", { finedEmpId, managerRef: finedEmp?.primaryReportee, currentUserBasicId: userBasic?._id, didMatch: isAuthorizedManager });
            }
        }

        // 0.5 Creator Check (If Manager created the fine, they can approve it to move it to HR)
        if (fine.createdBy && String(fine.createdBy) === String(req.user._id)) {
            isAuthorizedManager = true;
            console.log("ApproveFine: Authorized via Creator (Self-Created Fine)");
        }

        // 1. Check strict assignment (SubmittedTo or Workflow)
        if (fine.submittedTo && fine.submittedTo.toString() === req.user._id.toString()) {
            isAuthorizedManager = true;
        } else if (fine.workflow && fine.workflow.some(w => w.status === 'Pending' && w.assignedTo && w.assignedTo.toString() === req.user._id.toString())) {
            isAuthorizedManager = true;
        }

        console.log("ApproveFine: Checked Strict", { submittedTo: fine.submittedTo, isAuthorizedManager });

        // 2. Fallback: Check if user is the assigned employee (Self-approval?? usually Manager approves, but keeping for legacy)
        // Actually, "Reportee" usually means "Reporting Manager". The frontend says "Reportee" step.
        // If the fined employee is "assignedEmployees", the APPROVER is the Manager.
        // So checking isAssignedEmployee is strictly WRONG for approval unless it's a self-acknowledgement flow.
        // But the flow says "Reportee -> HR", implying Manager.

        // We will trust isAuthorizedManager (which relies on addFine.js setting submittedTo correctly).
        // If submittedTo is missing (legacy), we might need to recalculate manager, but let's stick to the workflow/submittedTo fix I just added.

        // 4. State Machine transitions
        let modified = false;
        const currentStatus = fine.fineStatus;

        console.log("ApproveFine: Entering Stage 1 Check", { currentStatus, isAuthorizedManager, isAdmin });

        // --- STAGE 1: Reportee/Manager (Pending -> Pending HR) ---
        if (currentStatus === 'Pending') {
            if (isAuthorizedManager || isAdmin) {
                fine.fineStatus = 'Pending HR';
                fine.managerApprovedBy = req.user._id; // Set persistent manager approver

                // Mark individual approval if needed
                fine.assignedEmployees.forEach(e => {
                    if (userBasic && e.employeeId === userBasic.employeeId) {
                        e.approvalStatus = 'Pending HR';
                    }
                });
                modified = true;

                // Notify HR
                console.log("hi i found the hod email sending section ");

                const applicantId = fine.assignedEmployees?.[0]?.employeeId;
                const hrHOD = await import("../../utils/getDepartmentHOD.js").then(m => m.getDepartmentHOD('hr', applicantId));
                const hrEmails = hrHOD?.companyEmail ? [hrHOD.companyEmail] : [];
                if (hrEmails.length === 0) hrEmails.push(process.env.HR_EMAIL || 'hr@verp.com');

                // PUSH TO DASHBOARD: Update workflow & submittedTo
                let nextApproverFound = false;
                console.log("hy i found the hod dashboard logic ........");

                if (hrHOD) {
                    console.log("hi im inside the dashbord logic in fine ....");

                    const hrUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: hrHOD.employeeId }));
                    if (hrUser) {
                        fine.submittedTo = hrUser._id;
                        nextApproverFound = true;

                        // 1. Mark Current User (Reportee/Manager) as Approved in Workflow
                        if (!fine.workflow) fine.workflow = [];

                        // Strict check: Find the pending step assigned to ME or my role
                        const managerEntry = fine.workflow.find(w =>
                            w.status === 'Pending' &&
                            (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Manager' || w.role === 'Reportee')
                        );

                        if (managerEntry) {
                            managerEntry.status = 'Approved';
                            managerEntry.actionedAt = new Date();
                        } else {
                            // Fallback if no pending step found for me (legacy data)
                            fine.workflow.push({
                                role: 'Manager',
                                assignedTo: req.user._id,
                                status: 'Approved',
                                assignedAt: fine.createdAt || new Date(),
                                actionedAt: new Date()
                            });
                        }

                        // 2. Push Next Step (HR) - ONLY if not already pending
                        const nextStepExists = fine.workflow.some(w => w.role === 'HR' && w.status === 'Pending');
                        if (!nextStepExists) {
                            fine.workflow.push({
                                role: 'HR',
                                assignedTo: hrUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }
                    }
                }

                if (!nextApproverFound) {
                    console.warn(`[Fine ${fine.fineId}] HR Approver User NOT FOUND. Releasing 'submittedTo' to allow Department Pool visibility.`);
                    fine.submittedTo = null; // Release from Manager
                    // Ensure Workflow for Manager is marked done even if next step fails assignment
                    if (!fine.workflow) fine.workflow = [];
                    const managerEntry = fine.workflow.find(w => w.status === 'Pending' && (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Manager'));
                    if (managerEntry) { managerEntry.status = 'Approved'; managerEntry.actionedAt = new Date(); }
                }

                console.log(`[Fine ${fine.fineId}] Reportee Approved. Next HR Approver Found: ${nextApproverFound}`);
                await sendFineStageEmail(fine, hrEmails, 'HR');
            } else {
                return res.status(403).json({ message: "Only the assigned employee can approve at this stage." });
            }
        }
        // --- STAGE 2: HR (Pending HR -> Pending Accounts) ---
        else if (currentStatus === 'Pending HR') {
            const isAssignedToMe = fine.submittedTo?.toString() === req.user._id.toString() ||
                fine.workflow?.some(w => w.status === 'Pending' && w.role === 'HR' && w.assignedTo?.toString() === req.user._id.toString());

            if (isHR || isAdmin || isAssignedToMe) {
                fine.fineStatus = 'Pending Accounts';
                fine.hrApprovedBy = req.user._id;
                modified = true;

                // Notify Accounts
                const applicantId = fine.assignedEmployees?.[0]?.employeeId;
                const accountsHOD = await import("../../utils/getDepartmentHOD.js").then(m => m.getDepartmentHOD('finance', applicantId));
                const accEmails = accountsHOD?.companyEmail ? [accountsHOD.companyEmail] : [];
                if (accEmails.length === 0) accEmails.push(process.env.ACCOUNTS_EMAIL || 'accounts@verp.com');

                // PUSH TO DASHBOARD: Update workflow & submittedTo
                let nextApproverFound = false;
                if (accountsHOD) {
                    const accUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: accountsHOD.employeeId }));
                    if (accUser) {
                        fine.submittedTo = accUser._id;
                        nextApproverFound = true;

                        // 1. Update HR Entry in Workflow to Approved
                        const hrEntry = fine.workflow.find(w =>
                            w.status === 'Pending' &&
                            (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'HR')
                        );

                        if (hrEntry) {
                            hrEntry.status = 'Approved';
                            hrEntry.actionedAt = new Date();
                        } else {
                            fine.workflow.push({
                                role: 'HR',
                                assignedTo: req.user._id,
                                status: 'Approved',
                                assignedAt: new Date(),
                                actionedAt: new Date()
                            });
                        }

                        // 2. Push Next Step (Accounts)
                        const nextStepExists = fine.workflow.some(w => w.role === 'Accounts' && w.status === 'Pending');
                        if (!nextStepExists) {
                            fine.workflow.push({
                                role: 'Accounts',
                                assignedTo: accUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }
                    }
                }

                if (!nextApproverFound) {
                    console.warn(`[Fine ${fine.fineId}] Accounts Approver User NOT FOUND. Releasing 'submittedTo'.`);
                    fine.submittedTo = null;
                    const hrEntry = fine.workflow.find(w => w.status === 'Pending' && (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'HR'));
                    if (hrEntry) { hrEntry.status = 'Approved'; hrEntry.actionedAt = new Date(); }
                }

                console.log(`[Fine ${fine.fineId}] HR Approved. Next Finance Approver Found: ${nextApproverFound}`);
                await sendFineStageEmail(fine, accEmails, 'Accounts');
            } else {
                return res.status(403).json({ message: "Only HR can approve at this stage." });
            }
        }
        // --- STAGE 3: Accounts (Pending Accounts -> Pending Authorization) ---
        else if (currentStatus === 'Pending Accounts') {
            const isAssignedToMe = fine.submittedTo?.toString() === req.user._id.toString() ||
                fine.workflow?.some(w => w.status === 'Pending' && w.role === 'Accounts' && w.assignedTo?.toString() === req.user._id.toString());

            if (isAccounts || isAdmin || isAssignedToMe) {
                fine.fineStatus = 'Pending Authorization';
                fine.accountsApprovedBy = req.user._id;
                modified = true;

                // Notify Management
                const applicantId = fine.assignedEmployees?.[0]?.employeeId;
                const hod = await getManagementHOD(applicantId);
                let nextApproverFound = false;
                if (hod) {
                    // Update submittedTo
                    const hodUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: hod.employeeId }));
                    if (hodUser) {
                        fine.submittedTo = hodUser._id;
                        nextApproverFound = true;

                        // 1. Update Accounts Entry to Approved
                        const accEntry = fine.workflow.find(w =>
                            w.status === 'Pending' &&
                            (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Accounts')
                        );

                        if (accEntry) {
                            accEntry.status = 'Approved';
                            accEntry.actionedAt = new Date();
                        } else {
                            fine.workflow.push({
                                role: 'Accounts',
                                assignedTo: req.user._id,
                                status: 'Approved',
                                assignedAt: new Date(),
                                actionedAt: new Date()
                            });
                        }

                        // 2. Push Next Step (Management)
                        const nextStepExists = fine.workflow.some(w => w.role === 'Management' && w.status === 'Pending');
                        if (!nextStepExists) {
                            fine.workflow.push({
                                role: 'Management',
                                assignedTo: hodUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }
                    }

                    console.log(`[Fine ${fine.fineId}] Finance Approved. Next Management:`, hod ? `${hod.firstName} ${hod.lastName}` : 'NOT FOUND');
                    await sendHODAuthorizationEmail('Fine', fine, hod, {
                        name: 'Accounts Department',
                        designation: 'Finance'
                    });
                }

                if (!nextApproverFound) {
                    console.warn(`[Fine ${fine.fineId}] Management User NOT FOUND. Releasing 'submittedTo'.`);
                    fine.submittedTo = null;
                    const accEntry = fine.workflow.find(w => w.status === 'Pending' && (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Accounts'));
                    if (accEntry) { accEntry.status = 'Approved'; accEntry.actionedAt = new Date(); }
                }
            } else {
                return res.status(403).json({ message: "Only Accounts can approve at this stage." });
            }
        }
        // --- STAGE 4: Management (Pending Authorization -> Approved) ---
        else if (currentStatus === 'Pending Authorization') {
            const isAssignedToMe = fine.submittedTo?.toString() === req.user._id.toString() ||
                fine.workflow?.some(w => w.status === 'Pending' && w.role === 'Management' && w.assignedTo?.toString() === req.user._id.toString());

            if (isManagement || isAdmin || isAssignedToMe) {
                fine.fineStatus = 'Approved';
                fine.approvedBy = req.user._id;
                fine.approvedDate = new Date();
                modified = true;

                // Mark all assigned as Approved (for consistency with display logic)
                fine.assignedEmployees.forEach(e => {
                    e.approvalStatus = 'Approved';
                    e.approvedAt = new Date();
                    e.approvedBy = req.user._id;
                });

                // Update Management Workflow to Approved
                const managementEntry = fine.workflow.find(w =>
                    w.status === 'Pending' &&
                    (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'Management')
                );

                if (managementEntry) {
                    managementEntry.status = 'Approved';
                    managementEntry.actionedAt = new Date();
                } else {
                    fine.workflow.push({
                        role: 'Management',
                        assignedTo: req.user._id,
                        status: 'Approved',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }

                // Notify Employee (Success)
                await sendFineConfirmedEmail(fine, fine.assignedEmployees);

            } else {
                return res.status(403).json({ message: "Only Management can approve at this stage." });
            }
        }

        else {
            return res.status(400).json({ message: "No actionable status found for this fine." });
        }

        if (modified) {
            await fine.save();
            return res.status(200).json({
                message: "Fine approved successfully.",
                fine
            });
        }

        return res.status(200).json({ message: "No changes made." });

    } catch (error) {
        console.error("Error approving fine:", error);
        return res.status(500).json({ message: error.message || "Failed to approve fine" });
    }
};

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
            userBasic = await EmployeeBasic.findOne({ companyEmail: req.user.email });
        }

        // Admin Override (for debugging/super-admin actions)
        const isAdmin = req.user.role === 'Admin' || req.user.role === 'SuperAdmin';
        if (!userBasic && !isAdmin) {
            return res.status(403).json({ message: "User not recognized as an employee." });
        }

        // 3. Determine User Roles
        const dept = (userBasic?.department || '').toLowerCase();
        const desig = (userBasic?.designation || '').toLowerCase();

        const isCEO = dept.includes('management') && ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m'].includes(desig);
        const isHR = dept.includes('hr') || dept.includes('human resource');
        const isAccounts = dept.includes('account') || dept.includes('finance');

        // Reportee Check
        // Can approve if user is the assigned employee OR their primary manager (fallback)
        // Strict requirement: "reportee email and button... only enabled for the reportee"
        // So we strictly check if user is the assigned employee.
        // Assuming single employee per fine for this workflow primarily, but code supports array.
        const isAssignedEmployee = fine.assignedEmployees.some(e => {
            return userBasic && (e.employeeId === userBasic.employeeId);
        });

        // 4. State Machine transitions
        let modified = false;
        const currentStatus = fine.fineStatus;

        // --- STAGE 1: Reportee (Pending -> Pending HR) ---
        if (currentStatus === 'Pending') {
            if (isAssignedEmployee || isAdmin) {
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
                const hrHOD = await import("../../utils/getDepartmentHOD.js").then(m => m.getDepartmentHOD('hr'));
                const hrEmails = hrHOD?.companyEmail ? [hrHOD.companyEmail] : [];
                if (hrEmails.length === 0) hrEmails.push(process.env.HR_EMAIL || 'hr@verp.com');

                // PUSH TO DASHBOARD: Update workflow & submittedTo
                if (hrHOD) {
                    const hrUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: hrHOD.employeeId }));
                    if (hrUser) {
                        fine.submittedTo = hrUser._id;

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

                console.log(`[Fine ${fine.fineId}] Reportee Approved. Next HR Approver:`, hrHOD ? `${hrHOD.firstName} ${hrHOD.lastName}` : 'NOT FOUND');
                await sendFineStageEmail(fine, hrEmails, 'HR');
            } else {
                return res.status(403).json({ message: "Only the assigned employee can approve at this stage." });
            }
        }
        // --- STAGE 2: HR (Pending HR -> Pending Accounts) ---
        else if (currentStatus === 'Pending HR') {
            if (isHR || isAdmin) {
                fine.fineStatus = 'Pending Accounts';
                fine.hrApprovedBy = req.user._id;
                modified = true;

                // Notify Accounts
                const accountsHOD = await import("../../utils/getDepartmentHOD.js").then(m => m.getDepartmentHOD('finance'));
                const accEmails = accountsHOD?.companyEmail ? [accountsHOD.companyEmail] : [];
                if (accEmails.length === 0) accEmails.push(process.env.ACCOUNTS_EMAIL || 'accounts@verp.com');

                // PUSH TO DASHBOARD: Update workflow & submittedTo
                if (accountsHOD) {
                    const accUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: accountsHOD.employeeId }));
                    if (accUser) {
                        fine.submittedTo = accUser._id;

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

                console.log(`[Fine ${fine.fineId}] HR Approved. Next Finance Approver:`, accountsHOD ? `${accountsHOD.firstName} ${accountsHOD.lastName}` : 'NOT FOUND');
                await sendFineStageEmail(fine, accEmails, 'Accounts');
            } else {
                return res.status(403).json({ message: "Only HR can approve at this stage." });
            }
        }
        // --- STAGE 3: Accounts (Pending Accounts -> Pending Authorization) ---
        else if (currentStatus === 'Pending Accounts') {
            if (isAccounts || isAdmin) {
                fine.fineStatus = 'Pending Authorization';
                fine.accountsApprovedBy = req.user._id;
                modified = true;

                // Notify CEO
                const hod = await getManagementHOD();
                if (hod) {
                    // Update submittedTo
                    const hodUser = await import("../../models/User.js").then(m => m.default.findOne({ employeeId: hod.employeeId }));
                    if (hodUser) {
                        fine.submittedTo = hodUser._id;

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

                        // 2. Push Next Step (CEO)
                        const nextStepExists = fine.workflow.some(w => w.role === 'CEO' && w.status === 'Pending');
                        if (!nextStepExists) {
                            fine.workflow.push({
                                role: 'CEO',
                                assignedTo: hodUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            });
                        }
                    }

                    console.log(`[Fine ${fine.fineId}] Finance Approved. Next CEO:`, hod ? `${hod.firstName} ${hod.lastName}` : 'NOT FOUND');
                    await sendHODAuthorizationEmail('Fine', fine, hod, {
                        name: 'Accounts Department',
                        designation: 'Finance'
                    });
                }
            } else {
                return res.status(403).json({ message: "Only Accounts can approve at this stage." });
            }
        }
        // --- STAGE 4: CEO (Pending Authorization -> Approved) ---
        else if (currentStatus === 'Pending Authorization') {
            if (isCEO || isAdmin) {
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

                // Update CEO Workflow to Approved
                const ceoEntry = fine.workflow.find(w =>
                    w.status === 'Pending' &&
                    (w.assignedTo?.toString() === req.user._id.toString() || w.role === 'CEO')
                );

                if (ceoEntry) {
                    ceoEntry.status = 'Approved';
                    ceoEntry.actionedAt = new Date();
                } else {
                    fine.workflow.push({
                        role: 'CEO',
                        assignedTo: req.user._id,
                        status: 'Approved',
                        assignedAt: new Date(),
                        actionedAt: new Date()
                    });
                }

                // Notify Employee (Success)
                await sendFineConfirmedEmail(fine, fine.assignedEmployees);

            } else {
                return res.status(403).json({ message: "Only CEO/Management can approve at this stage." });
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

import Fine from "../../models/Fine.js";
import { sendFineRejectedEmail } from "../../utils/sendFineRejectedEmail.js";
import { isValidStorageUrl } from "../../utils/validationHelper.js";

import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { sendFineApprovalEmail } from "../../utils/sendFineApprovalEmail.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { isVehicleFinePayload, validateVehicleFinePayload } from "../../utils/validateVehicleFinePayload.js";
import { canUserActOnFineStageAsync } from "../../utils/fineStageAuth.js";
import {
    isApprovedFineStatus,
    isUserHrForApprovedFineEdit,
    restrictApprovedFineUpdates,
} from "../../utils/fineApprovedEditAuth.js";
import {
    preserveOriginalDeductionScheduleBeforeEdit,
    scheduleFieldsAreChanging,
    snapshotDeductionScheduleOnApproval,
} from "../../utils/fineDeductionScheduleSnapshot.js";
import { normalizeFineSourceSchedule } from "../../utils/normalizeFineSourceSchedule.js";
import { ensureAttachmentPersistedToS3 } from "../../utils/s3Upload.js";

export const updateFine = async (req, res) => {
    try {
        console.log("hi");
        
        let { id } = req.params;
        const updates = req.body;

        if (Array.isArray(updates.attachments) && updates.attachments.some((item) => item?.data)) {
            const folder = `fines/${id}`;
            const persisted = [];
            for (let index = 0; index < updates.attachments.length; index += 1) {
                const item = updates.attachments[index];
                if (!item) continue;
                if (item.data) {
                    const saved = await ensureAttachmentPersistedToS3(item, {
                        folder,
                        fileName: item.name || `fine-attachment-${index + 1}`,
                        resourceType: 'auto',
                    });
                    if (saved) persisted.push(saved);
                } else if (item.url || item.publicId) {
                    persisted.push(item);
                }
            }
            updates.attachments = persisted;
            if (persisted[0]) updates.attachment = persisted[0];
        }

        // Security check for attachment URL to prevent SSRF (Early exit)
        if (updates.attachment && updates.attachment.url) {
            if (!isValidStorageUrl(updates.attachment.url)) {
                return res.status(400).json({ message: "Invalid or unauthorized attachment URL provided." });
            }
        }

        // Sanitize ID (remove artifacts like ":1")
        if (id && typeof id === 'string' && id.includes(':')) {
            id = id.split(':')[0].trim();
        }

        // ... (rest of lookup logic)
        // 1. Fetch Related Fines (Support Group Updates)
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
        let fines = [];

        if (isValidObjectId) {
            const targetFine = await Fine.findById(id);
            if (targetFine) {
                const baseId = targetFine.fineId.split('-').length > 3
                    ? targetFine.fineId.split('-').slice(0, 3).join('-')
                    : targetFine.fineId;
                const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
                fines = await Fine.find({ fineId: baseIdRegex }).populate('createdBy', 'name');
            }
        }

        if (fines.length === 0) {
            const baseId = id.split('-').length > 3 ? id.split('-').slice(0, 3).join('-') : id;
            const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
            fines = await Fine.find({ fineId: baseIdRegex }).populate('createdBy', 'name');
        }

        if (fines.length === 0) {
            return res.status(404).json({ message: "Fine(s) not found" });
        }

        const fine = fines[0]; // Primary reference for logic

        const isApproved = isApprovedFineStatus(fine.fineStatus);
        let isAssetController = false;
        if (isApproved && req.user) {
            try {
                const { isUserInFlowchart } = await import("../../utils/getDepartmentHOD.js");
                isAssetController = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
            } catch (e) {
                console.error("Error checking asset controller:", e);
            }
            if (!isAssetController) {
                const empId = req.user.employeeId;
                if (empId) {
                    const emp = await EmployeeBasic.findOne({ employeeId: empId }).select('department designation').lean();
                    const dept = (emp?.department || '').toLowerCase();
                    const des = (emp?.designation || '').toLowerCase();
                    if (des === 'asset controller' || des.includes('asset controller') || dept.includes('asset controller')) {
                        isAssetController = true;
                    }
                }
            }
        }

        if (
            isApproved &&
            !updates.resubmit &&
            updates.fineStatus !== 'Rejected'
        ) {
            const hrOk = await isUserHrForApprovedFineEdit(req, fine);
            if (!hrOk && !isAssetController) {
                return res.status(403).json({ message: 'Only HR and Asset Controller can edit approved fines.' });
            }

            if (!hrOk && isAssetController) {
                // Asset Controller can only remove accessories
                const keys = Object.keys(updates);
                const hasNonAccessoryUpdates = keys.some(k => k !== 'excludedAccessoryIds' && k !== 'resubmit');
                if (hasNonAccessoryUpdates) {
                    return res.status(400).json({ message: 'Asset Controller can only edit accessories removal on approved fines.' });
                }
            } else if (hrOk && !isAssetController) {
                // HR can only update schedule fields
                const { error, allowed } = restrictApprovedFineUpdates(updates, fine);
                if (error) {
                    return res.status(400).json({ message: error });
                }
                for (const key of Object.keys(updates)) {
                    delete updates[key];
                }
                Object.assign(updates, allowed);
            } else {
                // Both roles: allow both schedule and accessories removal
                const { allowed } = restrictApprovedFineUpdates(updates, fine);
                const finalUpdates = { ...allowed };
                if (updates.excludedAccessoryIds !== undefined) {
                    finalUpdates.excludedAccessoryIds = updates.excludedAccessoryIds;
                }
                for (const key of Object.keys(updates)) {
                    delete updates[key];
                }
                Object.assign(updates, finalUpdates);
            }
        }

        const oldStatus = fine.fineStatus;
        let shouldSendApprovalEmail = false;
        let statusHandled = false;

        if (updates.sourceOfIncome !== undefined || updates.payableDuration !== undefined) {
            const src = updates.sourceOfIncome ?? fine.sourceOfIncome ?? 'Salary';
            if (src === 'End of Service') {
                updates.sourceOfIncome = 'End of Service';
                updates.payableDuration = null;
                updates.monthStart = updates.monthStart ?? '';
            } else if (updates.payableDuration !== undefined) {
                const duration = parseInt(updates.payableDuration, 10);
                updates.payableDuration =
                    Number.isFinite(duration) && duration >= 1 ? duration : null;
            }
        }

        // 1. Explicitly Define Allowed Fields (Fix Mass Assignment)
        const allowedUpdates = [
            'fineStatus', 'description', 'awardedDate', 'remarks',
            'attachment', 'attachments', 'category', 'subCategory', 'vehicleId', 'assetId', 'assetName',
            'projectId', 'projectName', 'engineerName', 'responsibleFor',
            'fineAmount', 'employeeAmount', 'companyAmount', 'serviceCharge', 'payableDuration', 'monthStart',
            'sourceOfIncome', 'assetDepreciationAmount', 'assetPurchaseDate',
            'employees', 'totalEmployeeFineAmount', 'company', 'companyName', 'companyDescription',
            'excludedAccessoryIds', 'breakdownItems',
        ];

        const mergedVehicleFine = {
            fineType: updates.fineType ?? fine.fineType,
            subCategory: updates.subCategory ?? fine.subCategory,
            vehicleId: updates.vehicleId ?? fine.vehicleId,
            employeeId: updates.employeeId,
            employees: updates.employees ?? fine.assignedEmployees,
            fineAmount: updates.fineAmount ?? fine.fineAmount,
            serviceCharge: updates.serviceCharge ?? fine.serviceCharge,
            responsibleFor: updates.responsibleFor ?? fine.responsibleFor,
            employeeAmount: updates.employeeAmount ?? fine.employeeAmount,
            companyAmount: updates.companyAmount ?? fine.companyAmount,
            description: updates.description ?? fine.description,
            companyDescription: updates.companyDescription ?? fine.companyDescription,
            company: updates.company ?? fine.company,
            payableDuration: updates.payableDuration ?? fine.payableDuration,
            monthStart: updates.monthStart ?? fine.monthStart,
            attachment: updates.attachment ?? fine.attachment,
            attachments: updates.attachments ?? fine.attachments,
        };
        if (isVehicleFinePayload(mergedVehicleFine)) {
            const strictSubmit =
                updates.resubmit === true ||
                updates.fineStatus === 'Pending' ||
                (oldStatus === 'Draft' && updates.fineStatus === 'Pending');
            if (strictSubmit || oldStatus === 'Draft') {
                const vehicleCheck = validateVehicleFinePayload(mergedVehicleFine, {
                    mode: strictSubmit ? 'strict' : 'draft',
                    hasExistingAttachment: Boolean(
                        mergedVehicleFine.attachment?.url ||
                        mergedVehicleFine.attachment?.data ||
                        fine.attachment?.url ||
                        (Array.isArray(mergedVehicleFine.attachments) &&
                            mergedVehicleFine.attachments.some((item) => item?.url || item?.publicId)) ||
                        (Array.isArray(fine.attachments) &&
                            fine.attachments.some((item) => item?.url || item?.publicId))
                    ),
                });
                if (!vehicleCheck.valid) {
                    return res.status(400).json({
                        message: vehicleCheck.message || 'Invalid vehicle fine data',
                        errors: vehicleCheck.errors,
                    });
                }
            }
        }

        // 2. Perform submission logic from Draft -> Pending
        if (oldStatus === 'Draft' && updates.fineStatus === 'Pending') {
            console.log("[UpdateFine] Submitting Draft Fine. Routing directly to HR...");
            const bulkIds = fine.assignedEmployees
                .map(e => e.employeeId)
                .filter(id => id && id !== 'VEGA-HR-0000');

            // Validation: Company check
            const employeesWithNoCompany = await EmployeeBasic.find({
                employeeId: { $in: bulkIds },
                $or: [{ company: { $exists: false } }, { company: null }]
            }).select('firstName lastName employeeId');

            if (employeesWithNoCompany.length > 0) {
                const names = employeesWithNoCompany.map(e => `${e.firstName} ${e.lastName || ''}`.trim());
                return res.status(400).json({
                    message: `Cannot submit: The following users have no company: ${names.join(', ')}. Please update their profile first.`
                });
            }

            // Identify target HR HOD for the first employee's company
            const targetEmpId = (fine.assignedEmployees && fine.assignedEmployees.length > 0)
                ? fine.assignedEmployees[0].employeeId
                : null;

            if (targetEmpId) {
                try {
                    const hrHOD = await getDepartmentHOD('hr', targetEmpId);
                    if (hrHOD) {
                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        if (hrUser) {
                            for (const f of fines) {
                                f.submittedTo = hrUser._id;
                                f.fineStatus = 'Pending HR';
                                f.workflow = [
                                    { role: 'HR', assignedTo: hrUser._id, status: 'Pending', assignedAt: new Date() }
                                ];
                                normalizeFineSourceSchedule(f);
                                await f.save();
                            }
                            shouldSendApprovalEmail = true;
                            statusHandled = true;
                            console.log(`[UpdateFine] ${fines.length} Fines routed directly to HR: ${hrUser._id}`);
                        }
                    }
                } catch (snapErr) {
                    console.error('[UpdateFine] Error resolving HR:', snapErr);
                }
            }
        } else if (updates.resubmit && oldStatus === 'Rejected') {
            // === RESUBMIT LOGIC ===
            console.log("[UpdateFine] Resubmitting previously rejected fine.");
            const rejectedStep = (fine.workflow || []).find(w => w.status === 'Rejected');
            for (const f of fines) {
                const rejectedStep = (f.workflow || []).find(w => w.status === 'Rejected');
                if (rejectedStep) {
                    rejectedStep.status = 'Pending';
                    rejectedStep.actionedAt = null;
                    if (updates.remarks) rejectedStep.comment = `RESUBMITTED: ${updates.remarks}`;

                    if (rejectedStep.role === 'HR') f.fineStatus = 'Pending HR';
                    else if (rejectedStep.role === 'Accounts') f.fineStatus = 'Pending Accounts';
                    else if (rejectedStep.role === 'Management' || rejectedStep.role === 'CEO') f.fineStatus = 'Pending Authorization';
                    else f.fineStatus = 'Pending Review';

                    f.submittedTo = rejectedStep.assignedTo;
                    normalizeFineSourceSchedule(f);
                    await f.save();
                }
            }
            shouldSendApprovalEmail = true;
            statusHandled = true;
            console.log(`[UpdateFine] Resubmitted group of ${fines.length} fines.`);
        }

        if (updates.company && typeof updates.company === 'string') {
            try {
                const CompanyModel = (await import("../../models/Company.js")).default;
                const comp = await CompanyModel.findById(updates.company);
                if (comp) updates.companyName = comp.name;
            } catch (err) {
                console.warn("[UpdateFine] Could not resolve company name:", err.message);
            }
        }

        // Handle service charge distribution for group fines BEFORE the loop
        let serviceChargePerParty = 0;
        if (fines.length > 1) {
            const partiesCount = fines.length;
            const totalServiceCharge = parseFloat(
                updates.serviceCharge !== undefined ? updates.serviceCharge : fine.serviceCharge
            ) || 0;
            serviceChargePerParty = partiesCount > 0 ? (totalServiceCharge / partiesCount) : 0;
        }

        const splitAmountKeys = new Set(['fineAmount', 'employeeAmount', 'companyAmount', 'serviceCharge', 'employees']);

        // 3. Apply updates only for allowed fields (Loop all for bulk update)
        for (const f of fines) {
            if (scheduleFieldsAreChanging(f, updates)) {
                preserveOriginalDeductionScheduleBeforeEdit(f);
                f.scheduleChangeForHistory = {
                    fromMonth: f.monthStart || '',
                    fromDuration: f.payableDuration != null ? parseInt(f.payableDuration, 10) : null,
                };
            }

            const targetEmployeeId = f.assignedEmployees?.[0]?.employeeId;
            const isCompanyRecord = targetEmployeeId === 'VEGA-HR-0000';
            const empUpdate = (updates.employees && Array.isArray(updates.employees))
                ? updates.employees.find(e => e.employeeId === targetEmployeeId)
                : null;

            const scParty = fines.length > 1
                ? serviceChargePerParty
                : (parseFloat(updates.serviceCharge ?? f.serviceCharge) || 0);

            // Split Employee & Company fines: each DB row gets only its party's amounts from the modal
            if (empUpdate && fines.length > 1) {
                const rowBase = parseFloat(empUpdate.employeeAmount);
                const rowTotal = parseFloat(empUpdate.individualAmount ?? empUpdate.fineAmount);
                const base = Number.isFinite(rowBase)
                    ? rowBase
                    : Math.max(0, (Number.isFinite(rowTotal) ? rowTotal : 0) - scParty);
                const total = Number.isFinite(rowTotal) ? rowTotal : base + scParty;

                f.employeeAmount = base;
                f.companyAmount = 0;
                f.serviceCharge = scParty;
                f.fineAmount = total;
                f.totalFineAmount = total;

                if (f.assignedEmployees?.[0]) {
                    f.assignedEmployees[0].employeeAmount = base;
                    f.assignedEmployees[0].individualAmount = total;
                    f.assignedEmployees[0].fineAmount = Number.isFinite(parseFloat(empUpdate.fineAmount))
                        ? parseFloat(empUpdate.fineAmount)
                        : total;
                    if (isCompanyRecord && updates.companyName) {
                        f.assignedEmployees[0].employeeName = updates.companyName;
                    }
                }
            }

            allowedUpdates.forEach(key => {
                if (updates[key] !== undefined) {
                    if (empUpdate && fines.length > 1 && splitAmountKeys.has(key)) {
                        return;
                    }
                    if (key === 'employees') {
                        // handled via empUpdate logic
                    } else if (key === 'attachment') {
                        if (updates.attachment && updates.attachment.url && !isValidStorageUrl(updates.attachment.url)) {
                            console.warn("[UpdateFine] Invalid URL. Skipping.");
                        } else {
                            f.attachment = updates.attachment;
                        }
                    } else if (key === 'attachments') {
                        f.attachments = updates.attachments;
                        if (updates.attachment) {
                            f.attachment = updates.attachment;
                        } else if (Array.isArray(updates.attachments) && updates.attachments[0]) {
                            f.attachment = updates.attachments[0];
                        }
                    } else if (key === 'fineStatus' && statusHandled) {
                        // Already handled by Draft -> Pending or Resubmit logic
                    } else {
                        if (isCompanyRecord && key === 'companyAmount') {
                            f[key] = 0; // Company share of company record is 0
                        } else if (isCompanyRecord && (key === 'employeeAmount' || key === 'fineAmount')) {
                            // The company's base liability is stored in its employeeAmount field
                            f.employeeAmount = parseFloat(updates.companyAmount || updates.employeeAmount || 0);
                        } else if (empUpdate && ['fineAmount', 'employeeAmount', 'companyAmount', 'payableDuration'].includes(key) && empUpdate[key] !== undefined) {
                            f[key] = parseFloat(empUpdate[key]);
                        } else if (key === 'serviceCharge') {
                            // For group fines, distribute service charge equally among all parties
                            if (fines.length > 1) {
                                f.serviceCharge = serviceChargePerParty;
                            } else {
                                f.serviceCharge = parseFloat(updates[key]) || 0;
                            }
                            // Update total balances
                            const baseFine = (parseFloat(f.employeeAmount) || 0) + (parseFloat(f.companyAmount) || 0);
                            f.fineAmount = baseFine + f.serviceCharge;
                            f.totalFineAmount = f.fineAmount;
                        } else if (key === 'fineAmount') {
                            // fineAmount in updates is treated as the BASE fine amount
                            f.fineAmount = parseFloat(updates[key]) || 0;
                        } else if (key === 'employeeAmount' || key === 'companyAmount') {
                            if (isCompanyRecord) {
                                if (key === 'employeeAmount') {
                                    f.employeeAmount = parseFloat(updates.companyAmount ?? updates.employeeAmount ?? 0);
                                } else {
                                    f.companyAmount = 0;
                                }
                            } else if (key === 'employeeAmount') {
                                f.employeeAmount = parseFloat(updates.employeeAmount ?? 0);
                            } else {
                                f.companyAmount = parseFloat(updates.companyAmount ?? 0);
                            }
                        } else {
                            f[key] = updates[key];
                        }
                        
                        // If manually reverting to Draft, clear routing info
                        if (key === 'fineStatus' && updates[key] === 'Draft') {
                            f.submittedTo = null;
                            f.workflow = [];
                        }
                    }
                }
            });

            if (!(empUpdate && fines.length > 1)) {
            // Recalculate totalFineAmount from components (employeeAmount + companyAmount + serviceCharge)
            const empAmt = parseFloat(f.employeeAmount) || 0;
            const compAmt = parseFloat(f.companyAmount) || 0;
            const servCharge = parseFloat(f.serviceCharge) || 0;
            f.totalFineAmount = empAmt + compAmt + servCharge;
            f.fineAmount = f.totalFineAmount;
            
            // Sync individualAmount within the specific record for consistency
            if (f.assignedEmployees && f.assignedEmployees.length > 0) {
                const serviceChargeForThisEmployee = fines.length > 1
                    ? serviceChargePerParty
                    : servCharge;
                f.assignedEmployees[0].individualAmount = empAmt + compAmt + serviceChargeForThisEmployee;
                
                if (f.assignedEmployees[0].employeeId === 'VEGA-HR-0000' && updates.companyName) {
                    f.assignedEmployees[0].employeeName = updates.companyName;
                }
                
                if (empUpdate) {
                    if (empUpdate.fineAmount !== undefined) f.assignedEmployees[0].fineAmount = parseFloat(empUpdate.fineAmount);
                    if (empUpdate.individualAmount !== undefined) f.assignedEmployees[0].individualAmount = parseFloat(empUpdate.individualAmount);
                }
            }
            }

            if (['Approved', 'Active', 'Paid', 'Completed'].includes(f.fineStatus)) {
                const { syncFinePartyPayableAmounts } = await import('../../utils/finePayableAmount.js');
                syncFinePartyPayableAmounts(f);
                snapshotDeductionScheduleOnApproval(f);
            }

            // If excludedAccessoryIds are provided, update fine totals only — accessories stay on the asset until manual Unattach
            if (updates.excludedAccessoryIds && Array.isArray(updates.excludedAccessoryIds) && updates.excludedAccessoryIds.length > 0) {
                const excluded = new Set(updates.excludedAccessoryIds.map(String));
                let totalAccAmtRemoved = 0;

                if (f.breakdownItems?.length) {
                    for (const item of f.breakdownItems) {
                        if (item.kind !== 'accessory') continue;
                        const oid = String(item.accessoryObjectId || '');
                        const code = String(item.accessoryId || '');
                        if (excluded.has(oid) || excluded.has(code)) {
                            totalAccAmtRemoved += parseFloat(item.amount || 0) || 0;
                        }
                    }
                } else if (f.assetObjectId || f.assetId) {
                    try {
                        const AssetItem = (await import("../../models/AssetItem.js")).default;
                        const asset = await AssetItem.findById(f.assetObjectId || f.assetId)
                            .select('accessories lostDetachedAccessories')
                            .lean();
                        const allAcc = [
                            ...(asset?.accessories || []),
                            ...(asset?.lostDetachedAccessories || []),
                        ];
                        for (const acc of allAcc) {
                            const oid = String(acc._id || '');
                            const code = String(acc.accessoryId || '');
                            if (excluded.has(oid) || excluded.has(code)) {
                                totalAccAmtRemoved += parseFloat(acc.amount || 0) || 0;
                            }
                        }
                    } catch (err) {
                        console.error("Failed to load asset for accessory exclusion amounts:", err);
                    }
                }

                if (totalAccAmtRemoved > 0) {
                    const totalBase = (f.employeeAmount || 0) + (f.companyAmount || 0);
                    if (totalBase > 0) {
                        const empRatio = (f.employeeAmount || 0) / totalBase;
                        const compRatio = (f.companyAmount || 0) / totalBase;

                        f.employeeAmount = Math.max(0, f.employeeAmount - (totalAccAmtRemoved * empRatio));
                        f.companyAmount = Math.max(0, f.companyAmount - (totalAccAmtRemoved * compRatio));
                    } else {
                        f.employeeAmount = 0;
                        f.companyAmount = 0;
                    }

                    f.fineAmount = (f.employeeAmount || 0) + (f.companyAmount || 0) + (f.serviceCharge || 0);
                    f.totalFineAmount = f.fineAmount;

                    if (f.assignedEmployees && f.assignedEmployees.length > 0) {
                        for (const emp of f.assignedEmployees) {
                            if (emp.employeeId === 'VEGA-HR-0000') {
                                emp.employeeAmount = f.companyAmount;
                                emp.individualAmount = f.companyAmount;
                                emp.fineAmount = f.companyAmount;
                            } else {
                                emp.employeeAmount = f.employeeAmount;
                                emp.individualAmount = f.employeeAmount + (f.serviceCharge || 0);
                                emp.fineAmount = f.employeeAmount + (f.serviceCharge || 0);
                            }
                        }
                    }
                }

                // Sync excludedAccessoryIds list on the fine
                f.excludedAccessoryIds = Array.from(new Set([
                    ...(f.excludedAccessoryIds || []),
                    ...updates.excludedAccessoryIds
                ]));
                f.accessoryExcludedAt = new Date();

                // Sync breakdownItems list on the fine
                if (f.breakdownItems && f.breakdownItems.length > 0) {
                    f.breakdownItems = f.breakdownItems.filter(item => {
                        if (item.kind === 'accessory') {
                            const oid = String(item.accessoryObjectId || '');
                            const code = String(item.accessoryId || '');
                            return !updates.excludedAccessoryIds.includes(oid) && !updates.excludedAccessoryIds.includes(code);
                        }
                        return true;
                    });
                }
            }

            normalizeFineSourceSchedule(f);
            await f.save();
        }

        for (const f of fines) {
            if (f.scheduleChangeForHistory) {
                f.scheduleChangeForHistory.toMonth = f.monthStart || '';
                f.scheduleChangeForHistory.toDuration =
                    f.payableDuration != null ? parseInt(f.payableDuration, 10) : null;
            }
        }

        if (oldStatus !== 'Rejected' && updates.fineStatus === 'Rejected') {
            if (!updates.rejectionReason || updates.rejectionReason.trim().length === 0) {
                return res.status(400).json({ message: "Reason for rejection is mandatory." });
            }

            let userBasic = null;
            if (req.user?.employeeId) {
                userBasic = await EmployeeBasic.findOne({ employeeId: req.user.employeeId });
            }
            const isAdmin = req.user?.isAdmin === true;
            const canReject = await canUserActOnFineStageAsync({
                user: req.user,
                fine,
                isAdmin,
                employeeObjectId: userBasic?._id,
            });
            if (!canReject) {
                return res.status(403).json({
                    message: "Only the assigned approver for the current stage can reject this fine.",
                });
            }

            for (const f of fines) {
                f.fineStatus = 'Rejected';
                f.rejectedBy = req.user?._id;
                f.rejectedDate = new Date();
                f.rejectionReason = updates.rejectionReason;

                // Update Workflow to Rejected
                if (!f.workflow) f.workflow = [];
                const pendingStep = f.workflow.find(w => w.status === 'Pending');
                if (pendingStep) {
                    // This creates the rejection step
                    pendingStep.status = 'Rejected';
                    pendingStep.actionedAt = new Date();
                    pendingStep.comment = updates.rejectionReason;
                } else {
                    f.workflow.push({
                        role: 'Reviewer',
                        assignedTo: req.user?._id,
                        status: 'Rejected',
                        assignedAt: new Date(),
                        actionedAt: new Date(),
                        comment: updates.rejectionReason
                    });
                }
                
                // Route back to previous approver or creator for editing/resubmission
                let routeBackTo = f.createdBy;
                const approvedSteps = f.workflow.filter(w => w.status === 'Approved');
                if (approvedSteps.length > 0) {
                    routeBackTo = approvedSteps[approvedSteps.length - 1].assignedTo;
                }
                f.submittedTo = routeBackTo;

                normalizeFineSourceSchedule(f);
                await f.save();
            }
        }

        normalizeFineSourceSchedule(fine);
        const updatedFine = await fine.save();

        // === SYNC DASHBOARD ACTION ===
        try {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            const targetEmpId = (updatedFine.assignedEmployees && updatedFine.assignedEmployees.length > 0)
                ? updatedFine.assignedEmployees[0].employeeId
                : null;
            const subjectEmp = targetEmpId ? await EmployeeBasic.findOne({ employeeId: targetEmpId }) : null;

            const isGroup = fines.length > 1;
            const reqType = isGroup ? 'Group Fine Request' : 'Fine';
            const subjectName = isGroup ? `Group Fine - ${fines.length} Employees` : undefined;

            // 1. Resolve current pending steps
            await syncDashboardAction({
                requestId: updatedFine._id,
                requestType: reqType,
                status: updatedFine.fineStatus,
                subjectEmployee: subjectEmp,
                subjectName: subjectName,
                requestedByName: updatedFine.createdBy?.name || '',
                actionedBy: req.user?._id,
                comment: updatedFine.rejectionReason
            });

            // 2. If there's a new pending step (e.g., after resubmit or rejection back to creator), create it
            const nextPendingStep = updatedFine.workflow?.find(w => w.status === 'Pending');
            if (nextPendingStep) {
                await syncDashboardAction({
                    requestId: updatedFine._id,
                    requestType: reqType,
                    assignedTo: nextPendingStep.assignedTo,
                    status: 'Pending',
                    subjectEmployee: subjectEmp,
                    subjectName: subjectName,
                    requestedByName: updatedFine.createdBy?.name || '',
                    extra1: updatedFine.fineType,
                    extra2: isGroup 
                        ? `Total: AED ${fines.reduce((sum, f) => sum + (f.fineAmount || 0), 0)}`
                        : `AED ${updatedFine.fineAmount}`
                });
            } else if (
                oldStatus !== 'Rejected' &&
                updatedFine.fineStatus === 'Rejected' &&
                updatedFine.submittedTo
            ) {
                // Route rejection back to the prior approver (HR or Accounts) for review/resubmit.
                await syncDashboardAction({
                    requestId: updatedFine._id,
                    requestType: reqType,
                    assignedTo: updatedFine.submittedTo,
                    status: 'Pending',
                    subjectEmployee: subjectEmp,
                    subjectName: subjectName,
                    requestedByName: updatedFine.createdBy?.name || '',
                    extra1: updatedFine.fineType,
                    extra2: isGroup
                        ? `Rejected — review and resubmit (Total: AED ${fines.reduce((sum, f) => sum + (f.fineAmount || 0), 0)})`
                        : `Rejected — review and resubmit: AED ${updatedFine.fineAmount}`,
                });
            }
        } catch (syncErr) {
            console.error("[UpdateFine] Dashboard Sync Error:", syncErr);
        }

        if (shouldSendApprovalEmail) {
            const allAssigned = fines.flatMap(f => f.assignedEmployees);
            sendFineApprovalEmail(updatedFine, allAssigned).catch(err => console.error("[UpdateFine] Failed to send approval email:", err));
        }

        // If newly approved, send confirmation email with attachments
        if (oldStatus !== 'Approved' && updates.fineStatus === 'Approved') {
            try {
                const { persistFineApprovalAttachments } = await import('../../utils/persistFineApprovalAttachments.js');
                await persistFineApprovalAttachments(updatedFine, { req });
                const { dispatchFineApprovedNotification } = await import("../../utils/dispatchFineApprovedNotification.js");
                const allAssigned = fines.flatMap(f => f.assignedEmployees);
                await dispatchFineApprovedNotification(updatedFine, allAssigned, req);
                console.log(`[UpdateFine] Confirmed email sent for fine ${updatedFine.fineId}`);
            } catch (err) {
                console.error("[UpdateFine] Failed to send confirmed email:", err);
            }
        } else if (isApprovedFineStatus(oldStatus)) {
            try {
                const { persistFineApprovalAttachments } = await import('../../utils/persistFineApprovalAttachments.js');
                const regenTrigger = updates.excludedAccessoryIds !== undefined ? 'accessory-edit' : 'schedule-edit';
                for (const f of fines) {
                    await persistFineApprovalAttachments(f, {
                        req,
                        forceRegenerate: true,
                        trigger: regenTrigger,
                        scheduleChange:
                            regenTrigger === 'schedule-edit' ? f.scheduleChangeForHistory || null : null,
                    });
                    delete f.scheduleChangeForHistory;
                }
                const { dispatchFineApprovedNotification } = await import("../../utils/dispatchFineApprovedNotification.js");
                const allAssigned = fines.flatMap(f => f.assignedEmployees);
                await dispatchFineApprovedNotification(updatedFine, allAssigned, req);
                console.log(`[UpdateFine] Updated confirmed email sent for fine ${updatedFine.fineId}`);
            } catch (err) {
                console.error("[UpdateFine] Failed to update and send confirmed email:", err);
            }
        }

        // If newly rejected, send notification
        if (oldStatus !== 'Rejected' && updatedFine.fineStatus === 'Rejected') {
            try {
                // Create a plain object to modify for the email handler
                const safeFineData = updatedFine.toObject ? updatedFine.toObject() : { ...updatedFine };

                // Explicitly validate and sanitize the attachment URL
                if (safeFineData.attachment && safeFineData.attachment.url) {
                    if (!isValidStorageUrl(safeFineData.attachment.url)) {
                        console.warn(`[UpdateFine] Invalid attachment URL detected (${safeFineData.attachment.url}). Removing attachment from rejection email.`);
                        safeFineData.attachment = null; 
                    }
                }

                const allAssigned = fines.flatMap(f => f.assignedEmployees);
                await sendFineRejectedEmail(safeFineData, allAssigned);

                if (updatedFine.submittedTo) {
                    sendFineApprovalEmail(updatedFine, allAssigned).catch((err) => {
                        console.error('[UpdateFine] Routed rejection notify email failed:', err);
                    });
                }
            } catch (err) {
                console.error("Failed to send rejection email:", err);
            }
        }

        return res.status(200).json({
            message: "Fine updated successfully",
            fine: updatedFine
        });
    } catch (error) {
        console.error('Error updating fine:', error);
        return res.status(500).json({
            message: "Failed to update fine",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

import mongoose from "mongoose";
import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import AssetItem from "../../models/AssetItem.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import Company from "../../models/Company.js";
import CompanyWorkflow from "../../models/CompanyWorkflow.js";
import { loadCompaniesForExpiryScanByIds } from "../../services/companyPartitionService.js";
import { collectCompanyExpiryDocuments, buildEmployeeManualDocumentExpiryLabel, isArchivedEmployeeManualDoc } from "../../utils/companyExpiryScanUtils.js";
import { getDaysUntil, isExpiryHrTaskDueForDoc } from "../../utils/documentExpiryReminderStages.js";
import { calculateProfileCompletionBackend } from "../../utils/calculateProfileCompletionBackend.js";

/** Matches owner-style company rows — allow ASCII/en/em dashes between name and document type (same intent as frontend). */
const COMPANY_OWNER_EXPIRY_BODY_RE =
    /\s[-\u2013\u2014]\s(Passport|Visa|Visit Visa|Employment Visa|Spouse Visa|Emirates ID|Medical Insurance|Driving License|Labour Card)\s*\(/i;

const normalizeExpiryExtra1ForDedupe = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

const parseExtra2TrailingCompanyHumanId = (extra2) => {
    const m = String(extra2 || "").match(/\(([^)]*)\)\s*$/);
    return m ? String(m[1]).trim() : "";
};

/**
 * Owner document expiry uses the same `extra1` on every company copy; `requestId` differs per company.
 * Collapse to one activity row: lowest human `companyId` in `extra2`, then lowest mongo `requestId`.
 */
const ownerDocumentExpiryReminderDedupeKey = (item) => {
    if (item?.requestType !== "Document Expiry Reminder") return null;
    const e1 = String(item.extra1 || "").trim();
    if (!e1) return null;
    let ownerHint = false;
    if (item.extra3) {
        try {
            const m = JSON.parse(item.extra3);
            ownerHint = m?.ownerExpiryDedupe === true;
        } catch {
            /* ignore */
        }
    }
    if (!ownerHint && !COMPANY_OWNER_EXPIRY_BODY_RE.test(e1)) return null;
    return `CDE|OWNER|${normalizeExpiryExtra1ForDedupe(e1)}`;
};

const pickCanonicalOwnerExpiryDashboardRow = (a, b) => {
    const ah = parseExtra2TrailingCompanyHumanId(a.extra2);
    const bh = parseExtra2TrailingCompanyHumanId(b.extra2);
    if (ah && bh && ah !== bh) return ah.localeCompare(bh) < 0 ? a : b;
    if (ah && !bh) return a;
    if (!ah && bh) return b;
    const am = String(a.requestId || "");
    const bm = String(b.requestId || "");
    return am.localeCompare(bm) < 0 ? a : b;
};

const dedupeOwnerLinkedDocumentExpiryReminders = (items) => {
    if (!Array.isArray(items) || items.length < 2) return items;
    const bestByKey = new Map();
    for (const item of items) {
        const key = ownerDocumentExpiryReminderDedupeKey(item);
        if (!key) continue;
        const prev = bestByKey.get(key);
        bestByKey.set(key, prev ? pickCanonicalOwnerExpiryDashboardRow(prev, item) : item);
    }
    if (bestByKey.size === 0) return items;

    const emitted = new Set();
    const out = [];
    for (const item of items) {
        const key = ownerDocumentExpiryReminderDedupeKey(item);
        if (!key) {
            out.push(item);
            continue;
        }
        const best = bestByKey.get(key);
        const bestId = best?._id?.toString();
        const itemId = item?._id?.toString();
        if (bestId && itemId === bestId && !emitted.has(key)) {
            emitted.add(key);
            out.push(item);
        }
    }
    return out;
};

const formatExpiryDateLabel = (expiryDate) => {
    if (!expiryDate) return "";
    const d = new Date(expiryDate);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB");
};

const buildCompanyLiveExpiryExtra1Set = (company = {}) => {
    const set = new Set();
    collectCompanyExpiryDocuments(company).forEach((x) => {
        const days = getDaysUntil(x.expiryDate);
        if (days == null || !isExpiryHrTaskDueForDoc(days, { isCertificate: x.isCertificate })) return;
        const exp = formatExpiryDateLabel(x.expiryDate);
        set.add(`Expiry follow-up required: ${x.label}${exp ? ` (Exp: ${exp})` : ""}`);
    });
    return set;
};

const buildEmployeeLiveExpiryExtra1Set = (emp = {}) => {
    const labels = [];
    (emp?.documents || []).forEach((d) => {
        if (!d?.expiryDate || isArchivedEmployeeManualDoc(d)) return;
        labels.push({
            label: buildEmployeeManualDocumentExpiryLabel(d),
            expiryDate: d.expiryDate,
            isCertificate: String(d?.context || "").toLowerCase() === "certificate",
        });
    });
    if (emp?.contractExpiryDate) labels.push({ label: "Contract Expiry", expiryDate: emp.contractExpiryDate });
    const set = new Set();
    labels.forEach((x) => {
        const days = getDaysUntil(x.expiryDate);
        if (days == null || !isExpiryHrTaskDueForDoc(days, { isCertificate: x.isCertificate })) return;
        const exp = formatExpiryDateLabel(x.expiryDate);
        set.add(`Expiry follow-up required: ${x.label}${exp ? ` (Exp: ${exp})` : ""}`);
    });
    return set;
};

const EMPLOYEE_SYSTEM_EXPIRY_LABEL_RE =
    /(passport|visa|emirates\s*id|labour\s*card|medical\s*insurance|driving\s*license|contract\s*expiry|certificate\s*[—–-])/i;

const filterStaleExpiryDashboardRows = async (items = []) => {
    if (!Array.isArray(items) || items.length === 0) return items;
    try {
        const candidateCompanyIds = new Set();
        const candidateEmployeeIds = new Set();
        items.forEach((it) => {
            if (it?.requestType === "Document Expiry Reminder" && it?.requestId) {
                candidateCompanyIds.add(String(it.requestId));
            } else if (it?.requestType === "Employee Document Expiry Reminder" && it?.requestId) {
                candidateEmployeeIds.add(String(it.requestId));
            }
        });

        const [companies, employees] = await Promise.all([
            candidateCompanyIds.size
                ? loadCompaniesForExpiryScanByIds([...candidateCompanyIds])
                : [],
            candidateEmployeeIds.size
                ? EmployeeBasic.find({ _id: { $in: [...candidateEmployeeIds] } })
                      .select("_id documents contractExpiryDate")
                      .lean()
                      .maxTimeMS(6000)
                : [],
        ]);

        const companyLabelSetById = new Map(
            companies.map((c) => [String(c._id), buildCompanyLiveExpiryExtra1Set(c)]),
        );
        const employeeLabelSetById = new Map(
            employees.map((e) => [String(e._id), buildEmployeeLiveExpiryExtra1Set(e)]),
        );

        return items.filter((it) => {
            const extra1 = String(it?.extra1 || "").trim();
            if (!extra1.toLowerCase().startsWith("expiry follow-up required:")) return true;
            if (it?.requestType === "Document Expiry Reminder") {
                const set = companyLabelSetById.get(String(it.requestId || ""));
                if (!set) return true;
                return set.has(extra1);
            }
            if (it?.requestType === "Employee Document Expiry Reminder") {
                // Keep system-card reminders; filter stale manual document reminders against active manual docs.
                if (EMPLOYEE_SYSTEM_EXPIRY_LABEL_RE.test(extra1)) return true;
                const set = employeeLabelSetById.get(String(it.requestId || ""));
                if (!set) return true;
                return set.has(extra1);
            }
            return true;
        });
    } catch (err) {
        console.warn(
            "[getUserActivityStats] filterStaleExpiryDashboardRows skipped:",
            err?.message || err,
        );
        return items;
    }
};

/**
 * Drop stale Company Activation rows once HR review is finished.
 * Keep tasks while `activationStatus` is `submitted` (including reactivation on Active companies).
 */
const filterCompletedCompanyActivationItems = async (activityList = []) => {
    if (!Array.isArray(activityList) || activityList.length === 0) return activityList;

    const companyMongoIds = new Set();
    activityList.forEach((item) => {
        if (item?.type !== "Company Activation" || !item?.id) return;
        const idStr = String(item.id);
        if (mongoose.Types.ObjectId.isValid(idStr)) {
            companyMongoIds.add(idStr);
        }
    });
    if (!companyMongoIds.size) return activityList;

    const companies = await Company.find({ _id: { $in: [...companyMongoIds] } })
        .select("_id activationStatus")
        .lean()
        .maxTimeMS(6000);

    const awaitingHrById = new Set(
        companies
            .filter((c) => String(c.activationStatus || "").toLowerCase() === "submitted")
            .map((c) => String(c._id)),
    );

    return activityList.filter((item) => {
        if (item?.type !== "Company Activation") return true;
        const st = String(item.status || "").toLowerCase();
        if (st === "on hold" || st === "rejected") return true;
        return awaitingHrById.has(String(item.id));
    });
};

/**
 * Get Activity Stats for the Logged-in User (or a specific target user in their team)
 * aggregates data from Loans, Rewards, Fines, Profile Approvals, and Notices
 */
export const getUserActivityStats = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: "Unauthorized" });

        const isAdmin =
            ['Admin', 'CEO', 'Director', 'General Manager'].includes(currentUser.role) ||
            currentUser.isAdmin;

        let targetEmployeeId = currentUser.employeeId;
        let targetEmail = currentUser.companyEmail;

        // Tight projection for manager/target employee lookups — skip heavy doc arrays.
        const MANAGER_FIELDS = {
            _id: 1, employeeId: 1, companyEmail: 1, firstName: 1, lastName: 1,
            department: 1, designation: 1, company: 1, companyId: 1, primaryReportee: 1,
            profileApprovalStatus: 1, profileWorkflow: 1, profileSubmittedTo: 1,
            profileActivationHold: 1, noticeRequest: 1, createdAt: 1, updatedAt: 1,
        };

        // If a target user ID is provided (viewing as someone else)
        if (req.query.targetUserId) {
            const targetEmp = await EmployeeBasic.findById(req.query.targetUserId)
                .select({ employeeId: 1, companyEmail: 1 })
                .lean()
                .maxTimeMS(5000);
            if (targetEmp) {
                targetEmployeeId = targetEmp.employeeId;
                targetEmail = targetEmp.companyEmail;
            }
        }

        // 1. Get Manager's Employee Record (Target User or Current User)
        // If viewing someone else's dashboard, use their employee record
        // Otherwise, use the logged-in user's employee record
        let manager;

        if (req.query.targetUserId) {
            // Viewing someone else's dashboard - use their employee record
            manager = await EmployeeBasic.findById(req.query.targetUserId)
                .select(MANAGER_FIELDS)
                .lean()
                .maxTimeMS(5000);
            if (!manager) {
                console.warn(`[getUserActivityStats] No Employee record found for Target User ID: ${req.query.targetUserId}`);
                return res.status(200).json({ pending: 0, approved: 0, rejected: 0, total: 0, items: [] });
            }
        } else {
            // Viewing own dashboard - use logged-in user's employee record
            manager = await EmployeeBasic.findOne({
                $or: [
                    ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                    ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : [])
                ]
            }).select(MANAGER_FIELDS).lean().maxTimeMS(5000);
        }
        if (!manager) {
            if (!isAdmin) {
                console.warn(`[getUserActivityStats] No Employee record found for User: ${currentUser.email}`);
                return res.status(200).json({ pending: 0, approved: 0, rejected: 0, total: 0, items: [] });
            }
            // For Admins without Employee record, create a dummy manager object to avoid crashes
            manager = { _id: currentUser._id, employeeId: currentUser.employeeId || 'ADMIN', department: 'Administration', designation: 'Admin' };
        }

        let targetUser;
        if (!req.query.targetUserId) {
            targetUser = currentUser;
        } else {
            targetUser = await User.findOne({ employeeId: manager.employeeId })
                .select({ _id: 1, employeeId: 1, name: 1 })
                .lean()
                .maxTimeMS(5000);
            if (!targetUser) {
                console.warn(`[getUserActivityStats] No User record found for Target Employee ID: ${manager.employeeId}`);
                targetUser = { _id: manager._id, employeeId: manager.employeeId };
            }
        }

        // IDs that represent the user we are looking at
        let relevantIds = [];
        if (req.query.targetUserId) {
            relevantIds = [manager?._id, targetUser?._id].filter(Boolean);
        } else {
            relevantIds = [manager?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        }

        // Fetch Designated Responsibilities from Company
        const responsibleCompanies = await Company.find(
            { "responsibilities.empObjectId": { $in: relevantIds } },
            { responsibilities: 1 }
        ).lean().maxTimeMS(6000);

        let isDesignatedHR = false;
        let isDesignatedAccounts = false;
        let isDesignatedCEO = false;
        let isDesignatedAssetController = false;

        responsibleCompanies.forEach(c => {
            if (c.responsibilities) {
                c.responsibilities.forEach(r => {
                    if (relevantIds.some(id => id.toString() === r.empObjectId?.toString())) {
                        const cat = (r.category || '').toLowerCase();
                        if (cat.includes('hr') || cat.includes('human')) isDesignatedHR = true;
                        if (cat.includes('account') || cat.includes('finance')) isDesignatedAccounts = true;
                        if (cat.includes('management') || cat.includes('ceo')) isDesignatedCEO = true;
                        if (cat.includes('asset')) isDesignatedAssetController = true;
                    }
                });
            }
        });

        const dept = (manager.department || '').toLowerCase();
        const desig = (manager.designation || '').toLowerCase();

        const isCEO = isDesignatedCEO || ((dept.includes('management') || dept.includes('administration') || dept.includes('board of directors')) &&
            ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(desig));

        const isHR = isDesignatedHR || (dept.includes('hr') || dept.includes('human resource'));
        const isAccounts = isDesignatedAccounts || (dept.includes('finance') || dept.includes('account'));
        const isAssetController = isDesignatedAssetController;

        // 2. Find Reportees
        const reportees = await EmployeeBasic.find({ primaryReportee: manager._id })
            .select({ employeeId: 1 })
            .lean()
            .maxTimeMS(5000);
        const reporteeCustomIds = reportees.map(r => r.employeeId);

        // 3. Define Queries for "Needs Action"
        const DashboardAction = await import("../../models/DashboardAction.js").then(m => m.default);
        const { getDepartmentHOD } = await import("../../utils/getDepartmentHOD.js");
        const flowchartHrEmp = await getDepartmentHOD("hr");
        const flowchartAdminEmp = await getDepartmentHOD("admincontroller");

        const allAssetTypes = ['Asset', 'Asset Overdue', 'Asset Leave', 'Asset Approval', 'Asset Assignment', 'Asset Transfer', 'Asset Loss Damage', 'Asset End of Life', 'Asset Accessory', 'Asset Accessory Approval', 'Asset Accessory Unattach', 'Vehicle Service Request'];

        const normEmpForAssigneeEarly = (s) => (s || "").toString().trim().toLowerCase();
        const dashboardAssigneeMongoIds = [...relevantIds].filter(Boolean);
        if (flowchartHrEmp?._id) {
            const fid = flowchartHrEmp._id.toString();
            if (!dashboardAssigneeMongoIds.some((id) => id && id.toString() === fid)) {
                const sameBusinessIdAsFlowchartHr =
                    manager?.employeeId &&
                    flowchartHrEmp.employeeId &&
                    normEmpForAssigneeEarly(manager.employeeId) === normEmpForAssigneeEarly(flowchartHrEmp.employeeId);
                if (sameBusinessIdAsFlowchartHr) {
                    dashboardAssigneeMongoIds.push(flowchartHrEmp._id);
                }
            }
        }
        if (flowchartAdminEmp?._id) {
            const aid = flowchartAdminEmp._id.toString();
            if (!dashboardAssigneeMongoIds.some((id) => id && id.toString() === aid)) {
                const sameBusinessIdAsFlowchartAdmin =
                    manager?.employeeId &&
                    flowchartAdminEmp.employeeId &&
                    normEmpForAssigneeEarly(manager.employeeId) === normEmpForAssigneeEarly(flowchartAdminEmp.employeeId);
                if (sameBusinessIdAsFlowchartAdmin) {
                    dashboardAssigneeMongoIds.push(flowchartAdminEmp._id);
                }
            }
        }

        const dashboardOrConditions = [
            { assignedTo: { $in: dashboardAssigneeMongoIds } },
        ];
        if (currentUser?.employeeId && String(currentUser.employeeId).trim() !== '') {
            dashboardOrConditions.push({ assignedToEmpId: String(currentUser.employeeId).trim() });
        }
        if (targetEmployeeId && String(targetEmployeeId).trim() !== '') {
            dashboardOrConditions.push({ assignedToEmpId: targetEmployeeId });
        }
        if (isAdmin) {
            dashboardOrConditions.push({ requestType: 'Responsibility Approval' });
        }
        if (isAssetController) {
            dashboardOrConditions.push({ requestType: { $in: allAssetTypes } });
        }

        // Role-aware fallback so a freshly-appointed HR sees in-flight fleet Asset Approvals immediately
        // (without waiting for the boot/flowchart re-route to rewrite DashboardAction.assignedTo).
        const { isUserActiveInFlowchart, isUserInFlowchart } = await import("../../utils/getDepartmentHOD.js");
        const isCurrentHrHolder = await isUserActiveInFlowchart(currentUser, 'hr').catch(() => false);
        if (isCurrentHrHolder) {
            dashboardOrConditions.push({
                requestType: 'Asset Approval',
                extra3: { $regex: '"isFleetVehicle"\\s*:\\s*true', $options: 'i' },
            });
        }
        const isCurrentAcHolder = await isUserActiveInFlowchart(currentUser, 'assetcontroller').catch(() => false);
        if (isCurrentAcHolder) {
            dashboardOrConditions.push({
                requestType: 'Asset Approval',
                extra3: { $not: { $regex: '"isFleetVehicle"\\s*:\\s*true', $options: 'i' } },
            });
        }
        const isCurrentAccountsHolder = await isUserActiveInFlowchart(currentUser, 'accounts').catch(() => false);
        const isCurrentManagementHolder = await isUserInFlowchart(currentUser, 'management').catch(() => false);

        // Flowchart HR sees all in-flight company activations even if `assignedTo` still points at a prior HR holder.
        if (isCurrentHrHolder) {
            dashboardOrConditions.push({
                requestType: "Company Activation",
                status: "Pending",
            });
        }

        const dispositionRowVisibleToViewer = (item) => {
            if (item?.requestType !== 'Vehicle Disposition Request') return true;
            let meta = null;
            try {
                meta = typeof item.extra3 === 'string' ? JSON.parse(item.extra3) : item.extra3;
            } catch {
                meta = null;
            }
            const viewerRole = meta?.dispositionViewerRole;
            if (!viewerRole) return true;
            if (viewerRole === 'hr') return isCurrentHrHolder;
            if (viewerRole === 'accounts') return isCurrentAccountsHolder;
            if (viewerRole === 'management') return isCurrentManagementHolder;
            return false;
        };

        const ASSIGNMENT_STRICT_TYPES = new Set([
            'Document Expiry Reminder',
            'Employee Document Expiry Reminder',
            'Company Activation',
            'Company Document Not Renew',
            'Employee Document Not Renew',
            'Vehicle Profile Activation',
            'Vehicle Disposition Request',
        ]);
        const normEmpForAssignee = (s) => (s || '').toString().trim().toLowerCase();
        const dashboardRowAssignedToViewer = (item) => {
            const assigneeId = item?.assignedTo?.toString();
            if (!assigneeId) return false;
            if (dashboardAssigneeMongoIds.some((id) => id && id.toString() === assigneeId)) return true;
            if (
                targetEmployeeId &&
                item.assignedToEmpId &&
                normEmpForAssignee(item.assignedToEmpId) === normEmpForAssignee(targetEmployeeId)
            ) {
                return true;
            }
            return false;
        };

        const profileActivationOutcomeOr = [{ assignedTo: { $in: dashboardAssigneeMongoIds } }];
        if (targetEmployeeId && String(targetEmployeeId).trim() !== '') {
            // Outcome rows for the profile subject use assignedTo = subject's EmployeeBasic _id and assignedToEmpId = subject employeeId.
            // Also match by employeeId so the submitting employee sees On Hold / outcomes even if id resolution differs from HR's queue row.
            profileActivationOutcomeOr.push({ assignedToEmpId: String(targetEmployeeId).trim() });
        }

        const assetApprovalRejectedOr = [{ assignedTo: { $in: dashboardAssigneeMongoIds } }];
        if (targetEmployeeId && String(targetEmployeeId).trim() !== '') {
            assetApprovalRejectedOr.push({ assignedToEmpId: String(targetEmployeeId).trim() });
        }
        if (currentUser?.employeeId && String(currentUser.employeeId).trim() !== '') {
            const cid = String(currentUser.employeeId).trim();
            if (!assetApprovalRejectedOr.some((c) => c.assignedToEmpId === cid)) {
                assetApprovalRejectedOr.push({ assignedToEmpId: cid });
            }
        }

        const dashboardSettled = await Promise.allSettled([
            DashboardAction.find({
                $or: dashboardOrConditions,
                status: 'Pending',
            }).lean().maxTimeMS(6000),
            DashboardAction.find({
                requestType: 'Profile Activation',
                status: { $in: ['Approved', 'Rejected', 'On Hold'] },
                $or: profileActivationOutcomeOr,
            })
                .sort({ actionedDate: -1, updatedAt: -1 })
                .limit(25)
                .lean()
                .maxTimeMS(6000),
            DashboardAction.find({
                requestType: 'Company Activation',
                status: { $in: ['Approved', 'Rejected', 'On Hold'] },
                $or: profileActivationOutcomeOr,
            })
                .sort({ actionedDate: -1, updatedAt: -1 })
                .limit(25)
                .lean()
                .maxTimeMS(6000),
            DashboardAction.find({
                requestType: 'Vehicle Profile Activation',
                status: { $in: ['Approved', 'Rejected', 'On Hold'] },
                $or: profileActivationOutcomeOr,
            })
                .sort({ actionedDate: -1, updatedAt: -1 })
                .limit(25)
                .lean()
                .maxTimeMS(6000),
            DashboardAction.find({
                requestType: 'Asset Approval',
                status: 'Rejected',
                $or: assetApprovalRejectedOr,
            })
                .sort({ actionedDate: -1, updatedAt: -1 })
                .limit(25)
                .lean()
                .maxTimeMS(6000),
        ]);
        dashboardSettled.forEach((r, i) => {
            if (r.status === "rejected") {
                console.warn(`[getUserActivityStats] dashboard slot ${i} failed:`, r.reason?.message || r.reason);
            }
        });
        const [
            dashboardPendingItemsRaw,
            profileActivationOutcomeItems,
            companyActivationOutcomeItems,
            vehicleProfileActivationOutcomeItems,
            assetCreationOutcomeItems,
        ] = dashboardSettled.map((r) => (r.status === "fulfilled" ? r.value : []));

        const dashboardPendingItems = await filterStaleExpiryDashboardRows(
            dedupeOwnerLinkedDocumentExpiryReminders(
            dashboardPendingItemsRaw.filter((item) => {
                if (!dispositionRowVisibleToViewer(item)) return false;
                if (!ASSIGNMENT_STRICT_TYPES.has(item.requestType)) return true;
                return dashboardRowAssignedToViewer(item);
            })
            )
        );

        // 4. Fallback/Direct Queries for "Needs Action" (in case DashboardAction sync is delayed)
        // Keep projections tight: avoid pulling heavy EmployeeBasic fields (documents, oldDocuments,
        // pendingReactivationChanges, etc.) which were causing socket timeouts on free-tier Atlas.
        const PENDING_PROFILE_FIELDS = {
            _id: 1, employeeId: 1, firstName: 1, lastName: 1, designation: 1,
            createdAt: 1, updatedAt: 1, profileApprovalStatus: 1,
        };
        const NOTICE_FIELDS = {
            _id: 1, employeeId: 1, firstName: 1, lastName: 1, noticeRequest: 1, updatedAt: 1,
        };
        const inboxQueries = [
            // Pending Profiles
            EmployeeBasic.find({
                $or: [
                    {
                        profileSubmittedTo: { $in: relevantIds },
                        profileApprovalStatus: 'submitted',
                        'profileActivationHold.heldAt': { $exists: false },
                    },
                    ...(isAdmin
                        ? [
                              {
                                  profileApprovalStatus: 'submitted',
                                  'profileActivationHold.heldAt': { $exists: false },
                              },
                          ]
                        : []),
                ],
            }).select(PENDING_PROFILE_FIELDS).lean().maxTimeMS(6000),
            // Pending Notices
            EmployeeBasic.find({
                "noticeRequest.requestedAt": { $exists: true },
                $or: [
                    { 'noticeRequest.submittedTo': { $in: relevantIds }, 'noticeRequest.status': 'Pending' },
                    ...(isAdmin ? [{ 'noticeRequest.status': 'Pending' }] : []),
                    { 'noticeRequest.submittedTo': null, primaryReportee: manager._id, 'noticeRequest.status': 'Pending' }
                ]
            }).select(NOTICE_FIELDS).lean().maxTimeMS(6000),
            // Pending Loans
            Loan.find({
                $or: [
                    { submittedTo: { $in: relevantIds }, status: 'Pending' },
                    { submittedTo: null, employeeObjectId: { $in: relevantIds }, status: 'Pending' },
                    ...(isHR ? [{ approvalStatus: 'Pending HR', status: 'Pending' }] : []),
                    ...(isAccounts ? [{ approvalStatus: 'Pending Accounts', status: 'Pending' }] : []),
                    ...(isCEO ? [{ approvalStatus: 'Pending Authorization', status: 'Pending' }] : []),
                    ...(isAdmin ? [{ status: 'Pending' }] : [])
                ]
            }).populate('createdBy', 'name').lean().maxTimeMS(6000),
            // Pending Rewards
            Reward.find({
                $or: [
                    { submittedTo: { $in: relevantIds }, rewardStatus: { $in: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] } },
                    ...(isHR ? [{ rewardStatus: 'Pending HR' }] : []),
                    ...(isAccounts ? [{ rewardStatus: 'Pending Accounts' }] : []),
                    ...(isCEO ? [{ rewardStatus: 'Pending Authorization' }] : []),
                    ...(isAdmin ? [{ rewardStatus: 'Pending' }] : []),
                    { submittedTo: null, employeeId: targetEmployeeId, rewardStatus: 'Pending' }
                ]
            }).populate('createdBy', 'name').lean().maxTimeMS(6000),
            // Pending Fines
            Fine.find({
                $or: [
                    { submittedTo: { $in: relevantIds }, fineStatus: { $in: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] } },
                    ...(isHR ? [{ fineStatus: 'Pending HR' }] : []),
                    ...(isAccounts ? [{ fineStatus: 'Pending Accounts' }] : []),
                    ...(isCEO ? [{ fineStatus: 'Pending Authorization' }] : []),
                    ...(isAdmin ? [{ fineStatus: { $in: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization'] } }] : [])
                ]
            }).populate('createdBy', 'name').lean().maxTimeMS(6000)
        ];

        // Queries for "MY OWN REQUESTS"
        const outgoingQueries = [
            Loan.find({ $or: [{ employeeId: targetEmployeeId }, { createdBy: targetUser?._id }] })
                .populate('createdBy', 'name')
                .sort({ createdAt: -1 }).limit(15).lean().maxTimeMS(6000),
            Reward.find({ $or: [{ employeeId: targetEmployeeId }, { createdBy: targetUser?._id }] })
                .populate('createdBy', 'name')
                .sort({ createdAt: -1 }).limit(15).lean().maxTimeMS(6000),
            Fine.find({ $or: [{ "assignedEmployees.employeeId": targetEmployeeId }, { createdBy: targetUser?._id }] })
                .populate('createdBy', 'name')
                .sort({ createdAt: -1 }).limit(15).lean().maxTimeMS(6000),
            // Outgoing Assets (Assigned by me) — static model import avoids extra async hop during parallel reads.
            AssetItem.find({
                $or: [
                    { assignedBy: { $in: relevantIds } },
                    { createdBy: currentUser?._id },
                    { "pendingActionDetails.requestedBy": { $in: relevantIds } },
                ],
            })
                .sort({ createdAt: -1 })
                .limit(15)
                .lean()
                .maxTimeMS(6000),
        ];

        // Use allSettled so one slow/failed read (flaky Atlas node) does not
        // wipe out the entire dashboard. Fallback to empty array per slot.
        const settledInboxOutgoing = await Promise.allSettled([...inboxQueries, ...outgoingQueries]);
        settledInboxOutgoing.forEach((r, i) => {
            if (r.status === "rejected") {
                console.warn(`[getUserActivityStats] inbox/outgoing slot ${i} failed:`, r.reason?.message || r.reason);
            }
        });
        const settledValues = settledInboxOutgoing.map((r) => (r.status === "fulfilled" ? r.value : []));
        const [
            pendingProfiles, pendingNotices, pendingLoans, pendingRewards, pendingFines,
            myLoans, myRewards, myFines, myAssignedAssets
        ] = settledValues;

        const requestIdsForProfileDashLookup = new Set(pendingProfiles.map((p) => String(p._id)));
        if (manager?._id && manager.profileApprovalStatus === "submitted" && !req.query.targetUserId) {
            requestIdsForProfileDashLookup.add(String(manager._id));
        }

        let profileActivationDeletableActionIdByRequestId = new Map();
        if (requestIdsForProfileDashLookup.size > 0) {
            const oidList = [...requestIdsForProfileDashLookup]
                .filter((id) => mongoose.Types.ObjectId.isValid(id))
                .map((id) => new mongoose.Types.ObjectId(id));
            if (oidList.length > 0) {
                const paRows = await DashboardAction.find({
                    requestType: "Profile Activation",
                    status: { $in: ["Pending", "On Hold"] },
                    requestId: { $in: oidList },
                })
                    .select("_id requestId assignedTo")
                    .lean()
                    .maxTimeMS(5000);
                for (const r of paRows) {
                    const rid = r.requestId?.toString();
                    if (!rid) continue;
                    const assigneeOk = relevantIds.some(
                        (id) => id && r.assignedTo && id.toString() === r.assignedTo.toString(),
                    );
                    if (assigneeOk && !profileActivationDeletableActionIdByRequestId.has(rid)) {
                        profileActivationDeletableActionIdByRequestId.set(rid, r._id.toString());
                    }
                }
            }
        }

        // 5. Build Unified Activity List for "Pending" (Using DashboardAction)
        const activityList = [];
        const seenRequests = new Map(); // requestId -> status to track and deduplicate

        const normEmpId = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const targetEmpNorm = normEmpId(targetEmployeeId);

        dashboardPendingItems.forEach(item => {
            const reqIdStr = item.requestId?.toString();
            const viewerName = `${manager?.firstName || ''} ${manager?.lastName || ''}`.trim() || currentUser.name || currentUser.employeeId || '';

            // For Fines, try to use fineId for cleaner URLs
            let displayId = reqIdStr;
            if (item.requestType === 'Fine' || item.requestType === 'Group Fine Request') {
                const fine = pendingFines.find(f => f._id.toString() === reqIdStr);
                if (fine) displayId = fine.fineId;
            }

            // Scope correction:
            // - Asset creation approval is an "outgoing" request for the creator (subject employee)
            // - It remains "inbox" for assigned approvers (asset controller/admin)
            const isCreatorSideAssetApproval =
                item.requestType === 'Asset Approval' &&
                targetEmpNorm &&
                normEmpId(item.subjectEmployeeId) === targetEmpNorm;

            // Company activation: HR/approver row must stay "inbox" (To Action). Only the submitter's copy is "outgoing".
            let companyActivationViewerRole = null;
            if (item.requestType === 'Company Activation' && item.extra3) {
                try {
                    companyActivationViewerRole = JSON.parse(item.extra3).companyActivationViewerRole || null;
                } catch {
                    companyActivationViewerRole = null;
                }
            }
            let vehicleActivationViewerRole = null;
            if (item.requestType === 'Vehicle Profile Activation' && item.extra3) {
                try {
                    vehicleActivationViewerRole = JSON.parse(item.extra3).activationViewerRole || null;
                } catch {
                    vehicleActivationViewerRole = null;
                }
            }
            const isCompanyActivationRequesterCopy =
                item.requestType === 'Company Activation' &&
                companyActivationViewerRole === 'requester';

            // Submitter is notified only after HR acts (hold / reject), not at submit time.
            if (
                isCompanyActivationRequesterCopy &&
                String(item.status || '').toLowerCase() === 'pending'
            ) {
                return;
            }

            const isVehicleActivationRequesterCopy =
                item.requestType === 'Vehicle Profile Activation' &&
                vehicleActivationViewerRole === 'requester';

            let assetCreationViewerRole = null;
            if (item.requestType === 'Asset Approval' && item.extra3) {
                try {
                    assetCreationViewerRole = JSON.parse(item.extra3).assetCreationViewerRole || null;
                } catch {
                    assetCreationViewerRole = null;
                }
            }
            const isAssetCreationCreatorCopy =
                item.requestType === 'Asset Approval' &&
                assetCreationViewerRole === 'creator';

            const assignedToViewer = dashboardRowAssignedToViewer(item);
            const scope =
                assignedToViewer ||
                isCompanyActivationRequesterCopy ||
                item.requestType === 'Company Document Not Renew' ||
                item.requestType === 'Employee Document Not Renew'
                    ? 'inbox'
                    : isCreatorSideAssetApproval || isVehicleActivationRequesterCopy || isAssetCreationCreatorCopy
                      ? 'outgoing'
                      : 'inbox';

            activityList.push({
                id: displayId,
                actionId: item._id.toString(),
                type: item.requestType,
                requestedBy: item.requestedByName || item.subjectName || 'Unknown',
                requestedDate: item.requestedDate,
                actionedDate: null,
                status: 'Pending',
                extra1: item.extra1,
                extra2: item.extra2,
                extra3: item.extra3,
                targetEmployeeId: item.subjectEmployeeId?.toString(),
                scope,
            });
            if (reqIdStr) seenRequests.set(reqIdStr, 'Pending');
        });

        // Fallback when activation was submitted but DashboardAction sync is missing or assignee drifted.
        const submittedCompanies = await Company.find({ activationStatus: { $in: ["submitted", "hold"] } })
            .select("_id name companyId nickName activationSubmittedTo activationSubmittedBy activationStatus updatedAt")
            .lean()
            .maxTimeMS(6000);

        const companyIdsForWorkflows = submittedCompanies.map((c) => c._id);
        const companyWorkflows = companyIdsForWorkflows.length
            ? await CompanyWorkflow.find({ company: { $in: companyIdsForWorkflows } })
                  .select("company activationHold")
                  .lean()
                  .maxTimeMS(5000)
            : [];
        const holdMap = new Map(
            companyWorkflows.map((w) => [String(w.company), w.activationHold]),
        );

        submittedCompanies.forEach((co) => {
            const reqIdStr = String(co._id);
            if (seenRequests.has(reqIdStr)) return;

            const hold = holdMap.get(reqIdStr);
            const isOnHold =
                String(co.activationStatus || "").toLowerCase() === "hold" || Boolean(hold?.heldAt);

            const submittedToHr = co.activationSubmittedTo?.toString();
            const submittedBy = co.activationSubmittedBy?.toString();
            const isHrInbox =
                isCurrentHrHolder ||
                (submittedToHr &&
                    dashboardAssigneeMongoIds.some((id) => id && id.toString() === submittedToHr));
            const isSubmitterOutgoing =
                submittedBy &&
                dashboardAssigneeMongoIds.some((id) => id && id.toString() === submittedBy);

            if (isOnHold) {
                if (isSubmitterOutgoing) {
                    activityList.push({
                        id: reqIdStr,
                        type: "Company Activation",
                        requestedBy: co.name || "Company",
                        requestedDate: co.updatedAt || new Date(),
                        actionedDate: null,
                        status: "On Hold",
                        extra1: `[Company profile] Activation request placed on hold by HR`,
                        extra2: co.companyId || "",
                        extra3: JSON.stringify({
                            companyActivationViewerRole: "submitter",
                            activationSubject: "company",
                        }),
                        targetEmployeeId: co.companyId,
                        scope: "inbox",
                    });
                    seenRequests.set(reqIdStr, "On Hold");
                }
                return;
            }

            if (!isHrInbox) return;

            activityList.push({
                id: reqIdStr,
                type: "Company Activation",
                requestedBy: co.name || "Company",
                requestedDate: co.updatedAt || new Date(),
                actionedDate: null,
                status: "Pending",
                extra1: `[Company profile] Company submitted for activation review`,
                extra2: co.companyId || "",
                extra3: JSON.stringify({
                    companyActivationViewerRole: "approver",
                    activationSubject: "company",
                }),
                targetEmployeeId: co.companyId,
                scope: "inbox",
            });
            seenRequests.set(reqIdStr, "Pending");
        });

        // 5.1 Add Direct Inbox Items (De-duplicate with DashboardAction)
        pendingProfiles.forEach(p => {
            const reqIdStr = p._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                activityList.push({
                    id: p._id.toString(), type: 'Profile Activation', requestedBy: `${p.firstName} ${p.lastName}`,
                    requestedDate: p.createdAt, actionedDate: null, status: 'Pending',
                    extra1: p.employeeId, extra2: p.designation, targetEmployeeId: p.employeeId,
                    scope: 'inbox',
                    actionId: profileActivationDeletableActionIdByRequestId.get(reqIdStr) || undefined,
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        pendingNotices.forEach(p => {
            const reqIdStr = p._id.toString() + "_notice";
            if (!seenRequests.has(reqIdStr)) {
                activityList.push({
                    id: p._id, type: 'Notice Request', requestedBy: `${p.firstName} ${p.lastName}`,
                    requestedDate: p.noticeRequest.requestedAt, actionedDate: null, status: 'Pending',
                    extra1: p.noticeRequest.reason, extra2: p.noticeRequest.duration, targetEmployeeId: p.employeeId,
                    isNotice: true, scope: 'inbox'
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        pendingLoans.forEach(l => {
            const reqIdStr = l._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                activityList.push({
                    id: l._id.toString(), type: l.type || 'Loan/Advance', requestedBy: l.createdBy?.name || l.employeeName || 'Employee',
                    requestedDate: l.createdAt, actionedDate: null, status: 'Pending',
                    extra1: `AED ${l.amount}`, extra2: `${l.duration} Months`, targetEmployeeId: l.employeeId,
                    scope: 'inbox'
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        pendingRewards.forEach(r => {
            const reqIdStr = r._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                activityList.push({
                    id: r._id.toString(), type: 'Reward', requestedBy: r.createdBy?.name || r.employeeName,
                    requestedDate: r.createdAt, actionedDate: null, status: 'Pending',
                    extra1: r.rewardType, extra2: `AED ${r.amount}`, targetEmployeeId: r.employeeId,
                    scope: 'inbox'
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        // Helper to fetch Company info ONLY for filtered fines to avoid N+1 issues
        const fineEmpIds = new Set();
        pendingFines.forEach(f => {
            if (f.assignedEmployees) f.assignedEmployees.forEach(ae => fineEmpIds.add(ae.employeeId));
        });

        // Batch fetch employee company details
        const fineEmployees = await EmployeeBasic.find(
            { employeeId: { $in: Array.from(fineEmpIds) } },
            { employeeId: 1, company: 1, companyId: 1 }
        ).lean().maxTimeMS(5000);
        const empCompanyMap = {};
        const uniqueCompanyIds = new Set();

        fineEmployees.forEach(e => {
            const cId = e.companyId || (e.company && e.company.toString()) || e.company;
            if (cId) {
                empCompanyMap[e.employeeId] = cId;
                uniqueCompanyIds.add(cId.toString());
            }
        });

        // Fetch Company Responsibilities
        const involvedCompanies = await Company.find(
            { _id: { $in: Array.from(uniqueCompanyIds) } },
            { responsibilities: 1 }
        ).lean().maxTimeMS(5000);
        const companyRespMap = {};
        involvedCompanies.forEach(c => {
            companyRespMap[c._id.toString()] = c.responsibilities || [];
        });

        // Get Current Manager's Company
        const myCompanyId = manager.companyId || (manager.company && manager.company.toString()) || manager.company;

        pendingFines.forEach(f => {
            const reqIdStr = f._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                let isVisible = false;

                // 1. Direct Assignment (Standard)
                if (f.submittedTo && relevantIds.some(id => id.toString() === f.submittedTo.toString())) {
                    isVisible = true;
                }
                // 2. Role-based Visibility (Company Scoped & Designated)
                else {
                    const fEmpIds = f.assignedEmployees?.map(e => e.employeeId) || [];

                    // Identify the company this fine belongs to
                    let targetCompanyId = null;
                    const belongsToMyCompany = fEmpIds.some(eid => {
                        const cId = empCompanyMap[eid];
                        if (cId) targetCompanyId = cId;
                        return cId && myCompanyId && cId.toString() === myCompanyId.toString();
                    });

                    // Check Designated Responsibilities
                    let isDesignatedHR = false;
                    let isDesignatedAccounts = false;

                    if (targetCompanyId) {
                        const resps = companyRespMap[targetCompanyId.toString()] || [];
                        isDesignatedHR = resps.some(r =>
                            (r.category === 'hr' || r.category === 'human resource') &&
                            relevantIds.some(id => id.toString() === (r.empObjectId?.toString() || r.employeeObjectId?.toString()))
                        );
                        isDesignatedAccounts = resps.some(r =>
                            (r.category === 'accounts' || r.category === 'finance') &&
                            relevantIds.some(id => id.toString() === (r.empObjectId?.toString() || r.employeeObjectId?.toString()))
                        );
                    }

                    if (targetCompanyId) {
                        if (f.fineStatus === 'Pending HR') {
                            if (isDesignatedHR) isVisible = true;
                            else if ((belongsToMyCompany || isAdmin) && isHR) isVisible = true;
                        }
                        if (f.fineStatus === 'Pending Accounts') {
                            if (isDesignatedAccounts) isVisible = true;
                            else if ((belongsToMyCompany || isAdmin) && isAccounts) isVisible = true;
                        }
                        if (f.fineStatus === 'Pending Authorization') {
                            if ((belongsToMyCompany || isAdmin) && isCEO) isVisible = true;
                        }
                    }
                }

                if (isVisible) {
                    activityList.push({
                        id: f.fineId, type: 'Fine', requestedBy: f.createdBy?.name || f.assignedEmployees?.[0]?.employeeName || 'Employee',
                        requestedDate: f.createdAt, actionedDate: null, status: 'Pending',
                        extra1: f.category, extra2: `AED ${f.fineAmount}`,
                        targetEmployeeId: f.assignedEmployees?.[0]?.employeeId || targetCompanyId,
                        scope: 'inbox'
                    });
                    seenRequests.set(reqIdStr, 'Pending');
                }
            }
        });

        // 5.1.5 Incomplete Profile Notifications for HR/Admin
        if (isHR || isAdmin) {
            try {
                const employeesForScan = await EmployeeBasic.find({})
                    .select({
                        employeeId: 1, firstName: 1, lastName: 1, status: 1, nationality: 1, country: 1,
                        email: 1, workEmail: 1, companyEmail: 1, contactNumber: 1, dateOfBirth: 1,
                        maritalStatus: 1, fathersName: 1, gender: 1, profilePicture: 1, profilePic: 1, avatar: 1,
                        numberOfDependents: 1, probationPeriod: 1, passportDetails: 1, visaDetails: 1,
                        emiratesIdDetails: 1, labourCardDetails: 1, salaryHistory: 1, salaryMonth: 1, basic: 1,
                        bankName: 1, bank: 1, accountName: 1, bankAccountName: 1, accountNumber: 1, bankAccountNumber: 1,
                        ibanNumber: 1, emergencyContacts: 1, emergencyContactName: 1, emergencyContactNumber: 1,
                        company: 1, dateOfJoining: 1, contractJoiningDate: 1, department: 1, designation: 1,
                        primaryReportee: 1, signature: 1, updatedAt: 1, createdAt: 1
                    })
                    .lean()
                    .maxTimeMS(10000);

                for (const emp of employeesForScan) {
                    const { percentage, pendingFields } = calculateProfileCompletionBackend(emp);
                    if (percentage < 100) {
                        const sections = [...new Set(pendingFields.map(f => f.section))];
                        sections.forEach(sec => {
                            const sectionSlug = sec.toLowerCase().replace(/\s+/g, '-');
                            const notifId = `${emp._id}_incomplete_${sectionSlug}`;
                            if (!seenRequests.has(notifId)) {
                                activityList.push({
                                    id: notifId,
                                    type: 'Profile Incomplete',
                                    requestedBy: `${emp.firstName || ''} ${emp.lastName || ''}`.trim() || emp.employeeId || 'Unknown Employee',
                                    requestedDate: emp.updatedAt || emp.createdAt || new Date(),
                                    actionedDate: null,
                                    status: 'Pending',
                                    extra1: sec,
                                    extra2: `${percentage}% complete`,
                                    extra3: JSON.stringify({
                                        pendingFields: pendingFields.filter(f => f.section === sec).map(f => f.field)
                                    }),
                                    targetEmployeeId: emp.employeeId,
                                    scope: 'inbox'
                                });
                                seenRequests.set(notifId, 'Pending');
                            }
                        });
                    }
                }
            } catch (err) {
                console.error('[getUserActivityStats] Incomplete profile scan error:', err);
            }
        }

        // 5.2 Add "My Own Requests" to Activity List
        myLoans.forEach(l => {
            const reqIdStr = l._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                const isCreatedByMe = l.createdBy && (l.createdBy._id || l.createdBy).toString() === currentUser._id.toString();
                const creatorName = (l.createdBy && l.createdBy.name) ? l.createdBy.name : 'System';

                activityList.push({
                    id: l._id, type: l.type || 'Loan/Advance', requestedBy: isCreatedByMe ? 'Me' : creatorName,
                    requestedDate: l.createdAt,
                    actionedDate: l.approvedDate || (l.status !== 'Pending' ? l.updatedAt : null),
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Draft'].includes(l.status) ? 'Pending' : l.status,
                    extra1: `AED ${l.amount}`, extra2: `${l.duration} Months`,
                    targetEmployeeId: l.employeeId,
                    employeeId: targetEmployeeId,
                    scope: 'outgoing'
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        myRewards.forEach(r => {
            const reqIdStr = r._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                const isCreatedByMe = r.createdBy && (r.createdBy._id || r.createdBy).toString() === currentUser._id.toString();
                const creatorName = (r.createdBy && r.createdBy.name) ? r.createdBy.name : 'System';

                activityList.push({
                    id: r._id, type: 'Reward', requestedBy: isCreatedByMe ? 'Me' : creatorName,
                    requestedDate: r.createdAt,
                    actionedDate: r.approvedDate || (['Approved', 'Rejected', 'Cancelled'].includes(r.rewardStatus) ? r.updatedAt : null),
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Draft'].includes(r.rewardStatus) ? 'Pending' : r.rewardStatus,
                    extra1: r.rewardType, extra2: `AED ${r.amount || 0}`,
                    targetEmployeeId: r.employeeId,
                    employeeId: targetEmployeeId,
                    scope: 'outgoing'
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        myFines.forEach(f => {
            const reqIdStr = f._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                const isCreatedByMe = f.createdBy && (f.createdBy._id || f.createdBy).toString() === currentUser._id.toString();
                const creatorName = (f.createdBy && f.createdBy.name) ? f.createdBy.name : 'System';

                activityList.push({
                    id: f.fineId, type: 'Fine', requestedBy: isCreatedByMe ? 'Me' : creatorName,
                    requestedDate: f.createdAt,
                    actionedDate: ['Approved', 'Rejected', 'Completed'].includes(f.fineStatus) ? f.updatedAt : null,
                    status: ['Pending', 'Pending HR', 'Pending Accounts', 'Pending Authorization', 'Draft'].includes(f.fineStatus) ? 'Pending' : f.fineStatus,
                    extra1: f.category, extra2: `AED ${f.fineAmount}`,
                    targetEmployeeId: targetEmployeeId,
                    employeeId: targetEmployeeId,
                    scope: 'outgoing'
                });
                seenRequests.set(reqIdStr, 'Pending');
            }
        });

        // 5.2.1 Add "My Assigned Assets" (Assigned by me)
        (myAssignedAssets || []).forEach(asset => {
            const reqIdStr = asset._id.toString();
            if (!seenRequests.has(reqIdStr)) {
                activityList.push({
                    id: asset._id.toString(),
                    type: 'Asset',
                    requestedBy: 'Me',
                    requestedDate: asset.createdAt,
                    actionedDate: asset.acceptanceStatus !== 'Pending' ? asset.updatedAt : null,
                    status: asset.acceptanceStatus === 'Pending' ? 'Pending' : asset.acceptanceStatus,
                    extra1: `${asset.assetId} - ${asset.name}`,
                    extra2: asset.assignmentType,
                    targetEmployeeId: asset.assignedTo?.toString(),
                    scope: 'outgoing'
                });
                seenRequests.set(reqIdStr, asset.acceptanceStatus);
            }
        });

        // 5c. Add "My Profile/Notice Requests"
        if (manager) {
            // Profile Activation Request
            if (manager.profileApprovalStatus && manager.profileApprovalStatus !== 'draft') {
                const p = manager;
                const reqIdStr = p._id.toString();
                if (!seenRequests.has(reqIdStr)) {
                    const latestStep = p.profileWorkflow && p.profileWorkflow.length > 0
                        ? p.profileWorkflow[p.profileWorkflow.length - 1]
                        : null;

                    const status = manager.profileApprovalStatus === 'active' ? 'Approved' :
                        manager.profileApprovalStatus === 'rejected' ? 'Rejected' : 'Pending';

                    activityList.push({
                        id: p._id, type: 'Profile Activation', requestedBy: 'Me',
                        requestedDate: latestStep ? latestStep.assignedAt : (p.createdAt || p.updatedAt),
                        actionedDate: (status === 'Approved' || status === 'Rejected') ? (latestStep?.actionedAt || p.updatedAt) : null,
                        status: status,
                        extra1: p.employeeId, extra2: p.designation,
                        targetEmployeeId: p.employeeId,
                        employeeId: p.employeeId,
                        scope: 'outgoing',
                        actionId: profileActivationDeletableActionIdByRequestId.get(reqIdStr) || undefined,
                    });
                    seenRequests.set(reqIdStr, status);
                }
            }

            // Notice/Termination Request
            if (manager.noticeRequest && manager.noticeRequest.requestedAt) {
                const n = manager.noticeRequest;
                const reqIdStr = manager._id.toString() + "_notice"; // Use suffix since it uses same record ID
                if (!seenRequests.has(reqIdStr)) {
                    const status = ['Approved', 'Rejected'].includes(n.status) ? n.status : 'Pending';

                    activityList.push({
                        id: manager._id, type: 'Notice Request', requestedBy: 'Me',
                        requestedDate: n.requestedAt,
                        actionedDate: status !== 'Pending' ? n.actionedAt : null,
                        status: status,
                        extra1: n.reason, extra2: n.duration,
                        targetEmployeeId: manager.employeeId,
                        employeeId: manager.employeeId,
                        isNotice: true, // Helper for frontend
                        scope: 'outgoing'
                    });
                    seenRequests.set(reqIdStr, status);
                }
            }
        }

        // 5b. Profile activation outcomes assigned to this user (e.g. employee notified after HR approve/reject)
        profileActivationOutcomeItems.forEach((item) => {
            const reqIdStr = item.requestId?.toString();
            if (!reqIdStr) return;
            /** Outcome rows (On Hold / Approved / Rejected) are assigned to the activation submitter — not always the profile subject. */
            const isProfileActAssignee =
                dashboardAssigneeMongoIds.some(
                    (id) => id && item.assignedTo && id.toString() === item.assignedTo.toString(),
                ) ||
                (targetEmployeeId &&
                    item.assignedToEmpId &&
                    normEmpForAssignee(item.assignedToEmpId) === normEmpForAssignee(targetEmployeeId));
            const activityItem = {
                id: reqIdStr,
                actionId: item._id.toString(),
                type: 'Profile Activation',
                requestedBy: isProfileActAssignee ? 'Me' : item.subjectName || item.requestedByName || 'Employee',
                requestedDate: item.requestedDate,
                actionedDate: item.actionedDate || item.updatedAt,
                status: item.status,
                extra1: item.extra1 || item.subjectEmployeeId,
                extra2: item.extra2,
                extra3: item.extra3,
                targetEmployeeId: item.subjectEmployeeId?.toString(),
                employeeId: targetEmployeeId,
                scope: isProfileActAssignee ? 'inbox' : 'inbox',
            };

            const idx = activityList.findIndex((i) => {
                if (i.id?.toString() !== reqIdStr || i.type !== 'Profile Activation' || i.isNotice) return false;
                if (
                    activityItem.actionId &&
                    i.actionId &&
                    String(i.actionId) === String(activityItem.actionId)
                ) {
                    return true;
                }
                if (isProfileActAssignee) {
                    return i.scope === 'outgoing' || i.scope === 'inbox';
                }
                if (!isProfileActAssignee && i.scope !== 'outgoing') return true;
                return false;
            });
            if (idx !== -1) {
                const existing = activityList[idx];
                if (
                    item.status === 'On Hold' &&
                    isProfileActAssignee &&
                    existing.status === 'Pending' &&
                    existing.requestedBy === 'Me'
                ) {
                    activityList[idx] = { ...existing, ...activityItem };
                    return;
                }
                // If dashboard still had Pending but DashboardAction is already Approved/Rejected, prefer the outcome row
                // so the notification list and counts drop the finished task after HR action.
                // Do not replace a live Pending row with a *different* historical outcome document (same requestId, new cycle).
                if (existing.status === 'Pending' && ['Approved', 'Rejected'].includes(activityItem.status)) {
                    if (
                        existing.actionId &&
                        activityItem.actionId &&
                        String(existing.actionId) !== String(activityItem.actionId)
                    ) {
                        if (isProfileActAssignee && activityItem.scope === 'outgoing') {
                            activityList.push(activityItem);
                            seenRequests.set(reqIdStr, activityItem.status);
                        }
                        return;
                    }
                    activityList[idx] = { ...existing, ...activityItem };
                    seenRequests.set(reqIdStr, activityItem.status);
                    return;
                }
                activityList[idx] = { ...existing, ...activityItem };
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, item.status);
            }
        });

        companyActivationOutcomeItems.forEach((item) => {
            const reqIdStr = item.requestId?.toString();
            if (!reqIdStr) return;
            const isCompanyActSelf =
                dashboardAssigneeMongoIds.some(
                    (id) => id && item.assignedTo && id.toString() === item.assignedTo.toString(),
                ) ||
                (targetEmployeeId &&
                    item.assignedToEmpId &&
                    normEmpForAssignee(item.assignedToEmpId) === normEmpForAssignee(targetEmployeeId));
            const activityItem = {
                id: reqIdStr,
                actionId: item._id.toString(),
                type: 'Company Activation',
                requestedBy: isCompanyActSelf ? 'Me' : item.subjectName || item.requestedByName || 'Company',
                requestedDate: item.requestedDate,
                actionedDate: item.actionedDate || item.updatedAt,
                status: item.status,
                extra1: item.extra1 || item.subjectEmployeeId,
                extra2: item.extra2,
                extra3: item.extra3,
                targetEmployeeId: item.extra2 || item.subjectEmployeeId?.toString(),
                employeeId: targetEmployeeId,
                scope: isCompanyActSelf ? 'inbox' : 'inbox',
            };

            const idx = activityList.findIndex((i) => {
                if (i.id?.toString() !== reqIdStr || i.type !== 'Company Activation') return false;
                if (
                    activityItem.actionId &&
                    i.actionId &&
                    String(i.actionId) === String(activityItem.actionId)
                ) {
                    return true;
                }
                if (isCompanyActSelf) {
                    return i.scope === 'outgoing' || i.scope === 'inbox';
                }
                if (!isCompanyActSelf && i.scope !== 'outgoing') return true;
                return false;
            });
            if (idx !== -1) {
                const existing = activityList[idx];
                if (item.status === 'On Hold' && isCompanyActSelf && existing.status === 'Pending') {
                    // After resubmit, `clearCompanyActivationHoldDashboardRows` removes hold rows; if one remains
                    // or the list still has an older On Hold document, prefer the fresh Pending (newer requestedDate).
                    const pendingTs = new Date(existing.requestedDate || 0).getTime();
                    const holdTs = new Date(
                        item.actionedDate || item.updatedAt || item.requestedDate || 0,
                    ).getTime();
                    if (pendingTs >= holdTs) return;
                    activityList[idx] = { ...existing, ...activityItem };
                    return;
                }
                if (existing.status === 'Pending' && ['Approved', 'Rejected'].includes(activityItem.status)) {
                    if (
                        existing.actionId &&
                        activityItem.actionId &&
                        String(existing.actionId) !== String(activityItem.actionId)
                    ) {
                        if (isCompanyActSelf && activityItem.scope === 'outgoing') {
                            activityList.push(activityItem);
                            seenRequests.set(reqIdStr, activityItem.status);
                        }
                        return;
                    }
                    activityList[idx] = { ...existing, ...activityItem };
                    seenRequests.set(reqIdStr, activityItem.status);
                    return;
                }
                activityList[idx] = { ...existing, ...activityItem };
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, item.status);
            }
        });

        vehicleProfileActivationOutcomeItems.forEach((item) => {
            const reqIdStr = item.requestId?.toString();
            if (!reqIdStr) return;
            const isVehicleActSelf =
                dashboardAssigneeMongoIds.some(
                    (id) => id && item.assignedTo && id.toString() === item.assignedTo.toString(),
                ) ||
                (targetEmployeeId &&
                    item.assignedToEmpId &&
                    normEmpForAssignee(item.assignedToEmpId) === normEmpForAssignee(targetEmployeeId));
            const activityItem = {
                id: reqIdStr,
                actionId: item._id.toString(),
                type: 'Vehicle Profile Activation',
                requestedBy: isVehicleActSelf ? 'Me' : item.subjectName || item.requestedByName || 'Vehicle',
                requestedDate: item.requestedDate,
                actionedDate: item.actionedDate || item.updatedAt,
                status: item.status,
                extra1: item.extra1 || item.subjectEmployeeId,
                extra2: item.extra2,
                extra3: item.extra3,
                targetEmployeeId: item.subjectEmployeeId?.toString(),
                employeeId: targetEmployeeId,
                scope: isVehicleActSelf ? 'inbox' : 'inbox',
            };

            const idx = activityList.findIndex((i) => {
                if (i.id?.toString() !== reqIdStr || i.type !== 'Vehicle Profile Activation') return false;
                if (
                    activityItem.actionId &&
                    i.actionId &&
                    String(i.actionId) === String(activityItem.actionId)
                ) {
                    return true;
                }
                if (isVehicleActSelf) {
                    return i.scope === 'outgoing' || i.scope === 'inbox';
                }
                if (!isVehicleActSelf && i.scope !== 'outgoing') return true;
                return false;
            });
            if (idx !== -1) {
                const existing = activityList[idx];
                if (item.status === 'On Hold' && isVehicleActSelf && existing.status === 'Pending') {
                    const pendingTs = new Date(existing.requestedDate || 0).getTime();
                    const holdTs = new Date(
                        item.actionedDate || item.updatedAt || item.requestedDate || 0,
                    ).getTime();
                    if (pendingTs >= holdTs) return;
                    activityList[idx] = { ...existing, ...activityItem };
                    return;
                }
                if (existing.status === 'Pending' && ['Approved', 'Rejected'].includes(activityItem.status)) {
                    if (
                        existing.actionId &&
                        activityItem.actionId &&
                        String(existing.actionId) !== String(activityItem.actionId)
                    ) {
                        if (isVehicleActSelf && activityItem.scope === 'outgoing') {
                            activityList.push(activityItem);
                            seenRequests.set(reqIdStr, activityItem.status);
                        }
                        return;
                    }
                    activityList[idx] = { ...existing, ...activityItem };
                    seenRequests.set(reqIdStr, activityItem.status);
                    return;
                }
                activityList[idx] = { ...existing, ...activityItem };
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, item.status);
            }
        });

        assetCreationOutcomeItems.forEach((item) => {
            const reqIdStr = item.requestId?.toString();
            if (!reqIdStr) return;
            const isAssetCreationSelf =
                dashboardAssigneeMongoIds.some(
                    (id) => id && item.assignedTo && id.toString() === item.assignedTo.toString(),
                ) ||
                (targetEmployeeId &&
                    item.assignedToEmpId &&
                    normEmpForAssignee(item.assignedToEmpId) === normEmpForAssignee(targetEmployeeId)) ||
                (currentUser?.employeeId &&
                    item.assignedToEmpId &&
                    normEmpForAssignee(item.assignedToEmpId) === normEmpForAssignee(currentUser.employeeId));
            const activityItem = {
                id: reqIdStr,
                actionId: item._id.toString(),
                type: 'Asset Approval',
                requestedBy: isAssetCreationSelf ? 'Me' : item.subjectName || item.requestedByName || 'Asset',
                requestedDate: item.requestedDate,
                actionedDate: item.actionedDate || item.updatedAt,
                status: item.status,
                extra1: item.extra1 || item.subjectEmployeeId,
                extra2: item.extra2,
                extra3: item.extra3,
                targetEmployeeId: item.subjectEmployeeId?.toString(),
                employeeId: targetEmployeeId,
                scope: isAssetCreationSelf ? 'outgoing' : 'inbox',
            };

            const idx = activityList.findIndex(
                (i) => i.id?.toString() === reqIdStr && i.type === 'Asset Approval',
            );
            if (idx !== -1) {
                const existing = activityList[idx];
                if (existing.status === 'Pending' && activityItem.status === 'Rejected') {
                    if (
                        existing.actionId &&
                        activityItem.actionId &&
                        String(existing.actionId) !== String(activityItem.actionId)
                    ) {
                        return;
                    }
                    activityList[idx] = { ...existing, ...activityItem };
                    seenRequests.set(reqIdStr, activityItem.status);
                    return;
                }
                activityList[idx] = { ...existing, ...activityItem };
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, item.status);
            }
        });

        if (process.env.DEBUG_USER_ACTIVITY_STATS === "1") {
            console.log("Stats Debug:", {
                mode: req.query.targetUserId ? "Manager View" : "Self View",
                currentUserId: currentUser._id,
                totalItems: activityList.length,
            });
        }

        // 6. Actioned History (Items this user approved/rejected)
        // Already calculated relevantIds above

        const ACTIONED_PROFILE_FIELDS = {
            _id: 1, employeeId: 1, firstName: 1, lastName: 1, profileWorkflow: 1, updatedAt: 1,
        };
        const ACTIONED_NOTICE_FIELDS = {
            _id: 1, employeeId: 1, firstName: 1, lastName: 1, noticeRequest: 1, updatedAt: 1,
        };

        // Actioned history reads run in parallel; allow any to fail without blanking the dashboard.
        const actionedHistorySettled = await Promise.allSettled([
            Loan.find({
                workflow: {
                    $elemMatch: {
                        $or: [
                            { assignedTo: { $in: relevantIds } },
                            ...(isCEO ? [{ role: 'CEO' }] : []),
                            ...(isHR ? [{ role: 'HR' }] : []),
                            ...(isAccounts ? [{ role: 'Accounts' }] : [])
                        ],
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).populate('createdBy', 'name').sort({ updatedAt: -1 }).limit(20).lean().maxTimeMS(6000),
            Reward.find({
                $or: [
                    {
                        workflow: {
                            $elemMatch: {
                                $or: [
                                    { assignedTo: { $in: relevantIds } },
                                    ...(isCEO ? [{ role: 'CEO' }] : [])
                                ],
                                status: { $in: ['Approved', 'Rejected'] }
                            }
                        }
                    },
                    ...(isCEO ? [{ approvedBy: { $in: relevantIds } }] : [])
                ]
            }).sort({ updatedAt: -1 }).limit(20).populate('createdBy', 'name').lean().maxTimeMS(6000),
            Fine.find({
                workflow: {
                    $elemMatch: {
                        $or: [
                            { assignedTo: { $in: relevantIds } },
                            ...(isCEO ? [{ role: 'CEO' }] : []),
                            ...(isHR ? [{ role: 'HR' }] : []),
                            ...(isAccounts ? [{ role: 'Accounts' }] : [])
                        ],
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).populate('createdBy', 'name').sort({ updatedAt: -1 }).limit(20).lean().maxTimeMS(6000),
            // 6b. GET ACTIONED PROFILES (History)
            EmployeeBasic.find({
                profileWorkflow: {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['active', 'rejected'] }
                    }
                }
            }).select(ACTIONED_PROFILE_FIELDS).sort({ updatedAt: -1 }).limit(10).lean().maxTimeMS(6000),
            // Notice Workflow History
            EmployeeBasic.find({
                'noticeRequest.workflow': {
                    $elemMatch: {
                        assignedTo: { $in: relevantIds },
                        status: { $in: ['Approved', 'Rejected'] }
                    }
                }
            }).select(ACTIONED_NOTICE_FIELDS).sort({ 'noticeRequest.actionedAt': -1 }).limit(10).lean().maxTimeMS(6000),
            // 6c. ACTIONED ASSETS (History)
            DashboardAction.find({
                assignedTo: { $in: relevantIds },
                requestType: { $in: allAssetTypes },
                status: { $in: ['Approved', 'Rejected'] }
            }).sort({ actionedDate: -1, updatedAt: -1 }).limit(20).lean().maxTimeMS(6000),
        ]);
        actionedHistorySettled.forEach((r, i) => {
            if (r.status === "rejected") {
                console.warn(`[getUserActivityStats] actioned history slot ${i} failed:`, r.reason?.message || r.reason);
            }
        });
        const [
            myActionedLoans, myActionedRewards, myActionedFines,
            myActionedProfiles, myActionedNotices, myActionedAssetActions,
        ] = actionedHistorySettled.map((r) => (r.status === "fulfilled" ? r.value : []));

        // Process these history items
        // We add these ONLY if not already in the list as Pending. 
        // If already in as pending, we prefer the 'Approved/Rejected' status for the actioner.

        myActionedAssetActions.forEach(action => {
            const reqIdStr = action.requestId.toString();
            const activityItem = {
                id: action.requestId,
                type: 'Asset',
                requestedBy: action.requestedByName || action.subjectName || 'Unknown',
                requestedDate: action.requestedDate,
                actionedDate: action.actionedDate || action.updatedAt,
                status: action.status,
                extra1: action.extra1,
                extra2: action.extra2,
                extra3: action.extra3,
                targetEmployeeId: action.subjectEmployeeId,
                scope: 'inbox'
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && item.type === 'Asset');
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, action.status);
            }
        });

        myActionedNotices.forEach(p => {
            const reqIdStr = p._id.toString() + "_notice";
            const myStep = p.noticeRequest?.workflow ? p.noticeRequest.workflow.find(w => w.assignedTo && w.assignedTo.toString() === manager._id.toString() && w.status !== 'Pending') : null;
            const status = myStep ? myStep.status : p.noticeRequest?.status;

            const activityItem = {
                id: p._id, type: 'Notice Request', requestedBy: `${p.firstName} ${p.lastName}`,
                requestedDate: myStep ? myStep.assignedAt : p.noticeRequest?.requestedAt,
                actionedDate: myStep ? myStep.actionedAt : (p.noticeRequest?.actionedAt || p.updatedAt),
                status: status,
                extra1: `Actioned: ${status}`,
                extra2: p.noticeRequest?.reason,
                targetEmployeeId: p.employeeId,
                isNotice: true,
                scope: 'inbox'
            };

            if (seenRequests.has(reqIdStr)) {
                // Update existing instead of adding new
                const idx = activityList.findIndex(item => (item.id.toString() + (item.isNotice ? "_notice" : "")) === reqIdStr);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedLoans.forEach(l => {
            const reqIdStr = l._id.toString();
            const myStep = l.workflow ? l.workflow.find(w => w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) && ['Approved', 'Rejected'].includes(w.status)) : null;
            const status = (myStep?.status === 'Rejected' || l.status === 'Rejected') ? 'Rejected' : 'Approved';

            const activityItem = {
                id: l._id, type: l.type, requestedBy: l.createdBy?.name || l.employeeName || 'Employee',
                requestedDate: l.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (l.approvedDate || l.updatedAt),
                status: status,
                extra1: `Actioned: ${status}`,
                extra2: `AED ${l.amount}`,
                targetEmployeeId: l.employeeId,
                scope: 'inbox'
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedRewards.forEach(r => {
            const reqIdStr = r._id.toString();
            const myStep = r.workflow ? r.workflow.find(w =>
                (['Approved', 'Rejected'].includes(w.status)) &&
                (
                    (w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString())) ||
                    (isCEO && w.role === 'CEO')
                )
            ) : null;

            const isApprovedByMe = isCEO && r.approvedBy && relevantIds.some(id => id.toString() === r.approvedBy.toString());
            if (!myStep && !isApprovedByMe) return;

            const status = (myStep?.status === 'Rejected' || r.rewardStatus === 'Rejected') ? 'Rejected' : 'Approved';
            const activityItem = {
                id: r._id, type: 'Reward', requestedBy: r.createdBy?.name || r.employeeName || 'Employee',
                requestedDate: r.createdAt,
                actionedDate: myStep ? myStep.actionedAt : (r.approvedDate || r.updatedAt),
                status: status,
                extra1: `Actioned: ${status}`,
                extra2: `AED ${r.amount || 0}`,
                targetEmployeeId: r.employeeId,
                scope: 'inbox'
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedFines.forEach(f => {
            const reqIdStr = f._id.toString();
            const myEntry = f.workflow ? f.workflow.find(w =>
                (['Approved', 'Rejected'].includes(w.status)) &&
                (
                    (w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString())) ||
                    (isCEO && w.role === 'CEO') ||
                    (isHR && w.role === 'HR') ||
                    (isAccounts && w.role === 'Accounts')
                )
            ) : null;

            const assignedList = f.assignedEmployees || [];
            const legacyEntry = assignedList.find(e => relevantIds.some(id => id.toString() === e.approvedBy?.toString()));

            const status = (myEntry?.status === 'Rejected' || legacyEntry?.approvalStatus === 'Rejected') ? 'Rejected' : 'Approved';
            const activityItem = {
                id: f._id, type: 'Fine', requestedBy: f.createdBy?.name || legacyEntry?.employeeName || 'Employee',
                requestedDate: f.createdAt,
                actionedDate: myEntry ? myEntry.actionedAt : (legacyEntry?.approvedAt || f.updatedAt),
                status: status,
                extra1: `Actioned: Verified`,
                extra2: `AED ${f.fineAmount}`,
                targetEmployeeId: legacyEntry?.employeeId,
                scope: 'inbox'
            };

            if (seenRequests.has(reqIdStr)) {
                const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                if (idx !== -1) activityList[idx] = activityItem;
            } else {
                activityList.push(activityItem);
                seenRequests.set(reqIdStr, status);
            }
        });

        myActionedProfiles.forEach(p => {
            const reqIdStr = p._id.toString();
            const mySteps = p.profileWorkflow ? p.profileWorkflow.filter(w =>
                w.assignedTo && relevantIds.some(id => id.toString() === w.assignedTo.toString()) &&
                ['active', 'rejected'].includes(w.status)
            ) : [];

            mySteps.forEach(step => {
                const status = step.status === 'active' ? 'Approved' : 'Rejected';
                const activityItem = {
                    id: p._id, type: 'Profile Activation', requestedBy: `${p.firstName} ${p.lastName}`,
                    requestedDate: step.assignedAt,
                    actionedDate: step.actionedAt || p.updatedAt,
                    status: status,
                    extra1: `Actioned: ${status}`,
                    extra2: p.employeeId,
                    targetEmployeeId: p.employeeId,
                    scope: 'inbox'
                };

                // Since one profile can have multiple steps, we only add/update once
                if (seenRequests.has(reqIdStr)) {
                    const idx = activityList.findIndex(item => item.id.toString() === reqIdStr && !item.isNotice);
                    if (idx !== -1) {
                        const existing = activityList[idx];
                        // If the request is currently pending again, keep that live item visible for HR action.
                        if (existing.status === 'Pending' && ['Approved', 'Rejected'].includes(activityItem.status)) {
                            return;
                        }
                        activityList[idx] = activityItem;
                    }
                } else {
                    activityList.push(activityItem);
                    seenRequests.set(reqIdStr, status);
                }
            });
        });

        const finalActivityList = await filterCompletedCompanyActivationItems(activityList);

        // Final counts
        const pendingCount = finalActivityList.filter(i => i.status === 'Pending').length;
        const approvedCount = finalActivityList.filter(i => i.status === 'Approved').length;
        const rejectedCount = finalActivityList.filter(i => (i.status === 'Rejected' || i.status === 'rejected')).length;

        res.status(200).json({
            pending: pendingCount,
            approved: approvedCount,
            rejected: rejectedCount,
            total: finalActivityList.length,
            flowchartHrEmployeeObjectId: flowchartHrEmp?._id ? String(flowchartHrEmp._id) : null,
            items: finalActivityList.sort((a, b) => {
                const dateA = new Date(a.actionedDate || a.requestedDate || 0);
                const dateB = new Date(b.actionedDate || b.requestedDate || 0);
                return dateB - dateA;
            })
        });

    } catch (error) {
        console.error("Management Activity Stats Error:", error);
        res.status(500).json({ message: "Failed to fetch dashboard activity" });
    }
};

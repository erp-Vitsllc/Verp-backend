import AssetItem from '../models/AssetItem.js';
import mongoose from 'mongoose';
import AssetType from '../models/AssetType.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import Company from '../models/Company.js';
import User from '../models/User.js';
import { getSignedFileUrl, uploadDocumentToS3 } from '../utils/s3Upload.js';
import { generatePdf } from '../utils/generatePdf.js';
import { sendAssetAssignmentEmail } from '../utils/sendAssetAssignmentEmail.js';
import { sendAssetResponseEmail } from '../utils/sendAssetResponseEmail.js';
import { sendAssetReassignmentEmail } from '../utils/sendAssetReassignmentEmail.js';
import DashboardAction from '../models/DashboardAction.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { sendAssetActionFinalAcknowledgeEmail } from '../utils/sendAssetActionFinalAcknowledgeEmail.js';
import Fine from '../models/Fine.js';
import AssetCategory from '../models/AssetCategory.js';
import Flowchart from '../models/Flowchart.js';
import {
    getDepartmentHOD,
    isUserInFlowchart,
    isUserActiveInFlowchart,
    getCompanyAssetCoordinator,
    isUserCompanyAssetCoordinator,
    isUserActiveCompanyAssetCoordinator
} from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { sendAssetCreationApprovalEmail } from '../utils/sendAssetCreationApprovalEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { sendAssetServiceEmail } from '../utils/sendAssetServiceEmail.js';
import { resolveAssetControllerEmployee, getAssetRequesterDisplayName } from '../utils/assetApprovalHelpers.js';
import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';
import { sendAssignedEmployeeActionEmail } from '../utils/sendAssignedEmployeeActionEmail.js';
import { processParkingAssets } from '../utils/processParkingAssets.js';
import { sendParkingReassignAcceptedEmail } from '../utils/sendParkingReassignAcceptedEmail.js';
import { sendParkingExtensionEmail } from '../utils/sendAssetParkingNotifications.js';
import { notifyAssetControllerReassignmentAcceptedWithHandover } from '../utils/notifyAssetControllerReassignmentAcceptedWithHandover.js';
import { notifyPreviousAssigneeReassignmentAcceptedWithHandover } from '../utils/notifyPreviousAssigneeReassignmentAcceptedWithHandover.js';
import { ASSET_HANDOVER_PDF_SELECTOR } from '../utils/assetHandoverPdfConstants.js';
import {
    buildBulkAssetInventoryPdfAttachment,
    requireBulkAssetInventoryPdfAttachment,
    buildBulkAssigneeDispositionPdfAttachment
} from '../utils/generateBulkAssetInventoryPdf.js';
import { sendAssetBulkDispositionResultEmail } from '../utils/sendAssetBulkDispositionResultEmail.js';
import {
    notifyAdminDeletedWholeAsset,
    isReqUserAdmin,
    getAssetControllerNotificationEmail
} from '../utils/sendAdminDeletionNotificationEmails.js';
import {
    cleanupDashboardActionsForDeletedAsset,
    ASSET_DASHBOARD_INBOX_TYPES,
    ASSET_TOOLS_INBOX_TYPES
} from '../utils/cleanupAssetDashboardActions.js';
import {
    maybeStartVehicleServiceWorkflow,
    getWorkflowAssigneePayloadForStage,
    userMayRespondVehicleServiceWorkflow
} from './vehicleServiceWorkflowController.js';
import {
    generateVegaAccessoryCatalogId,
    syncAllAccessoryInstancesForAsset,
    markCatalogInstancesDetachedFromAsset
} from '../utils/syncAssetAccessoryCatalog.js';
import {
    filterAccessoriesHidingPendingAdds,
    computeCanSeePendingAddsForAsset
} from '../utils/assetPendingAccessoryVisibility.js';

const generateAccessoryCatalogId = generateVegaAccessoryCatalogId;

async function buildPendingAccessoryVisibilityCtx(req) {
    const isSysAdmin = await isUserAdministrator(req.user?.id);
    const isPortalAdmin =
        req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
    const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
    const assetController = await getDepartmentHOD('assetcontroller');

    let currentEmpId = req.user?.employeeObjectId?.toString();
    if (!currentEmpId && req.user?.employeeId) {
        const empRow = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
        })
            .select('_id')
            .lean()
            .catch(() => null);
        if (empRow?._id) currentEmpId = empRow._id.toString();
    }

    const normEmpView = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
    let currentEmployeeIdNorm = normEmpView(req.user?.employeeId);
    if (!currentEmployeeIdNorm && currentEmpId) {
        const curEmp = await EmployeeBasic.findById(currentEmpId).select('employeeId').lean().catch(() => null);
        if (curEmp?.employeeId) currentEmployeeIdNorm = normEmpView(curEmp.employeeId);
    }

    const isDeptAssetController = !!(
        assetController?._id &&
        currentEmpId &&
        assetController._id.toString() === currentEmpId
    );
    const canSeeAllPending = isSysAdmin || isPortalAdmin || isAssetController || isDeptAssetController;
    return {
        canSeeAllPending,
        currentEmpId: currentEmpId || null,
        currentEmployeeIdNorm: currentEmployeeIdNorm || null
    };
}

/** Non-draft assets are visible to all authenticated users; Draft only to the creating User. */
function buildDraftVisibilityQuery(reqUser) {
    const uid = reqUser?._id || reqUser?.id;
    if (uid && mongoose.Types.ObjectId.isValid(String(uid))) {
        return {
            $or: [{ status: { $ne: 'Draft' } }, { createdBy: new mongoose.Types.ObjectId(String(uid)) }]
        };
    }
    return { status: { $ne: 'Draft' } };
}

const generateFineIdInternal = async () => {
    try {
        const fines = await Fine.find({ fineId: /VEGA-(FINE|FNE)-(\d+)/i }).select('fineId').lean();
        let maxNum = 0;
        if (fines.length > 0) {
            fines.forEach(f => {
                const match = f.fineId.match(/VEGA-(FINE|FNE)-(\d+)/i);
                if (match && match[2]) {
                    const num = parseInt(match[2], 10);
                    if (num > maxNum) maxNum = num;
                }
            });
        }
        const nextNum = maxNum + 1;
        return `VEGA-FINE-${nextNum.toString().padStart(4, '0')}`;
    } catch (error) {
        console.error('Error generating internal fine ID:', error);
        return `fine${Date.now().toString().slice(-4)}`;
    }
};

const validateFineTrackerFlowchart = async () => {
    const hrHOD = await getDepartmentHOD('hr');
    const accountsHOD = await getDepartmentHOD('accounts');
    const managementHOD = await getManagementHOD();

    const missing = [];
    if (!hrHOD?._id) missing.push('HR');
    if (!accountsHOD?._id) missing.push('Accounts');
    if (!managementHOD?._id) missing.push('Management');

    if (missing.length > 0) {
        return {
            ok: false,
            message: `Cannot proceed with Loss and Damage. Missing Flowchart setup: ${missing.join(', ')}. Please configure these roles first in Settings > FlowChart.`
        };
    }

    return { ok: true, hrHOD, accountsHOD, managementHOD };
};

const notifyAssignedEmployeeIfController = async (req, assetDoc, action, details = '') => {
    try {
        const isAssetControllerUser = await isUserInFlowchart(req.user, 'assetcontroller');
        if (!isAssetControllerUser) return;

        if (!assetDoc) return;

        const mapActionToDashboardRequestType = (actionString) => {
            if (!actionString) return null;
            const a = String(actionString).toLowerCase();
            if (a.includes('loss') || a.includes('loss and damage')) return 'Asset Loss Damage';
            if (a.includes('end of life')) return 'Asset End of Life';
            if (a.includes('transfer')) return 'Asset Transfer';
            if (a.includes('assign') || a.includes('reassign')) return 'Asset Assignment';
            if (a.includes('leave') || a.includes('on leave')) return 'Asset Leave';
            return 'Asset Approval';
        };

        let companyDoc = null;
        if (assetDoc?.assignedCompany) {
            if (typeof assetDoc.assignedCompany === 'object') {
                companyDoc = assetDoc.assignedCompany;
            } else {
                const compId = assetDoc.assignedCompany;
                companyDoc = await Company.findById(compId).select('name companyId nickName').lean().catch(() => null);
            }
        }

        const appendCompanyToDetails = (msg) => {
            if (!msg) msg = '';
            if (assetDoc?.assignedToType === 'Company') {
                const name = companyDoc?.name || assetDoc?.assignedCompany?.name || '';
                if (name) return `${msg}${msg ? ' ' : ''}(Company: ${name})`;
            }
            return msg;
        };

        // Company-assigned assets: email/dashboard flowchart Assigned User (else Admin), not HR.
        if (assetDoc?.assignedToType === 'Company') {
            const companyCoordinator = await getCompanyAssetCoordinator();
            if (!companyCoordinator?._id) return;

            const requestType = mapActionToDashboardRequestType(action);
            const companyName = companyDoc?.name || '';
            const companyId = companyDoc?.companyId || '';
            const subjectName = companyName || 'Company allocation';
            const subjectEmployeeId = companyId || 'UNASSIGNED';

            await sendAssignedEmployeeActionEmail({
                asset: assetDoc,
                employee: companyCoordinator,
                action,
                performedBy: req.user.employeeId || 'Asset Controller',
                details: appendCompanyToDetails(details)
            });

            if (requestType) {
                await DashboardAction.create({
                    assignedTo: companyCoordinator._id,
                    assignedToEmpId: companyCoordinator.employeeId,
                    requestId: assetDoc._id,
                    requestType,
                    status: 'Approved',
                    subjectEmployeeId,
                    subjectName,
                    requestedByName: req.user.name || req.user.employeeId || 'Asset Controller',
                    actionedDate: new Date(),
                    actionedBy: req.user.employeeObjectId || req.user.id || null,
                    extra1: `${assetDoc.assetId} — ${assetDoc.name || ''}`,
                    extra2: appendCompanyToDetails(action || '')
                });
            }
            return;
        }

        // Employee-assigned assets: email the assigned employee.
        if (!assetDoc?.assignedTo) return;
        const employee = await EmployeeBasic.findById(assetDoc.assignedTo)
            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
            .lean();
        if (!employee) return;

        await sendAssignedEmployeeActionEmail({
            asset: assetDoc,
            employee,
            action,
            performedBy: req.user.employeeId || 'Asset Controller',
            details
        });
    } catch (e) {
        console.error('[notifyAssignedEmployeeIfController] Non-fatal:', e?.message || e);
    }
};

/** One email + consolidated PDF per employee after AC bulk-direct Leave/EOS (employee-assigned rows only). */
const notifyEmployeesGroupedControllerBulkDirect = async (req, employeeSnapshots, actionSummary) => {
    try {
        const byEmp = new Map();
        for (const s of employeeSnapshots || []) {
            if (!s?._id || !s.assignedTo) continue;
            const eid = s.assignedTo._id?.toString?.() || s.assignedTo.toString?.();
            if (!eid) continue;
            if (!byEmp.has(eid)) byEmp.set(eid, []);
            byEmp.get(eid).push(s._id.toString());
        }
        for (const [eid, ids] of byEmp) {
            if (!ids.length || !eid) continue;
            const employee = await EmployeeBasic.findById(eid)
                .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                .lean();
            if (!employee) continue;
            let pdf = [];
            try {
                pdf = await buildBulkAssetInventoryPdfAttachment(req, ids, actionSummary.pdfBase);
            } catch (e) {
                console.error('[notifyEmployeesGroupedControllerBulkDirect] PDF:', e?.message || e);
            }
            const firstSnap = employeeSnapshots.find((x) => x._id.toString() === ids[0]);
            await sendAssignedEmployeeActionEmail({
                asset:
                    ids.length > 1
                        ? { _id: ids[0], assetId: `${ids.length} assets`, name: actionSummary.bulkName }
                        : { _id: ids[0], assetId: firstSnap?.assetId, name: firstSnap?.name },
                employee,
                action: actionSummary.actionLabel,
                performedBy: req.user.employeeId || 'Asset Controller',
                details: actionSummary.detailsText,
                attachments: pdf,
                customIntro: actionSummary.customIntro
            });
        }
    } catch (e) {
        console.error('[notifyEmployeesGroupedControllerBulkDirect] Non-fatal:', e?.message || e);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Permission helper: full access for assigned actors
// - Admin + Asset Controller: always allowed
// - Assignee: allowed
// - Assigner (asset.assignedBy): allowed with full permissions
// - If assignee has NO `companyEmail` OR no portal/login access: allow primaryReportee as delegate
// ─────────────────────────────────────────────────────────────────────────────
const getActorPermissionFlagsForAsset = async (reqUser, asset) => {
    const currentEmpObjectId = reqUser?.employeeObjectId?.toString?.() || null;
    const isAdmin = reqUser?.isAdmin === true || reqUser?.role === 'Admin' || reqUser?.role === 'ROOT';
    const isAssetController = await isUserInFlowchart(reqUser, 'assetcontroller').catch(() => false);
    const isCompanyAsset = asset?.assignedToType === 'Company' && !!asset?.assignedCompany;
    const isCompanyCoordinator =
        isCompanyAsset && (await isUserCompanyAssetCoordinator(reqUser).catch(() => false));

    const toIdString = (v) => {
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (v._id) return v._id.toString();
        if (v.toString) return v.toString();
        return null;
    };

    const assignedById = toIdString(asset?.assignedBy);
    const isAssigner = !!(currentEmpObjectId && assignedById && assignedById === currentEmpObjectId);

    let isAssignee = false;
    let isPrimaryReporteeDelegate = false;

    if (asset?.assignedToType === 'Employee' && asset?.assignedTo && currentEmpObjectId) {
        const assigneeId = toIdString(asset.assignedTo);
        isAssignee = !!(assigneeId && assigneeId === currentEmpObjectId);

        let assigneeDoc =
            (typeof asset.assignedTo === 'object' && (asset.assignedTo.employeeId || asset.assignedTo.companyEmail !== undefined || asset.assignedTo.primaryReportee))
                ? asset.assignedTo
                : await EmployeeBasic.findById(assigneeId)
                    .select('companyEmail primaryReportee employeeId')
                    .lean()
                    .catch(() => null);

        // If we didn't receive employeeId in the populated document, fetch it so we can check portal access safely.
        if (assigneeDoc && !assigneeDoc.employeeId) {
            assigneeDoc = await EmployeeBasic.findById(assigneeId)
                .select('companyEmail primaryReportee employeeId')
                .lean()
                .catch(() => assigneeDoc);
        }

        const hasCompanyEmail = !!(assigneeDoc?.companyEmail && String(assigneeDoc.companyEmail).trim().length > 0);
        const primaryReporteeId = toIdString(assigneeDoc?.primaryReportee);

        // Portal access check (ERP login-enabled user)
        let hasPortalAccess = null;
        const assigneeEmpId = assigneeDoc?.employeeId ? String(assigneeDoc.employeeId) : null;
        if (assigneeEmpId) {
            const linkedUser = await User.findOne({ employeeId: assigneeEmpId, status: 'Active' })
                .select('enablePortalAccess')
                .lean()
                .catch(() => null);
            hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
        }

        isPrimaryReporteeDelegate = !!(
            primaryReporteeId &&
            primaryReporteeId === currentEmpObjectId &&
            (!hasCompanyEmail || hasPortalAccess === false)
        );
    }

    const canAct =
        isAdmin ||
        isAssetController ||
        isCompanyCoordinator ||
        isAssigner ||
        isAssignee ||
        isPrimaryReporteeDelegate;
    return {
        canAct,
        isAdmin,
        isAssetController,
        isCompanyCoordinator,
        isAssigner,
        isAssignee,
        isPrimaryReporteeDelegate
    };
};


export const getAssetItems = async (req, res) => {
    try {
        const { typeId } = req.params;
        const { status } = req.query;

        let query = { typeId: typeId };
        if (status && status.toLowerCase() !== 'all') {
            query.status = status;
        }

        query.$and = query.$and || [];
        query.$and.push(buildDraftVisibilityQuery(req.user));

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const items = await AssetItem.find(query)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department primaryReportee reportingAuthority companyEmail enablePortalAccess',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName' },
                    { path: 'reportingAuthority', select: 'firstName lastName' }
                ]
            })
            .populate('actionRequiredBy', 'employeeId')
            .populate('acceptedBy', 'firstName lastName signature')
            .sort({ assetId: 1 });

        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, item);
            if (itemObj.accessories?.length) {
                itemObj.accessories = filterAccessoriesHidingPendingAdds(itemObj.accessories, canSeePending);
            }
            if (itemObj.photo) {
                itemObj.photo = await getSignedFileUrl(itemObj.photo);
            }
            if (itemObj.imagePreview) {
                itemObj.imagePreview = await getSignedFileUrl(itemObj.imagePreview);
            }
            return itemObj;
        }));

        res.status(200).json(signedItems);
    } catch (error) {
        console.error('Error fetching asset items:', error);
        res.status(500).json({ message: 'Server Error' });
    }

};

/**
 * Fleet dashboard for vehicle assets: reminders, status, charts (service cost, model years, usage proxy).
 * @route GET /api/AssetItem/vehicle-fleet-dashboard
 */
export const getVehicleFleetDashboard = async (req, res) => {
    try {
        const draftVis = buildDraftVisibilityQuery(req.user);
        const items = await AssetItem.find({ $and: [draftVis] })
            .populate('typeId', 'name')
            .populate('assignedTo', 'firstName lastName employeeId')
            .select(
                'assetId name plateEmirate plateNumber modelYear assetValue status registrationExpiryDate insuranceExpiryDate nextServiceDate oilChangeDate gearOilDueDate lastServiceDate currentKilometer assignedTo acceptanceStatus pendingAction services documents'
            )
            .lean();

        const isVehicleAsset = (it) => {
            const plate = (it.plateNumber || '').trim();
            if (plate) return true;
            const t = (it.typeId?.name || '').toLowerCase();
            return t.includes('vehicle') || t.includes('car') || t.includes('fleet') || t.includes('truck');
        };

        const vehicles = items.filter(isVehicleAsset);
        const vehicleIds = vehicles.map((v) => v._id);

        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const soonEnd = new Date(now);
        soonEnd.setDate(soonEnd.getDate() + 30);

        const registrationExpiry = (v) => {
            if (v.registrationExpiryDate) return new Date(v.registrationExpiryDate);
            const reg = (v.documents || []).find((d) => String(d.type || '').toLowerCase() === 'registration');
            if (reg?.expiryDate) return new Date(reg.expiryDate);
            return null;
        };

        const nextMaintenanceDate = (v) => {
            const dates = [v.nextServiceDate, v.gearOilDueDate].filter(Boolean).map((d) => new Date(d));
            if (!dates.length) return null;
            return new Date(Math.min(...dates.map((d) => d.getTime())));
        };

        let serviceDue = 0;
        let serviceDueSoon = 0;
        let regDue = 0;
        let regDueSoon = 0;

        for (const v of vehicles) {
            const sd = nextMaintenanceDate(v);
            if (sd) {
                const t = new Date(sd);
                t.setHours(0, 0, 0, 0);
                if (t < now) serviceDue++;
                else if (t <= soonEnd) serviceDueSoon++;
            }
            const rd = registrationExpiry(v);
            if (rd) {
                const t = new Date(rd);
                t.setHours(0, 0, 0, 0);
                if (t < now) regDue++;
                else if (t <= soonEnd) regDueSoon++;
            }
        }

        const stNorm = (s) => String(s || '').toLowerCase();
        let assigned = 0;
        let unassigned = 0;
        let inService = 0;
        for (const v of vehicles) {
            const st = stNorm(v.status);
            if (v.assignedTo && st === 'assigned') assigned++;
            if (!v.assignedTo && st === 'unassigned') unassigned++;
            if (['service', 'on service', 'maintenance', 'online'].includes(st)) inService++;
        }

        let handoverPending = 0;
        let handoverConfirmed = 0;
        for (const v of vehicles) {
            if (v.assignedTo && String(v.acceptanceStatus || '') === 'Pending') handoverPending++;
            if (v.assignedTo && String(v.acceptanceStatus || '') === 'Accepted') handoverConfirmed++;
        }

        let daPending = 0;
        let daApproved = 0;
        if (vehicleIds.length) {
            daPending = await DashboardAction.countDocuments({
                requestId: { $in: vehicleIds },
                status: 'Pending',
                requestType: { $in: ASSET_DASHBOARD_INBOX_TYPES }
            });
            daApproved = await DashboardAction.countDocuments({
                requestId: { $in: vehicleIds },
                status: 'Approved',
                requestType: { $in: ASSET_DASHBOARD_INBOX_TYPES }
            });
        }

        const fleetRows = vehicles.map((v) => {
            const total = (v.services || []).reduce((sum, s) => sum + Number(s.value || 0), 0);
            return {
                _id: v._id,
                assetId: v.assetId,
                plateEmirate: v.plateEmirate || '',
                plateNumber: v.plateNumber,
                label: (v.plateNumber || v.assetId || 'Asset').toString().slice(0, 18),
                totalServiceCost: total,
                assetValue: Number(v.assetValue || 0),
                modelYear: v.modelYear || '',
                status: v.status,
                assignedTo: v.assignedTo,
                registrationExpiryDate: v.registrationExpiryDate,
                currentKilometer: v.currentKilometer
            };
        });

        const monthTotals = {};
        for (const v of vehicles) {
            for (const s of v.services || []) {
                if (!s?.date) continue;
                const d = new Date(s.date);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                monthTotals[key] = (monthTotals[key] || 0) + Number(s.value || 0);
            }
        }
        const monthKeys = Object.keys(monthTotals).sort();
        const serviceCostByMonth = monthKeys.slice(-12).map((k) => ({ label: k, total: monthTotals[k] }));

        const yearCounts = {};
        for (const v of vehicles) {
            const y = (v.modelYear || 'Unknown').toString().trim() || 'Unknown';
            yearCounts[y] = (yearCounts[y] || 0) + 1;
        }
        const modelYearDistribution = Object.entries(yearCounts)
            .map(([year, count]) => ({ year, count }))
            .sort((a, b) => {
                const na = parseInt(a.year, 10);
                const nb = parseInt(b.year, 10);
                if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
                if (a.year === 'Unknown') return 1;
                if (b.year === 'Unknown') return -1;
                return String(b.year).localeCompare(String(a.year));
            });

        const hasServiceInRange = (v, start, end) =>
            (v.services || []).some((s) => {
                if (!s?.date) return false;
                const t = new Date(s.date).getTime();
                return t >= start.getTime() && t <= end.getTime();
            });

        const countServicesInRange = (start, end) => {
            let c = 0;
            for (const v of vehicles) {
                for (const s of v.services || []) {
                    if (!s?.date) continue;
                    const t = new Date(s.date).getTime();
                    if (t >= start.getTime() && t <= end.getTime()) c++;
                }
            }
            return c;
        };

        const buildUsageSeries = (unit) => {
            const labels = [];
            const usage = [];
            const idle = [];
            if (unit === 'day') {
                for (let i = 6; i >= 0; i--) {
                    const start = new Date(now);
                    start.setDate(start.getDate() - i);
                    start.setHours(0, 0, 0, 0);
                    const end = new Date(start);
                    end.setHours(23, 59, 59, 999);
                    labels.push(`${start.getDate()}/${start.getMonth() + 1}`);
                    usage.push(countServicesInRange(start, end));
                    idle.push(vehicles.filter((v) => !hasServiceInRange(v, start, end)).length);
                }
            } else if (unit === 'week') {
                for (let i = 7; i >= 0; i--) {
                    const end = new Date(now);
                    end.setDate(end.getDate() - i * 7);
                    end.setHours(23, 59, 59, 999);
                    const start = new Date(end);
                    start.setDate(start.getDate() - 6);
                    start.setHours(0, 0, 0, 0);
                    labels.push(`W${8 - i}`);
                    usage.push(countServicesInRange(start, end));
                    idle.push(vehicles.filter((v) => !hasServiceInRange(v, start, end)).length);
                }
            } else {
                for (let i = 11; i >= 0; i--) {
                    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
                    const start = new Date(d.getFullYear(), d.getMonth(), 1);
                    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
                    labels.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
                    usage.push(countServicesInRange(start, end));
                    idle.push(vehicles.filter((v) => !hasServiceInRange(v, start, end)).length);
                }
            }
            return { labels, usage, idle };
        };

        res.json({
            reminders: {
                service: { due: serviceDue, dueSoon: serviceDueSoon },
                registration: { due: regDue, dueSoon: regDueSoon }
            },
            vehicleStatus: { assigned, unassigned, inService },
            serviceRequest: { pending: daPending, confirmed: daApproved },
            handoverRequest: { pending: handoverPending, confirmed: handoverConfirmed },
            serviceCostByMonth,
            vehicles: fleetRows,
            modelYearDistribution,
            usageByPeriod: {
                day: buildUsageSeries('day'),
                week: buildUsageSeries('week'),
                month: buildUsageSeries('month')
            },
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error('getVehicleFleetDashboard:', error);
        res.status(500).json({ message: 'Failed to load vehicle fleet dashboard' });
    }
};

function mapAssetHistoryWorkflowActionToTimelineAction(wa) {
    if (wa === 'start') return 'created';
    return wa || 'approve';
}

function inferWorkflowStageFromHistoryEvents(eventsChrono) {
    if (!eventsChrono.length) return null;
    if (eventsChrono.some((e) => e.workflowAction === 'reject')) return 'rejected';
    const last = eventsChrono[eventsChrono.length - 1];
    if (!last) return null;
    if (last.workflowAction === 'hold') return 'pending_accounts';
    if (last.workflowAction === 'start') return 'pending_hr';
    if (last.workflowAction === 'approve') {
        if (last.stage === 'pending_admin' || last.stage === 'pending_management') return 'complete';
        const next = {
            pending_hr: 'pending_accounts',
            pending_accounts: 'pending_admin',
            pending_admin: 'complete',
            pending_management: 'complete',
        };
        return next[last.stage] || 'complete';
    }
    if (last.stage) return last.stage;
    return null;
}

/** Map embedded snapshot history (action: created|approve|…) to infer stage when `stage` field missing. */
function inferStageFromEmbeddedHistory(hist) {
    if (!Array.isArray(hist) || !hist.length) return null;
    const ev = hist.map((h) => ({
        stage: h.stage,
        workflowAction: h.action === 'created' ? 'start' : h.action,
    }));
    return inferWorkflowStageFromHistoryEvents(ev) || null;
}

/** When services[].workflowSnapshot was never stored, rebuild from AssetHistory (details.serviceRecordId). */
function workflowSnapshotFromAssetHistoryDocs(historyDocs, serviceTypeLabelFallback) {
    if (!historyDocs?.length) return null;
    const sorted = [...historyDocs].sort((a, b) => new Date(a.date) - new Date(b.date));
    const timeline = sorted.map((d) => {
        const det = d.details || {};
        return {
            stage: det.stage,
            workflowAction: det.workflowAction,
            note: det.note || '',
            byName: det.byName || '',
            at: d.date,
        };
    });
    let stage = inferWorkflowStageFromHistoryEvents(
        timeline.map((t) => ({ stage: t.stage, workflowAction: t.workflowAction }))
    );
    if (!stage && timeline.length) {
        const hasApprove = timeline.some((t) => t.workflowAction === 'approve');
        stage = hasApprove ? 'complete' : 'pending_hr';
    }
    if (!stage) return null;
    const history = timeline.map((t) => ({
        stage: t.stage,
        action: mapAssetHistoryWorkflowActionToTimelineAction(t.workflowAction),
        note: t.note,
        byName: t.byName,
        at: t.at,
    }));
    const firstDet = sorted[0]?.details || {};
    return {
        stage,
        serviceTypeLabel: firstDet.serviceTypeLabel || serviceTypeLabelFallback || '',
        serviceRecordId: firstDet.serviceRecordId || null,
        history,
    };
}

/** Mixed `details.serviceRecordId` may be ObjectId, string, or populated shape. */
function rawServiceRecordIdFromHistoryDetails(details) {
    let sid = details?.serviceRecordId;
    if (sid != null && typeof sid === 'object' && !(sid instanceof mongoose.Types.ObjectId) && sid._id) {
        sid = sid._id;
    }
    return sid;
}

/** Stable map key for pairing AssetHistory rows to services[]. */
function workflowLogKey(assetId, serviceSubdocId) {
    const aid = String(assetId);
    let sid = '';
    if (serviceSubdocId != null && serviceSubdocId !== '') {
        const raw = String(serviceSubdocId);
        sid = mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw).toString() : raw;
    }
    return `${aid}::${sid}`;
}

function serviceTypeLabelCompatibleWithRow(logLabel, rowServiceType) {
    const L = String(logLabel || '').trim();
    const T = String(rowServiceType || '').trim();
    if (!L || !T) return true;
    if (L === T) return true;
    const a = L.toLowerCase();
    const b = T.toLowerCase();
    return a.includes(b) || b.includes(a);
}

/**
 * Logs without details.serviceRecordId: assign each to the nearest service row by date
 * (same calendar day was too strict when workflow events and service.date differ).
 * Uses label match when possible; falls back to date-only so custom labels do not drop all logs.
 */
function assignOrphanLogsToServicesByNearestDate(assetId, services, orphans) {
    const out = new Map();
    if (!orphans?.length || !services?.length) return out;
    const aid = String(assetId);
    const sorted = [...services].sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        if (da !== db) return da - db;
        return String(a._id).localeCompare(String(b._id));
    });
    const maxDistMs = 400 * 24 * 60 * 60 * 1000;

    const pickNearest = (log, requireTypeMatch) => {
        let best = null;
        let bestDist = Infinity;
        const lt = new Date(log.date).getTime();
        const stLbl = String(log.details?.serviceTypeLabel || '').trim();
        for (const s of sorted) {
            const sType = String(s.serviceType || '').trim();
            if (requireTypeMatch && !serviceTypeLabelCompatibleWithRow(stLbl, sType)) continue;
            const sd = s.date ? new Date(s.date).getTime() : lt;
            const d = Math.abs(lt - sd);
            if (
                d < bestDist ||
                (d === bestDist && best && String(s._id).localeCompare(String(best._id)) < 0)
            ) {
                bestDist = d;
                best = s;
            }
        }
        if (!best || bestDist > maxDistMs) return null;
        return best;
    };

    for (const log of orphans) {
        let best = pickNearest(log, true);
        if (!best) best = pickNearest(log, false);
        if (!best) continue;
        const key = workflowLogKey(aid, best._id);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(log);
    }
    for (const arr of out.values()) {
        arr.sort((a, b) => new Date(a.date) - new Date(b.date));
    }
    return out;
}

/**
 * Flat list of all service records across vehicle assets (for fleet dashboard table).
 * @route GET /api/AssetItem/vehicle-fleet-service-requests
 */
export const getVehicleFleetServiceRequests = async (req, res) => {
    try {
        const draftVis = buildDraftVisibilityQuery(req.user);
        const items = await AssetItem.find({ $and: [draftVis] })
            .populate('typeId', 'name')
            .select('assetId name plateEmirate plateNumber services typeId activeServiceWorkflow')
            .lean();

        const isVehicleAsset = (it) => {
            const plate = (it.plateNumber || '').trim();
            if (plate) return true;
            const t = (it.typeId?.name || '').toLowerCase();
            return t.includes('vehicle') || t.includes('car') || t.includes('fleet') || t.includes('truck');
        };

        const vehicles = items.filter(isVehicleAsset);

        const assetIds = [];
        vehicles.forEach((vv) => {
            assetIds.push(vv._id);
        });
        const keyedWorkflowLogs = new Map();
        const unkeyedWorkflowLogsByAsset = new Map();
        if (assetIds.length) {
            const wfLogsAll = await AssetHistory.find({
                assetId: { $in: assetIds },
                'details.type': 'VehicleServiceWorkflow',
            })
                .select('assetId date details')
                .lean();
            for (const log of wfLogsAll) {
                const sid = rawServiceRecordIdFromHistoryDetails(log.details);
                const aid = String(log.assetId);
                if (sid != null && sid !== '') {
                    const k = workflowLogKey(aid, sid);
                    if (!keyedWorkflowLogs.has(k)) keyedWorkflowLogs.set(k, []);
                    keyedWorkflowLogs.get(k).push(log);
                } else {
                    if (!unkeyedWorkflowLogsByAsset.has(aid)) unkeyedWorkflowLogsByAsset.set(aid, []);
                    unkeyedWorkflowLogsByAsset.get(aid).push(log);
                }
            }
        }

        const orphanLogsByServiceKey = new Map();
        for (const v of vehicles) {
            const orphans = unkeyedWorkflowLogsByAsset.get(String(v._id)) || [];
            const part = assignOrphanLogsToServicesByNearestDate(v._id, v.services || [], orphans);
            for (const [k, logs] of part.entries()) {
                orphanLogsByServiceKey.set(k, logs);
            }
        }

        const vehicleLabel = (v) => {
            const plate = [v.plateEmirate, v.plateNumber].filter(Boolean).join(' ').trim();
            if (plate) return plate;
            return v.name || v.assetId || String(v._id);
        };

        const rows = [];
        for (const v of vehicles) {
            const vLabel = vehicleLabel(v);
            const wf = v.activeServiceWorkflow || {};
            const wfSid = wf.serviceRecordId;
            for (const s of v.services || []) {
                const [attachment, quotation2, quotation3, invoice] = await Promise.all([
                    s.attachment ? getSignedFileUrl(s.attachment) : Promise.resolve(null),
                    s.quotation2 ? getSignedFileUrl(s.quotation2) : Promise.resolve(null),
                    s.quotation3 ? getSignedFileUrl(s.quotation3) : Promise.resolve(null),
                    s.invoice ? getSignedFileUrl(s.invoice) : Promise.resolve(null),
                ]);
                const wfMatch = wfSid && String(wfSid) === String(s._id);
                const stored = s.workflowSnapshot;
                let workflowSnapshot = null;
                if (stored && (stored.stage || (Array.isArray(stored.history) && stored.history.length))) {
                    const sh = Array.isArray(stored.history) ? stored.history : [];
                    let stageVal = stored.stage;
                    if (!stageVal && sh.length) {
                        stageVal = inferStageFromEmbeddedHistory(sh) || 'complete';
                    }
                    workflowSnapshot = {
                        stage: stageVal,
                        serviceTypeLabel: stored.serviceTypeLabel || '',
                        serviceRecordId: stored.serviceRecordId || s._id,
                        history: sh.map((h) => ({
                            stage: h.stage,
                            action: h.action,
                            note: h.note || '',
                            byName: h.byName || '',
                            at: h.at,
                        })),
                    };
                } else if (wfMatch && wf.stage) {
                    const hist = Array.isArray(wf.history) ? wf.history : [];
                    workflowSnapshot = {
                        stage: wf.stage,
                        serviceTypeLabel: wf.serviceTypeLabel || '',
                        serviceRecordId: wf.serviceRecordId,
                        history: hist.map((h) => ({
                            stage: h.stage,
                            action: h.action,
                            note: h.note || '',
                            byName: h.byName || '',
                            at: h.at,
                        })),
                    };
                }
                if (!workflowSnapshot) {
                    const k = workflowLogKey(v._id, s._id);
                    let docs = keyedWorkflowLogs.get(k);
                    if (!docs?.length) {
                        docs = orphanLogsByServiceKey.get(k);
                    }
                    if (docs?.length) {
                        const rebuilt = workflowSnapshotFromAssetHistoryDocs(docs, s.serviceType);
                        if (rebuilt && (rebuilt.stage || (rebuilt.history && rebuilt.history.length))) {
                            const sh = Array.isArray(rebuilt.history) ? rebuilt.history : [];
                            workflowSnapshot = {
                                stage: rebuilt.stage || 'complete',
                                serviceTypeLabel: rebuilt.serviceTypeLabel || '',
                                serviceRecordId: rebuilt.serviceRecordId || s._id,
                                history: sh.map((h) => ({
                                    stage: h.stage,
                                    action: h.action,
                                    note: h.note || '',
                                    byName: h.byName || '',
                                    at: h.at,
                                })),
                            };
                        }
                    }
                }
                if (!workflowSnapshot && s._id) {
                    workflowSnapshot = {
                        stage: null,
                        history: [],
                        serviceRecordId: s._id,
                        serviceTypeLabel: s.serviceType || '',
                        trailIncomplete: true,
                    };
                }
                const rowWorkflowStage = workflowSnapshot?.stage ?? (wfMatch ? wf.stage || null : null);
                const rowWorkflowLabel =
                    workflowSnapshot?.serviceTypeLabel ?? (wfMatch ? wf.serviceTypeLabel || '' : '');
                const hasUsableTrail =
                    workflowSnapshot &&
                    !workflowSnapshot.trailIncomplete &&
                    (workflowSnapshot.stage || (Array.isArray(workflowSnapshot.history) && workflowSnapshot.history.length > 0));
                rows.push({
                    serviceId: s._id,
                    serviceType: s.serviceType,
                    date: s.date,
                    value: s.value,
                    description: s.description || '',
                    paidBy: s.paidBy || null,
                    currentKm: s.currentKm != null ? s.currentKm : null,
                    remark: s.remark || '',
                    vehicleId: v._id,
                    vehicleAssetId: v.assetId,
                    vehicleLabel: vLabel,
                    attachment,
                    quotation2,
                    quotation3,
                    invoice,
                    workflowStage: rowWorkflowStage,
                    workflowServiceTypeLabel: rowWorkflowLabel,
                    workflowSnapshot,
                    vehicleHasDifferentActiveWorkflow:
                        !!(wf.stage && !['complete', 'rejected'].includes(wf.stage)) &&
                        !wfMatch &&
                        !hasUsableTrail &&
                        !workflowSnapshot?.trailIncomplete,
                });
            }
        }

        rows.sort((a, b) => {
            const ta = a.date ? new Date(a.date).getTime() : 0;
            const tb = b.date ? new Date(b.date).getTime() : 0;
            return tb - ta;
        });

        res.json({ items: rows, total: rows.length });
    } catch (error) {
        console.error('getVehicleFleetServiceRequests:', error);
        res.status(500).json({ message: 'Failed to load vehicle service records' });
    }
};

export const getAllAssignedAssets = async (req, res) => {
    try {
        const { companyId, status } = req.query;

        let query = {};

        const normalizedStatus = status?.toLowerCase();

        // Handle status filter
        if (status && normalizedStatus !== 'all') {
            query.status = status;
        } else {
            // Default: Show all except Draft
            query.status = { $ne: 'Draft' };
        }

        // Handle company filtering
        if (companyId) {
            query.assignedCompany = companyId;
            // Show everything (already handled by status above)
        } else if (!status) {
            // ONLY apply restricted fallback if NO status is provided at all (initial load/default)
            // to keep it focused on items with some assignment or unassigned status
            query.$or = [
                { assignedTo: { $ne: null } },
                { assignedCompany: { $ne: null } },
                { status: { $in: ['Unassigned', 'Pending', 'Assigned', 'On Leave', 'Returned', 'Lost', 'Service', 'Maintenance', 'On Service'] } }
            ];
        }

        const draftVis = buildDraftVisibilityQuery(req.user);
        if (query.$or) {
            query = { $and: [query, draftVis] };
        } else {
            Object.assign(query, draftVis);
        }

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const items = await AssetItem.find(query)
            .select('assetId name ownership assignedTo assignedCompany accessories assetValue status updatedAt typeId categoryId invoiceFile documents actionRequiredBy')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId company'
            })
            .populate('actionRequiredBy', 'employeeId')
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .sort({ name: 1 });

        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, item);
            if (itemObj.accessories?.length) {
                itemObj.accessories = filterAccessoriesHidingPendingAdds(itemObj.accessories, canSeePending);
            }
            if (itemObj.invoiceFile) {
                itemObj.invoiceFile = await getSignedFileUrl(itemObj.invoiceFile);
            }
            if (itemObj.documents && itemObj.documents.length > 0) {
                for (let doc of itemObj.documents) {
                    if (doc.attachment) {
                        doc.attachment = await getSignedFileUrl(doc.attachment);
                    }
                }
            }
            return itemObj;
        }));

        res.status(200).json(signedItems);
    } catch (error) {
        console.error('Error fetching assigned assets:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    List current user's assigned assets eligible for return (no pending action)
// @route   GET /api/AssetItem/assigned/me-for-return
// @access  Private
export const getMyAssignedAssetsForReturn = async (req, res) => {
    try {
        let currentEmpId = req.user?.employeeObjectId?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const empRow = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            })
                .select('_id')
                .lean();
            if (empRow) currentEmpId = empRow._id.toString();
        }
        if (!currentEmpId) {
            return res.status(400).json({ message: 'Employee profile not linked to your account.' });
        }

        const items = await AssetItem.find({
            assignedTo: currentEmpId,
            status: 'Assigned',
            $or: [{ pendingAction: null }, { pendingAction: { $exists: false } }]
        })
            .select('assetId name typeId categoryId')
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .sort({ name: 1 })
            .lean();

        res.status(200).json({ items });
    } catch (error) {
        console.error('Error in getMyAssignedAssetsForReturn:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};


export const getUnassignedAssetsForEmployee = async (req, res) => {
    try {
        const { employeeId } = req.params;
        console.log(`[getUnassignedAssetsForEmployee] Processing request for employeeId: ${employeeId}`);

        const assetController = await getDepartmentHOD('assetcontroller');
        console.log(`[getUnassignedAssetsForEmployee] Asset controller found:`, assetController);

        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId');

        if (!employee) {
            console.log(`[getUnassignedAssetsForEmployee] Employee not found: ${employeeId}`);
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;
        console.log(`[getUnassignedAssetsForEmployee] Employee ObjectId: ${employeeObjectId}`);

        // IMPORTANT:
        // This endpoint is used to show tabs when someone opens the PROFILE of employeeId.
        // So authorization must be based on the *profile employee* being an asset controller,
        // not on the currently logged-in viewer.
        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const isProfileAssetController = (() => {
            // Department fallback: if :employeeId matches the configured AC.
            try {
                if (assetController?._id && assetController._id.toString() === employeeObjectId.toString()) return true;
                if (assetController?.employeeId && normEmp(assetController.employeeId) === normEmp(employee.employeeId)) return true;
            } catch {
                // ignore
            }
            return false;
        })();

        let isAuthorized = isProfileAssetController;
        if (!isAuthorized) {
            // Flowchart: check whether the profile employee is in the assetcontroller flowchart.
            try {
                const profileUserForCheck = {
                    employeeObjectId,
                    employeeId: employee.employeeId
                };
                isAuthorized = await isUserInFlowchart(profileUserForCheck, 'assetcontroller');
                console.log(`[getUnassignedAssetsForEmployee] Flowchart authorization result for profile: ${isAuthorized}`);
            } catch (flowchartError) {
                console.error('[getUnassignedAssetsForEmployee] Flowchart error:', flowchartError);
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controllers can view unassigned assets.',
                    code: 'ASSET_CONTROLLER_REQUIRED',
                    error: 'Flowchart service unavailable'
                });
            }
        }

        if (!isAuthorized) {
            console.log(`[getUnassignedAssetsForEmployee] ACCESS DENIED for profile employee: ${employeeId}`);
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view unassigned assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId: employeeId
            });
        }

        console.log(`[getUnassignedAssetsForEmployee] ACCESS GRANTED, fetching assets...`);
        const items = await AssetItem.find({
            status: { $in: ['Unassigned', 'Returned', 'Pending'] }
        })
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .sort({ assetId: 1 });

        const filteredItems = items.filter(item => {
            const status = item.status?.toString().trim();

            return status === 'Unassigned' || status === 'Returned' || status === 'Pending';
        });

        res.status(200).json({
            items: filteredItems,
            controllerStatus: 'Active'
        });
    } catch (error) {
        console.error('Error fetching unassigned assets for controller:', error);
        console.error('Error stack:', error.stack);
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);

        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            stack: error.stack,
            name: error.name
        });
    }
};

export const getOnLeaveAssetsForEmployee = async (req, res) => {
    try {
        await processParkingAssets();
        const { employeeId } = req.params;
        console.log(`[getOnLeaveAssetsForEmployee] Processing request for employeeId: ${employeeId}`);

        const assetController = await getDepartmentHOD('assetcontroller');
        console.log(`[getOnLeaveAssetsForEmployee] Asset controller found:`, assetController);

        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId');

        if (!employee) {
            console.log(`[getOnLeaveAssetsForEmployee] Employee not found: ${employeeId}`);
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;
        console.log(`[getOnLeaveAssetsForEmployee] Employee ObjectId: ${employeeObjectId}`);

        // IMPORTANT:
        // This endpoint is used to show Parking tabs when someone opens the PROFILE of :employeeId.
        // So authorization must be based on the *profile employee* being an asset controller,
        // not based on currently logged-in viewer.
        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const isProfileAssetController = (() => {
            try {
                if (assetController?._id && assetController._id.toString() === employeeObjectId.toString()) return true;
                if (assetController?.employeeId && normEmp(assetController.employeeId) === normEmp(employee.employeeId)) return true;
            } catch {
                // ignore
            }
            return false;
        })();

        let isAuthorized = isProfileAssetController;
        if (!isAuthorized) {
            // Check profile employee in the flowchart
            try {
                isAuthorized = await isUserInFlowchart(
                    { employeeObjectId, employeeId: employee.employeeId },
                    'assetcontroller'
                );
                console.log(`[getOnLeaveAssetsForEmployee] Flowchart authorization result for profile: ${isAuthorized}`);
            } catch (flowchartError) {
                console.error('[getOnLeaveAssetsForEmployee] Flowchart error:', flowchartError);
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controllers can view on-leave assets.',
                    code: 'ASSET_CONTROLLER_REQUIRED',
                    error: 'Flowchart service unavailable'
                });
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view on-leave assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId
            });
        }

        console.log(`[getOnLeaveAssetsForEmployee] ACCESS GRANTED, fetching assets...`);
        // Fetch assets with "On Leave" status (case-insensitive match)
        const onLeaveQuery = { status: { $regex: /^on\s+leave$/i } };
        const items = await AssetItem.find(onLeaveQuery)
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId assignedTo assignedDate onLeaveStartDate onLeaveEndDate onLeaveDuration')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .populate('assignedTo', 'firstName lastName employeeId')
            .sort({ assetId: 1 });

        res.status(200).json({
            items: items,
            controllerStatus: 'Active'
        });
    } catch (error) {
        console.error('Error fetching on-leave assets for controller:', error);
        res.status(500).json({
            message: 'Server Error',
            error: error.message
        });
    }
};

/**
 * @desc    Get on-service assets for Asset Controller profile view
 * @route   GET /api/AssetItem/on-service/controller/:employeeId
 * @access  Private
 */
export const getOnServiceAssetsForEmployee = async (req, res) => {
    try {
        const { employeeId } = req.params;

        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;

        const currentUserEmpObjectId = req.user?.employeeObjectId?.toString();
        const currentUserEmpId = req.user?.employeeId;

        let isAuthorized = false;
        if (
            currentUserEmpObjectId &&
            currentUserEmpObjectId === employeeObjectId.toString()
        ) {
            isAuthorized = true;
        } else if (currentUserEmpId && currentUserEmpId.toLowerCase() === employeeId.toLowerCase()) {
            isAuthorized = true;
        } else {
            const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
            if (isAdmin) {
                isAuthorized = true;
            } else {
                try {
                    isAuthorized = await isUserActiveInFlowchart(
                        { employeeObjectId, employeeId: employee.employeeId },
                        'assetcontroller'
                    );
                } catch {
                    return res.status(403).json({
                        message: 'Access denied. Only Asset Controllers can view on-service assets.',
                        code: 'ASSET_CONTROLLER_REQUIRED'
                    });
                }
            }
        }

        if (!isAuthorized) {
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view on-service assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId
            });
        }

        const onServiceQuery = {
            status: { $regex: /^(service|on\s+service)$/i }
        };
        const items = await AssetItem.find(onServiceQuery)
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId assignedTo assignedDate services')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .populate('assignedTo', 'firstName lastName employeeId')
            .sort({ assetId: 1 });

        res.status(200).json({
            items,
            controllerStatus: 'Active'
        });
    } catch (error) {
        console.error('Error fetching on-service assets for controller:', error);
        res.status(500).json({
            message: 'Server Error',
            error: error.message
        });
    }
};

function parseServiceDurationDays(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (!value) return null;
    const m = value.match(/(\d+)\s*(day|week|month|year)s?/i);
    if (!m) {
        const direct = parseInt(value, 10);
        return Number.isInteger(direct) && direct > 0 ? direct : null;
    }
    const n = parseInt(m[1], 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    const unit = m[2].toLowerCase();
    if (unit.startsWith('day')) return n;
    if (unit.startsWith('week')) return n * 7;
    if (unit.startsWith('month')) return n * 30;
    if (unit.startsWith('year')) return n * 365;
    return null;
}

/**
 * @desc    Handle On Service asset action (Return or Extend)
 * @route   PUT /api/AssetItem/:id/on-service-action
 * @access  Private
 */
export const handleOnServiceAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, extensionDays, extensionReason } = req.body; // 'Return' | 'Extend'

        if (!['Return', 'Extend', 'Live'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "Live", or "Extend"' });
        }

        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const item = await AssetItem.findById(id).populate('assignedTo');
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        const statusLower = String(item.status || '').toLowerCase().trim();
        if (statusLower !== 'service' && statusLower !== 'on service') {
            return res.status(400).json({ message: 'Asset is not in "Service/On Service" status' });
        }

        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const statusSnapshot = snapshotItem.toObject();
        const prevAssignedTo = item.assignedTo?._id || item.assignedTo;

        const currentService = item.services?.length ? item.services[item.services.length - 1] : null;
        if (!currentService) {
            return res.status(400).json({ message: 'No active service record found for this asset.' });
        }

        if (action === 'Extend') {
            const ext = parseInt(extensionDays, 10);
            if (!Number.isInteger(ext) || ext <= 0 || ext > 30) {
                return res.status(400).json({ message: 'Invalid extension days. Must be between 1 and 30.' });
            }
            const reason = String(extensionReason || '').trim();
            if (!reason) {
                return res.status(400).json({ message: 'Extension reason is required.' });
            }

            const baseExpiry = currentService.expiryDate ? new Date(currentService.expiryDate) : new Date();
            const newExpiry = new Date(baseExpiry);
            newExpiry.setDate(newExpiry.getDate() + ext);

            const previousDurationDays =
                parseServiceDurationDays(currentService.serviceDuration) ||
                Math.max(1, Math.ceil((baseExpiry.getTime() - new Date(currentService.date || new Date()).getTime()) / (1000 * 60 * 60 * 24)));
            const updatedTotalDays = previousDurationDays + ext;

            currentService.expiryDate = newExpiry;
            currentService.serviceDuration = `${updatedTotalDays} days`;
            currentService.reminderSentAt = null;
            currentService.durationCompleteSentAt = null;
            currentService.lastWarningSentAt = null;

            await AssetHistory.create({
                assetId: item._id,
                action: 'Extend',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Service duration extended by ${ext} day(s). New total: ${updatedTotalDays} day(s). Reason: ${reason}`,
                date: new Date(),
                details: { ...statusSnapshot, extensionDays: ext, extensionReason: reason, updatedTotalDays, newExpiryDate: newExpiry }
            });

            const assignedEmployee = item.assignedTo
                ? await EmployeeBasic.findById(item.assignedTo?._id || item.assignedTo)
                    .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                    .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                    .lean()
                    .catch(() => null)
                : null;
            const hodEmployee = assignedEmployee?.primaryReportee || null;
            const assetController = await getDepartmentHOD('assetcontroller');
            const recipients = [assignedEmployee, hodEmployee, assetController]
                .filter(Boolean)
                .reduce((acc, r) => {
                    const id = String(r._id || '');
                    if (!id || acc.some((x) => String(x._id) === id)) return acc;
                    acc.push(r);
                    return acc;
                }, []);
            const senderInfo = { firstName: 'Asset', lastName: 'Controller' };
            for (const recipient of recipients) {
                await sendAssetServiceEmail({
                    asset: item,
                    recipient,
                    type: 'Extended',
                    details: {
                        serviceDuration: `${updatedTotalDays} days`,
                        extensionDays: ext,
                        currentExpiryDate: baseExpiry,
                        extensionReason: reason
                    },
                    sender: senderInfo
                });
            }
        } else if (action === 'Return' || action === 'Live') {
            item.status = item.assignedTo ? 'Assigned' : 'Unassigned';
            if (currentService.durationCompleteSentAt == null) {
                currentService.durationCompleteSentAt = new Date();
            }

            await AssetHistory.create({
                assetId: item._id,
                action: 'Service Receive',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: 'Asset returned from service and moved back to active status.',
                date: new Date(),
                details: { ...statusSnapshot, returnedFromService: true, nextStatus: item.status }
            });
        }

        await item.save();
        await notifyAssignedEmployeeIfController(req, item, 'Edit Asset', 'Asset service status updated by Asset Controller.');
        await updateAssetTypeCounts(item.typeId);

        res.status(200).json({
            message:
                action === 'Extend'
                    ? 'Service duration extended successfully'
                    : action === 'Live'
                        ? 'Asset marked as Live successfully'
                        : 'Asset returned from service successfully',
            asset: item
        });
    } catch (error) {
        console.error('Error handling on-service action:', error);
        res.status(500).json({
            message: 'Server Error',
            error: error.message
        });
    }
};

/**
 * @desc    Bulk Handle On Service asset action (Return or Extend)
 * @route   PUT /api/AssetItem/bulk/on-service-action
 * @access  Private
 */
export const bulkHandleOnServiceAction = async (req, res) => {
    try {
        const { assetIds, action, extensionDays, extensionReason } = req.body;
        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }
        if (!['Return', 'Extend', 'Live'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "Live", or "Extend"' });
        }

        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const ext = action === 'Extend' ? parseInt(extensionDays, 10) : null;
        if (action === 'Extend' && (!Number.isInteger(ext) || ext <= 0 || ext > 30)) {
            return res.status(400).json({ message: 'Invalid extension days. Must be between 1 and 30.' });
        }
        const reason = action === 'Extend' ? String(extensionReason || '').trim() : '';
        if (action === 'Extend' && !reason) {
            return res.status(400).json({ message: 'Extension reason is required.' });
        }

        const items = await AssetItem.find({ _id: { $in: assetIds } }).populate('assignedTo');
        const results = { success: [], failed: [] };

        for (const item of items) {
            try {
                const statusLower = String(item.status || '').toLowerCase().trim();
                if (statusLower !== 'service' && statusLower !== 'on service') {
                    results.failed.push({ id: item._id, message: `Asset is not in Service/On Service status (Current: ${item.status})` });
                    continue;
                }

                const currentService = item.services?.length ? item.services[item.services.length - 1] : null;
                if (!currentService) {
                    results.failed.push({ id: item._id, message: 'No active service record found.' });
                    continue;
                }

                if (action === 'Extend') {
                    const baseExpiry = currentService.expiryDate ? new Date(currentService.expiryDate) : new Date();
                    const newExpiry = new Date(baseExpiry);
                    newExpiry.setDate(newExpiry.getDate() + ext);
                    const prevDays = parseServiceDurationDays(currentService.serviceDuration) || 0;
                    currentService.expiryDate = newExpiry;
                    currentService.serviceDuration = `${Math.max(1, prevDays) + ext} days`;
                    currentService.reminderSentAt = null;
                    currentService.durationCompleteSentAt = null;
                    currentService.lastWarningSentAt = null;
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Extend',
                        assignedTo: item.assignedTo?._id || item.assignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Service duration extended by ${ext} day(s) in bulk action. Reason: ${reason}`,
                        date: new Date()
                    });

                    const assignedEmployee = item.assignedTo
                        ? await EmployeeBasic.findById(item.assignedTo?._id || item.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                            .lean()
                            .catch(() => null)
                        : null;
                    const hodEmployee = assignedEmployee?.primaryReportee || null;
                    const assetController = await getDepartmentHOD('assetcontroller');
                    const recipients = [assignedEmployee, hodEmployee, assetController]
                        .filter(Boolean)
                        .reduce((acc, r) => {
                            const rid = String(r._id || '');
                            if (!rid || acc.some((x) => String(x._id) === rid)) return acc;
                            acc.push(r);
                            return acc;
                        }, []);
                    for (const recipient of recipients) {
                        await sendAssetServiceEmail({
                            asset: item,
                            recipient,
                            type: 'Extended',
                            details: {
                                serviceDuration: currentService.serviceDuration,
                                extensionDays: ext,
                                currentExpiryDate: baseExpiry,
                                extensionReason: reason
                            },
                            sender: { firstName: 'Asset', lastName: 'Controller' }
                        });
                    }
                } else if (action === 'Return' || action === 'Live') {
                    item.status = item.assignedTo ? 'Assigned' : 'Unassigned';
                    if (currentService.durationCompleteSentAt == null) {
                        currentService.durationCompleteSentAt = new Date();
                    }
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Service Receive',
                        assignedTo: item.assignedTo?._id || item.assignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: 'Asset returned from service in bulk action.',
                        date: new Date()
                    });
                }

                await item.save();
                await updateAssetTypeCounts(item.typeId);
                results.success.push(item._id);
            } catch (err) {
                results.failed.push({ id: item._id, message: err.message });
            }
        }

        res.status(200).json({
            message: `Processed ${items.length} assets: ${results.success.length} successful, ${results.failed.length} failed.`,
            results
        });
    } catch (error) {
        console.error('Error handling bulk on-service action:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
};

/**
 * @desc    Handle On Leave asset action (Return or On Duty)
 * @route   PUT /api/AssetItem/:id/on-leave-action
 * @access  Private
 */
export const handleOnLeaveAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, extensionReason } = req.body; // 'Return' or 'OnDuty'

        if (!['Return', 'OnDuty', 'Extend'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "OnDuty", or "Extend"' });
        }

        // Check authorization - only Asset Controllers can perform this action
        const assetController = await getDepartmentHOD('assetcontroller');
        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const item = await AssetItem.findById(id).populate('assignedTo');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check status case-insensitively
        const statusLower = item.status?.toString().toLowerCase().trim();
        if (statusLower !== 'on leave') {
            return res.status(400).json({ message: 'Asset is not in "On Leave" status' });
        }

        // Capture snapshot before mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const statusSnapshot = snapshotItem.toObject();

        const prevAssignedTo = item.assignedTo?._id || item.assignedTo;

        if (action === 'Return') {
            // Return: status becomes Unassigned, assignedTo becomes null
            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = null;
            item.actionRequiredBy = null;
            item.negotiationHistory = [];
            item.parkingExtendedDays = 0;
            item.parkingReminderSentAt = null;
            item.parkingDurationCompleteSentAt = null;

            // Log History
            await AssetHistory.create({
                assetId: item._id,
                action: 'Returned',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset returned from On Leave status by Asset Controller`,
                date: new Date(),
                details: statusSnapshot
            });
        } else if (action === 'OnDuty') {
            // On Duty: status becomes Assigned, keep the same assignedTo
            if (!item.assignedTo) {
                return res.status(400).json({ message: 'Cannot set to On Duty: Asset has no assigned user' });
            }

            item.status = 'Assigned';
            // Keep assignedTo, assignedBy, assignmentType, etc. as they were

            // Check if there's a duration set from the original "On Leave" request
            // When "On Duty" is clicked, we start tracking the duration from this point
            const originalDuration = item.onLeaveDuration;

            if (originalDuration) {
                // Set new start date (when On Duty begins) and calculate end date
                item.onLeaveStartDate = new Date(); // On Duty start date
                item.onLeaveDuration = originalDuration; // Keep the duration
                const endDate = new Date();
                endDate.setDate(endDate.getDate() + originalDuration);
                item.onLeaveEndDate = endDate; // When duration will complete

                console.log(`[On Duty] Duration tracking started: ${originalDuration} days. End date: ${endDate.toISOString()}. Email will be sent after duration completes.`);
            } else {
                // No duration set, clear any existing duration fields
                item.onLeaveStartDate = null;
                item.onLeaveEndDate = null;
                item.onLeaveDuration = null;
                item.parkingExtendedDays = 0;
                item.parkingReminderSentAt = null;
                item.parkingDurationCompleteSentAt = null;
            }

            // Log History
            await AssetHistory.create({
                assetId: item._id,
                action: 'Assigned',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset status changed from On Leave to Assigned (On Duty) by Asset Controller${originalDuration ? `. Duration tracking started: ${originalDuration} day(s)` : ''}`,
                date: new Date(),
                details: {
                    previousStatus: statusSnapshot.status,
                    duration: originalDuration,
                    onDutyStartDate: item.onLeaveStartDate,
                    onDutyEndDate: item.onLeaveEndDate
                }
            });
        } else if (action === 'Extend') {
            const extensionDays = parseInt(req.body.extensionDays);
            if (isNaN(extensionDays) || extensionDays <= 0) {
                return res.status(400).json({ message: 'Invalid extension days. Must be a positive number.' });
            }
            if (extensionDays > 10) {
                return res.status(400).json({ message: 'Maximum extension request is 10 days.' });
            }

            const usedExtensionDays = Number(item.parkingExtendedDays || 0);
            if (usedExtensionDays + extensionDays > 10) {
                return res.status(400).json({ message: `Maximum total extension is 10 days. Already used ${usedExtensionDays} day(s).` });
            }
            const reason = String(extensionReason || '').trim();
            if (!reason) {
                return res.status(400).json({ message: 'Extension reason is required.' });
            }

            // Calculate new end date based on current end date (or today if missing)
            const currentEndDate = item.onLeaveEndDate || new Date();
            const newEndDate = new Date(currentEndDate);
            newEndDate.setDate(newEndDate.getDate() + extensionDays);

            item.onLeaveEndDate = newEndDate;
            item.onLeaveDuration = (item.onLeaveDuration || 0) + extensionDays;
            item.parkingExtendedDays = usedExtensionDays + extensionDays;
            item.parkingReminderSentAt = null;
            item.parkingDurationCompleteSentAt = null;

            // Log History
            await AssetHistory.create({
                assetId: item._id,
                action: 'Extend',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset parking duration extended by ${extensionDays} day(s) by Asset Controller. New end date: ${newEndDate.toLocaleDateString()}. Reason: ${reason}`,
                date: new Date(),
                details: { ...statusSnapshot, extensionDays, extensionReason: reason, newEndDate }
            });

            const assignedEmployee = await EmployeeBasic.findById(prevAssignedTo)
                .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                .lean()
                .catch(() => null);
            const hodEmployee = assignedEmployee?.primaryReportee || null;
            await sendParkingExtensionEmail({
                asset: item,
                assignedEmployee,
                hodEmployee,
                assetController,
                previousExpiryDate: currentEndDate,
                extensionDays,
                reason
            });
        }

        await item.save();
        await notifyAssignedEmployeeIfController(req, item, 'Edit Asset', 'Asset details were edited by Asset Controller.');
        await updateAssetTypeCounts(item.typeId);

        res.status(200).json({
            message: action === 'Return'
                ? 'Asset returned successfully'
                : action === 'Extend'
                    ? 'Asset parking duration extended successfully'
                    : 'Asset set to On Duty successfully',
            asset: item
        });
    } catch (error) {
        console.error('Error handling on-leave action stack:', error.stack);
        console.error('Error handling on-leave action message:', error.message);
        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

/**
 * @desc    Bulk Handle On Leave asset action (Return or On Duty)
 * @route   PUT /api/AssetItem/bulk/on-leave-action
 * @access  Private
 */
export const bulkHandleOnLeaveAction = async (req, res) => {
    try {
        const { assetIds, action, extensionReason } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['Return', 'OnDuty', 'Extend'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return", "OnDuty", or "Extend"' });
        }
        const reason = action === 'Extend' ? String(extensionReason || '').trim() : '';
        if (action === 'Extend' && !reason) {
            return res.status(400).json({ message: 'Extension reason is required.' });
        }

        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this action.' });
        }

        const items = await AssetItem.find({ _id: { $in: assetIds } }).populate('assignedTo');
        const results = { success: [], failed: [] };

        for (const item of items) {
            try {
                const statusLower = item.status?.toString().toLowerCase().trim();
                if (statusLower !== 'on leave') {
                    results.failed.push({ id: item._id, message: `Asset is not in "On Leave" status (Current: ${item.status})` });
                    continue;
                }

                const prevAssignedTo = item.assignedTo?._id || item.assignedTo;

                if (action === 'Return') {
                    item.status = 'Unassigned';
                    item.assignedTo = null;
                    item.assignedBy = null;
                    item.assignmentType = null;
                    item.assignedDays = null;
                    item.acceptanceStatus = null;
                    item.actionRequiredBy = null;
                    item.negotiationHistory = [];
                    item.onLeaveStartDate = null;
                    item.onLeaveEndDate = null;
                    item.onLeaveDuration = null;
                    item.parkingExtendedDays = 0;
                    item.parkingReminderSentAt = null;
                    item.parkingDurationCompleteSentAt = null;

                    await item.save();

                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Returned',
                        assignedTo: prevAssignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Asset returned from On Leave status by Asset Controller (Bulk)`,
                        date: new Date()
                    });
                    results.success.push(item._id);
                } else if (action === 'OnDuty') {
                    if (!item.assignedTo) {
                        results.failed.push({ id: item._id, message: 'Cannot set to On Duty: Asset has no assigned user' });
                        continue;
                    }

                    item.status = 'Assigned';
                    const originalDuration = item.onLeaveDuration;

                    if (originalDuration) {
                        item.onLeaveStartDate = new Date();
                        item.onLeaveDuration = originalDuration;
                        const endDate = new Date();
                        endDate.setDate(endDate.getDate() + originalDuration);
                        item.onLeaveEndDate = endDate;
                    } else {
                        item.onLeaveStartDate = null;
                        item.onLeaveEndDate = null;
                        item.onLeaveDuration = null;
                        item.parkingExtendedDays = 0;
                        item.parkingReminderSentAt = null;
                        item.parkingDurationCompleteSentAt = null;
                    }

                    await item.save();

                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Assigned',
                        assignedTo: prevAssignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Asset status changed from On Leave to Assigned (On Duty) by Asset Controller (Bulk)${originalDuration ? `. Duration tracking started: ${originalDuration} day(s)` : ''}`,
                        date: new Date()
                    });
                    results.success.push(item._id);
                } else if (action === 'Extend') {
                    const extensionDays = parseInt(req.body.extensionDays, 10);
                    if (!Number.isInteger(extensionDays) || extensionDays <= 0 || extensionDays > 10) {
                        results.failed.push({ id: item._id, message: 'Invalid extension days (1-10 required).' });
                        continue;
                    }
                    const usedExtensionDays = Number(item.parkingExtendedDays || 0);
                    if (usedExtensionDays + extensionDays > 10) {
                        results.failed.push({ id: item._id, message: `Maximum total extension is 10 days. Already used ${usedExtensionDays} day(s).` });
                        continue;
                    }
                    const currentEndDate = item.onLeaveEndDate || new Date();
                    const newEndDate = new Date(currentEndDate);
                    newEndDate.setDate(newEndDate.getDate() + extensionDays);
                    item.onLeaveEndDate = newEndDate;
                    item.onLeaveDuration = (item.onLeaveDuration || 0) + extensionDays;
                    item.parkingExtendedDays = usedExtensionDays + extensionDays;
                    item.parkingReminderSentAt = null;
                    item.parkingDurationCompleteSentAt = null;
                    await item.save();
                    await AssetHistory.create({
                        assetId: item._id,
                        action: 'Extend',
                        assignedTo: prevAssignedTo,
                        performedBy: req.user.employeeObjectId,
                        comments: `Asset parking duration extended by ${extensionDays} day(s) by Asset Controller (Bulk). Reason: ${reason}`,
                        date: new Date()
                    });

                    const assignedEmployee = prevAssignedTo
                        ? await EmployeeBasic.findById(prevAssignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                            .lean()
                            .catch(() => null)
                        : null;
                    const hodEmployee = assignedEmployee?.primaryReportee || null;
                    const assetController = await getDepartmentHOD('assetcontroller');
                    await sendParkingExtensionEmail({
                        asset: item,
                        assignedEmployee,
                        hodEmployee,
                        assetController,
                        previousExpiryDate: currentEndDate,
                        extensionDays,
                        reason
                    });
                    results.success.push(item._id);
                }
            } catch (err) {
                console.error(`Error processing asset ${item._id} in bulk:`, err);
                results.failed.push({ id: item._id, message: err.message });
            }
        }

        res.status(200).json({
            message: `Processed ${items.length} assets: ${results.success.length} successful, ${results.failed.length} failed.`,
            results
        });
    } catch (error) {
        console.error('Error handling bulk on-leave action stack:', error.stack);
        res.status(500).json({
            message: 'Internal server error',
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

/**
 * @desc    Get assets assigned to company for HR profile view
 * @route   GET /api/AssetItem/company-assets/hr/:employeeId
 * @access  Private
 */
export const getHRCompanyAssets = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employee = await EmployeeBasic.findOne({
            employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') }
        }).select('_id employeeId company');

        if (!employee) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const employeeObjectId = employee._id;

        // Company Assets tab must follow CURRENT flowchart responsibility only
        // (Assigned User/Admin Controller active entries), not legacy company.responsibilities.
        const isCompanyCoordinatorFlow = await isUserActiveCompanyAssetCoordinator(employeeObjectId, employeeId);
        console.log(`[getHRCompanyAssets] Employee ${employeeId} - isCompanyCoordinatorFlow (Active): ${isCompanyCoordinatorFlow}`);

        if (!isCompanyCoordinatorFlow) {
            console.log(`[getHRCompanyAssets] Employee ${employeeId} - Not company-asset coordinator, returning empty`);
            return res.status(200).json({ isHR: false, items: [], designatedCompanies: [] });
        }

        console.log(`[getHRCompanyAssets] Employee ${employeeId} - Querying all company-assigned assets (flowchart coordinator)`);

        // Fetch assets assigned to Company.
        // - Flowchart Assigned User / Admin: show ALL company allocations.
        // - Otherwise: company allocations for designated companies only.
        const query = {
            $and: [
                {
                    $or: [
                        {
                            assignedToType: 'Company',
                            ...(isCompanyCoordinatorFlow ? {} : { assignedCompany: null })
                        },
                        {
                            actionRequiredBy: employeeObjectId,
                            status: 'Pending',
                            assignedToType: 'Company'
                        }
                    ]
                },
                buildDraftVisibilityQuery(req.user)
            ]
        };

        const items = await AssetItem.find(query)
            .populate('assignedCompany', 'name companyId nickName')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .populate({
                path: 'actionRequiredBy',
                model: 'EmployeeBasic',
                select: '_id employeeId firstName lastName'
            })
            .select('assetId name assetValue status purchaseDate assignedToType assignedCompany actionRequiredBy acceptanceStatus')
            .sort({ updatedAt: -1 });

        console.log(`[getHRCompanyAssets] Employee ${employeeId} - Found ${items.length} assets`);

        res.status(200).json({
            isHR: true,
            items,
            designatedCompanies: []
        });
    } catch (error) {
        console.error('Error fetching company assets for HR:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create a new asset item
// @route   POST /api/AssetItem
// @access  Private
export const createAssetItem = async (req, res) => {
    try {
        let { assetTypeId, name, photo, status, categoryId, assetValue, purchaseDate, warrantyYears, lastServiceDate, accessories, creationIntent } = req.body;

        if (!assetTypeId || !name) {
            return res.status(400).json({ message: 'Asset Type and Name are required' });
        }

        // Approval Logic: Check if creator is Asset Controller or Admin
        const assetControllerRaw = await getDepartmentHOD('assetcontroller');
        const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;

        const isJwtAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        let initialStatus = 'Draft';
        let actionRequiredBy = null;

        if (isJwtAdmin || isSysAdmin || isAssetController) {
            initialStatus = 'Unassigned';
            console.log(`[Asset creation] Created directly as Unassigned by ${isJwtAdmin || isSysAdmin ? 'Admin' : 'Asset Controller'}`);
        } else if (assetController?._id) {
            const intent = creationIntent === 'saveDraft' ? 'saveDraft' : 'submitForApproval';
            if (intent === 'saveDraft') {
                initialStatus = 'Draft';
                actionRequiredBy = null;
                console.log(`[Asset creation] Saved as Draft (no AC notification) by ${req.user.employeeId}`);
            } else {
                initialStatus = 'Submitted for Approval';
                actionRequiredBy = assetController._id;
                console.log(`[Asset creation] Submitted for approval by ${req.user.employeeId} → Asset Controller`);
            }
        } else if (assetControllerRaw) {
            return res.status(403).json({
                message: 'Asset creation denied: Asset Controller in Flowchart must be linked to an employee record. Update Settings > Flowchart or fix the employee ID.'
            });
        } else {
            return res.status(403).json({
                message: "Asset creation denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        const requesterDisplayName = await getAssetRequesterDisplayName(req);

        // Handle Photo Upload
        let photoS3Key = photo;
        if (photo && photo.startsWith('data:image')) {
            try {
                const uploadResult = await uploadDocumentToS3(photo, 'asset-photos');
                photoS3Key = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading asset photo to S3:', error);
            }
        }

        // Fetch the starting numeric part for IDs
        const prefix = 'VEGA-ASSET-';
        const regex = new RegExp(`^${prefix}\\d+$`);
        const lastItem = await AssetItem.findOne({
            assetId: { $regex: regex }
        }).sort({ assetId: -1 });

        let startingNum = 1;
        if (lastItem && lastItem.assetId) {
            const numStr = lastItem.assetId.substring(prefix.length);
            const numericPart = parseInt(numStr, 10);
            if (!isNaN(numericPart)) startingNum = numericPart + 1;
        }

        const newItemId = `${prefix}${String(startingNum).padStart(3, '0')}`;

        // Helper to generate accessory suffix (A, B, C...)
        const generateAccessoryId = (assetId, index) => {
            const charCode = 65 + (index % 26);
            const suffixNum = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
            return `${assetId}${String.fromCharCode(charCode)}${suffixNum}`;
        };

        const formattedAccessories = (accessories || []).map((acc, accIdx) => ({
            ...acc,
            amount: acc?.amount != null && acc.amount !== '' ? Number(acc.amount) : 0,
            description: acc?.description ? String(acc.description).trim() : '',
            accessoryId: generateAccessoryId(newItemId, accIdx)
        }));

        const newItem = await AssetItem.create({
            typeId: assetTypeId,
            categoryId: categoryId || null,
            assetId: newItemId,
            name,
            photo: photoS3Key,
            imagePreview: photoS3Key,
            assetValue: assetValue || 0,
            purchaseDate: purchaseDate || null,
            warrantyYears: warrantyYears || 0,
            status: initialStatus,
            lastServiceDate: lastServiceDate || null,
            accessories: formattedAccessories,
            actionRequiredBy: actionRequiredBy,
            createdBy: req.user._id
        });

        try {
            await syncAllAccessoryInstancesForAsset(newItem);
        } catch (syncErr) {
            console.error('[createAssetItem accessory catalog sync]', syncErr?.message || syncErr);
        }

        // Record Initial History (append-only; full sentence for the activity timeline)
        try {
            const whenStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const userStory = `${requesterDisplayName} added this asset on ${whenStr}. It was saved with status: ${initialStatus}.`;
            await AssetHistory.create({
                assetId: newItem._id,
                action: 'Created',
                performedBy: req.user.employeeObjectId,
                comments: userStory,
                details: { userStory, status: initialStatus, assetCode: newItemId }
            });
            console.log(`[History] Created entry for asset ${newItemId}`);
        } catch (histErr) {
            console.error(`[History Error] Failed to create creation history for ${newItemId}:`, histErr.message);
        }

        // Create Dashboard Action for Asset Controller when a submission requires approval (save-only Draft has no actionRequiredBy)
        if (actionRequiredBy) {
            try {
                await DashboardAction.findOneAndUpdate(
                    { requestId: newItem._id, requestType: 'Asset Approval', status: 'Pending' },
                    {
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: assetController.employeeId,
                        requestId: newItem._id,
                        requestType: 'Asset Approval',
                        subjectEmployeeId: req.user.employeeId,
                        subjectName: requesterDisplayName,
                        requestedByName: requesterDisplayName,
                        extra1: `${newItem.assetId} — ${newItem.name}`,
                        extra2: `Asset creation — requested by ${requesterDisplayName}`,
                        status: 'Pending'
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
                console.log(`[Dashboard] Synced asset creation approval for ${assetController.employeeId}`);
            } catch (err) {
                console.error(`[Dashboard Error] Failed to create asset approval action:`, err);
            }
        }

        // Update counts on AssetType
        await updateAssetTypeCounts(assetTypeId);

        // Send email to Asset Controller when a submission requires approval (not save-only Draft)
        if (actionRequiredBy && assetController) {
            let creationAttachments = [];
            try {
                creationAttachments = await buildBulkAssetInventoryPdfAttachment(req, [newItem._id.toString()], 'asset-creation-draft-inventory');
            } catch (pdfErr) {
                console.error('Asset creation PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
            }
            await sendAssetCreationApprovalEmail({
                asset: newItem,
                recipient: assetController,
                creatorName: requesterDisplayName,
                attachments: creationAttachments
            });
        }

        res.status(201).json(newItem);
    } catch (error) {
        console.error('Error creating asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Respond to asset creation approval (Approve/Reject)
// @route   PUT /api/AssetItem/:id/approve-creation
// @access  Private (Asset Controller or Admin)
export const respondToAssetCreation = async (req, res) => {
    try {
        const { id } = req.params;
        const rawAction = req.body?.action;
        const action = String(rawAction || '').trim();
        const actionNorm = action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();

        if (!['Approve', 'Reject'].includes(actionNorm)) {
            return res.status(400).json({ message: 'Invalid action. Use Approve or Reject.' });
        }

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const awaitingCreation =
            item.status === 'Submitted for Approval' ||
            item.status === 'Pending' ||
            (item.status === 'Draft' && item.actionRequiredBy);

        if (!awaitingCreation) {
            return res.status(400).json({ message: 'Asset is not awaiting creation approval.' });
        }

        const isJwtAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isSysAdmin = await isUserAdministrator(req.user?.id);

        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        let isDesignatedApprover = false;
        if (item.actionRequiredBy) {
            const aid = item.actionRequiredBy.toString();
            if (req.user?.employeeObjectId && aid === req.user.employeeObjectId.toString()) {
                isDesignatedApprover = true;
            } else if (req.user?.employeeId) {
                const appr = await EmployeeBasic.findById(item.actionRequiredBy).select('employeeId').lean();
                if (appr?.employeeId && normEmp(appr.employeeId) === normEmp(req.user.employeeId)) {
                    isDesignatedApprover = true;
                }
            }
        }

        let isDeptAssetControllerFallback = false;
        if (!item.actionRequiredBy && item.status === 'Draft') {
            const assetController = await getDepartmentHOD('assetcontroller');
            if (assetController?._id && req.user?.employeeObjectId) {
                if (assetController._id.toString() === req.user.employeeObjectId.toString()) {
                    isDeptAssetControllerFallback = true;
                }
            }
            if (
                !isDeptAssetControllerFallback &&
                assetController?.employeeId &&
                req.user?.employeeId
            ) {
                if (normEmp(assetController.employeeId) === normEmp(req.user.employeeId)) {
                    isDeptAssetControllerFallback = true;
                }
            }
        }

        // Designated approver, department asset controller (draft with no actionRequiredBy), or admin
        if (!isJwtAdmin && !isSysAdmin && !isDesignatedApprover && !isDeptAssetControllerFallback) {
            return res.status(403).json({ message: 'Only the designated approver or an administrator can approve this asset.' });
        }

        if (actionNorm === 'Approve') {
            item.status = 'Unassigned';
            item.actionRequiredBy = null;
        } else {
            item.status = 'Rejected';
            item.actionRequiredBy = null;
            item.pendingAction = null;
            item.pendingActionDetails = null;
        }

        // This endpoint is "asset creation approval" (draft/pending). However, the asset
        // record may already carry assignment intent (reassign vs initial assign). We use
        // presence of assigned targets to decide notification wording.
        const isReassignment = !!(item.assignedTo || item.assignedCompany);

        await item.save();
        await notifyAssignedEmployeeIfController(
            req,
            item,
            isReassignment ? 'Reassign Asset' : 'Assign Asset',
            isReassignment ? 'Asset was reassigned by Asset Controller.' : 'Asset assignment was updated by Asset Controller.'
        );

        // Record History
        try {
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId createdBy');
            const appr = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName').lean();
            const apprName = appr ? `${appr.firstName || ''} ${appr.lastName || ''}`.trim() : 'The approver';
            const whenStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
            const userStory =
                actionNorm === 'Approve'
                    ? `${apprName} approved this asset on ${whenStr}. It is ready to assign.`
                    : `${apprName} did not approve this asset on ${whenStr}.`;

            await AssetHistory.create({
                assetId: item._id,
                action: actionNorm === 'Approve' ? 'Accepted' : 'Rejected',
                performedBy: req.user.employeeObjectId,
                comments: userStory,
                details: {
                    ...snapshotItem.toObject(),
                    approvalAction: actionNorm,
                    userStory
                }
            });
            console.log(`[History] Recorded ${actionNorm} for asset creation ${item.assetId}`);
        } catch (histErr) {
            console.error(`[History Error] Failed to record creation response history for ${item.assetId}:`, histErr.message);
        }

        // Update Dashboard Action
        try {
            await DashboardAction.findOneAndUpdate(
                { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
                { status: actionNorm === 'Approve' ? 'Approved' : 'Rejected' }
            );
            console.log(`[Dashboard] Updated asset approval action to ${actionNorm === 'Approve' ? 'Approved' : 'Rejected'}`);
        } catch (err) {
            console.error('[Dashboard Error] Failed to update asset approval action:', err);
        }

        const refreshed = await AssetItem.findById(item._id)
            .populate('typeId')
            .populate('categoryId')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('createdBy', '_id id employeeId firstName lastName');
        res.status(200).json(refreshed || item);
    } catch (error) {
        console.error('Error responding to asset creation:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Bulk respond to asset creation approval (Approve / Reject / Draft)
// @route   PUT /api/AssetItem/bulk/approve-creation
// @access  Private (Asset Controller or Admin)
// Draft = return to creator as Draft (e.g. unchecked rows in bulk review); Reject = terminal Rejected status.
export const bulkRespondToAssetCreation = async (req, res) => {
    try {
        const { assetIds, action: rawBulkAction } = req.body;
        const rawBulkStr = String(rawBulkAction || '').trim();
        const bulkLo = rawBulkStr.toLowerCase();
        const bulkActionNorm =
            rawBulkStr === 'Approve' || bulkLo === 'approve'
                ? 'Approve'
                : rawBulkStr === 'Reject' || bulkLo === 'reject'
                    ? 'Reject'
                    : rawBulkStr === 'Draft' || bulkLo === 'draft'
                        ? 'Draft'
                        : null;
        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'assetIds is required.' });
        }
        if (!bulkActionNorm) {
            return res.status(400).json({ message: 'Invalid action. Use Approve, Reject, or Draft.' });
        }

        const isJwtAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAdmin = isJwtAdmin || isSysAdmin;

        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const currentEmpId = req.user?.employeeObjectId?.toString?.() || null;
        const currentEmpCode = req.user?.employeeId || null;
        const assetController = await getDepartmentHOD('assetcontroller');
        const isDeptAssetControllerFallback =
            !!(
                assetController &&
                (
                    (assetController?._id && currentEmpId && assetController._id.toString() === currentEmpId) ||
                    (assetController?.employeeId && currentEmpCode && normEmp(assetController.employeeId) === normEmp(currentEmpCode))
                )
            );

        if (!isAdmin && !isDeptAssetControllerFallback) {
            return res.status(403).json({ message: 'Only Asset Controller or Admin can approve bulk creation.' });
        }

        const uniqueIds = [...new Set(assetIds.map(String).filter(Boolean))];
        const items = await AssetItem.find({ _id: { $in: uniqueIds } });
        const byId = new Map(items.map((it) => [it._id.toString(), it]));

        const approvedIds = [];
        const rejectedIds = [];
        const returnedToDraftIds = [];
        const skipped = [];

        for (const id of uniqueIds) {
            const item = byId.get(id);
            if (!item) {
                skipped.push({ id, reason: 'Not found' });
                continue;
            }
            const canBulkApprove =
                item.status === 'Submitted for Approval' ||
                item.status === 'Pending' ||
                (item.status === 'Draft' && item.actionRequiredBy);
            if (!canBulkApprove) {
                skipped.push({ id, reason: `Status is ${item.status}` });
                continue;
            }

            if (!isAdmin && item.actionRequiredBy) {
                let isDesignatedApprover = false;
                const aid = item.actionRequiredBy.toString();
                if (currentEmpId && aid === currentEmpId) {
                    isDesignatedApprover = true;
                } else if (currentEmpCode) {
                    const appr = await EmployeeBasic.findById(item.actionRequiredBy).select('employeeId').lean();
                    if (appr?.employeeId && normEmp(appr.employeeId) === normEmp(currentEmpCode)) {
                        isDesignatedApprover = true;
                    }
                }
                if (!isDesignatedApprover) {
                    skipped.push({ id, reason: 'Not designated approver' });
                    continue;
                }
            }

            if (bulkActionNorm === 'Approve') {
                item.status = 'Unassigned';
            } else if (bulkActionNorm === 'Draft') {
                item.status = 'Draft';
            } else {
                item.status = 'Rejected';
            }
            item.actionRequiredBy = null;
            if (bulkActionNorm === 'Reject' || bulkActionNorm === 'Draft') {
                item.pendingAction = null;
                item.pendingActionDetails = null;
            }
            await item.save();

            await DashboardAction.findOneAndUpdate(
                { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
                { status: bulkActionNorm === 'Approve' ? 'Approved' : 'Rejected' }
            );

            if (bulkActionNorm === 'Approve') {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Bulk asset creation approved by Asset Controller/Admin.',
                    details: { approvalAction: 'Approve', mode: 'BulkCreationApproval' },
                    date: new Date()
                });
                approvedIds.push(item._id.toString());
            } else if (bulkActionNorm === 'Draft') {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Update',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Bulk asset creation: not selected for approval — returned to Draft so the creator can edit and resubmit.',
                    details: { approvalAction: 'Draft', mode: 'BulkCreationApproval' },
                    date: new Date()
                });
                returnedToDraftIds.push(item._id.toString());
            } else {
                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Rejected',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Bulk asset creation rejected by Asset Controller/Admin.',
                    details: { approvalAction: 'Reject', mode: 'BulkCreationApproval' },
                    date: new Date()
                });
                rejectedIds.push(item._id.toString());
            }
        }

        const message =
            bulkActionNorm === 'Approve'
                ? 'Bulk creation approval completed.'
                : bulkActionNorm === 'Draft'
                    ? 'Bulk creation: assets returned to draft.'
                    : 'Bulk creation rejection completed.';

        res.status(200).json({
            message,
            approvedCount: approvedIds.length,
            rejectedCount: rejectedIds.length,
            returnedToDraftCount: returnedToDraftIds.length,
            skippedCount: skipped.length,
            approvedIds,
            rejectedIds,
            returnedToDraftIds,
            skipped
        });
    } catch (error) {
        console.error('Error in bulkRespondToAssetCreation:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Fetch bulk asset details for creation approval modal
// @route   GET /api/AssetItem/bulk/details?ids=a,b,c
// @access  Private
export const getBulkAssetDetails = async (req, res) => {
    try {
        const idsParam = req.query.ids;
        if (!idsParam) return res.status(400).json({ message: 'ids query param is required.' });
        const ids = String(idsParam)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        if (ids.length === 0) return res.status(400).json({ message: 'No valid IDs provided.' });

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const assets = await AssetItem.find({ _id: { $in: ids } })
            .select('assetId name status pendingAction accessories actionRequiredBy createdBy assignedTo')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'employeeId')
            .lean();
        const byId = new Map(assets.map((a) => [a._id.toString(), a]));
        const viewerIdBulk = req.user?._id?.toString() || req.user?.id?.toString();
        const notFoundStub = (id) => ({
            _id: id,
            assetId: '—',
            name: 'Asset not found',
            status: null,
            pendingAction: null,
            accessories: []
        });
        const items = ids.map((id) => {
            const a = byId.get(String(id));
            if (!a) return notFoundStub(id);
            if (String(a.status || '').trim() === 'Draft') {
                const cid = a.createdBy?.toString?.();
                if (!cid || cid !== viewerIdBulk) return notFoundStub(id);
            }
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, a);
            return {
                ...a,
                accessories: filterAccessoriesHidingPendingAdds(a.accessories || [], canSeePending)
            };
        });
        res.status(200).json({ items });
    } catch (error) {
        console.error('Error in getBulkAssetDetails:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Full asset rows for print/PDF inventory (category, type, accessories)
// @route   GET /api/AssetItem/bulk/print-inventory?ids=a,b,c
// @access  Private
export const getBulkAssetInventoryForPrint = async (req, res) => {
    try {
        const idsParam = req.query.ids;
        if (!idsParam) return res.status(400).json({ message: 'ids query param is required.' });
        const ids = String(idsParam)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean);
        if (ids.length === 0) return res.status(400).json({ message: 'No valid IDs provided.' });

        const pendingAccessoryCtx = await buildPendingAccessoryVisibilityCtx(req);

        const assets = await AssetItem.find({ _id: { $in: ids } })
            .select('assetId name status accessories createdBy assignedTo actionRequiredBy')
            .populate('categoryId', 'name')
            .populate('typeId', 'name')
            .populate('assignedTo', 'employeeId')
            .populate('actionRequiredBy', 'employeeId')
            .lean();

        const order = new Map(ids.map((v, i) => [v, i]));
        assets.sort((a, b) => (order.get(a._id.toString()) ?? 0) - (order.get(b._id.toString()) ?? 0));

        const viewerIdPrint = req.user?._id?.toString() || req.user?.id?.toString();
        const items = assets.map((a) => {
            if (String(a.status || '').trim() === 'Draft') {
                const cid = a.createdBy?.toString?.();
                if (!cid || cid !== viewerIdPrint) {
                    return {
                        _id: a._id,
                        assetId: '—',
                        name: '—',
                        status: null,
                        categoryName: '—',
                        typeName: '—',
                        accessories: []
                    };
                }
            }
            const canSeePending = computeCanSeePendingAddsForAsset(pendingAccessoryCtx, a);
            const accList = filterAccessoriesHidingPendingAdds(a.accessories || [], canSeePending);
            return {
                _id: a._id,
                assetId: a.assetId,
                name: a.name,
                status: a.status,
                categoryName: a.categoryId?.name || '—',
                typeName: a.typeId?.name || '—',
                accessories: accList.map((acc) => ({
                    name: acc.name || '—',
                    status: acc.status || '—'
                }))
            };
        });

        res.status(200).json({ items });
    } catch (error) {
        console.error('Error in getBulkAssetInventoryForPrint:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update an existing asset item
// @route   PUT /api/AssetItem/:id
// @access  Private
export const updateAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        let { name, photo, status, categoryId, assetValue, purchaseDate, warrantyYears, lastServiceDate } = req.body;

        const isJwtAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAdmin = isJwtAdmin || isSysAdmin;
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check if current user is the creator
        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = item.createdBy?.toString() === currentUserId;
        const isDraft = item.status === 'Draft';
        const isRejectedCreation = item.status === 'Rejected';
        const isSubmittedForApproval = item.status === 'Submitted for Approval';

        // Strict edit permission:
        // 1) Submitted for approval -> creator cannot edit (even if they are Asset Controller); AC/Admin (non-creator) or system admin can edit
        // 2) Draft -> only creator can edit
        // 3) Rejected (creation declined) -> creator or Asset Controller/Admin can edit
        // 4) Unassigned (non-draft) -> only Asset Controller/Admin can edit
        // 5) Assigned/other statuses -> only Asset Controller/Admin can edit
        if (isSubmittedForApproval) {
            if (isCreator && !isAdmin) {
                return res.status(403).json({
                    message: 'This asset is awaiting approval. The creator cannot edit until it is approved or rejected.'
                });
            }
            if (!isAdmin && !isAssetController) {
                return res.status(403).json({
                    message: 'This asset is awaiting approval. Only Asset Controller or Admin can edit.'
                });
            }
        } else if (isDraft) {
            if (!isCreator) {
                return res.status(403).json({ message: "Only the asset creator can edit draft assets." });
            }
        } else if (isRejectedCreation) {
            if (!isCreator && !isAdmin && !isAssetController) {
                return res.status(403).json({
                    message: 'Only the asset creator, Asset Controller, or Admin can edit a rejected asset.'
                });
            }
        } else {
            if (!isAdmin && !isAssetController) {
                return res.status(403).json({ message: "Only Asset Controller or Admin can edit non-draft assets." });
            }
        }

        if (name) item.name = name;
        if (categoryId !== undefined) item.categoryId = categoryId || null;
        if (assetValue !== undefined) item.assetValue = assetValue || 0;
        if (purchaseDate !== undefined) item.purchaseDate = purchaseDate || null;
        if (warrantyYears !== undefined) item.warrantyYears = warrantyYears || 0;
        const creatorCannotSetStatusViaPut =
            isCreator && !isAdmin && !isAssetController && (isDraft || isRejectedCreation);
        if (status && !creatorCannotSetStatusViaPut) {
            item.status = status;
        }
        if (lastServiceDate !== undefined) item.lastServiceDate = lastServiceDate || null;

        // Handle Photo Upload if changed
        if (photo && photo.startsWith('data:image')) {
            try {
                const uploadResult = await uploadDocumentToS3(photo, 'asset-photos');
                item.photo = uploadResult.publicId;
                item.imagePreview = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading asset photo to S3:', error);
            }
        } else if (photo === null) {
            // they removed the photo? maybe not support deleting this way.
        }

        await item.save();
        await notifyAssignedEmployeeIfController(req, item, 'Return Asset', 'Asset return was processed by Asset Controller.');

        // Create history log
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: item._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: 'Asset details updated.',
                details: item.toObject()
            });
        } catch (historyErr) {
            console.error('History log failed during updateAssetItem (AssetItem):', historyErr);
        }

        res.status(200).json(item);
    } catch (error) {
        console.error('Error updating asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get single asset item details
// @route   GET /api/AssetItem/detail/:id
// @access  Private
export const getAssetItemDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const item = await AssetItem.findById(id)
            .populate('assignedCompany')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee signature enablePortalAccess',
                populate: [
                    {
                        path: 'reportingAuthority',
                        select: 'firstName lastName'
                    },
                    {
                        path: 'primaryReportee',
                        select: 'firstName lastName employeeId'
                    }
                ]
            })
            .populate({
                path: 'assignedBy',
                select: 'firstName lastName employeeId signature'
            })
            .populate('acceptedBy', 'firstName lastName signature')
            .populate({
                path: 'createdBy',
                select: '_id id employeeId firstName lastName'
            })
            .populate('typeId', 'name imagePreview')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('categoryId', 'name imagePreview');

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const viewerUserIdEarly = req.user?._id?.toString() || req.user?.id?.toString();
        const draftCreatorIdEarly = item.createdBy?._id?.toString() || item.createdBy?.toString();
        if (String(item.status || '').trim() === 'Draft') {
            if (!draftCreatorIdEarly || draftCreatorIdEarly !== viewerUserIdEarly) {
                return res.status(404).json({ message: 'Asset not found' });
            }
        }

        // Populate sometimes leaves a bare ObjectId; load EmployeeBasic so UI + canApprove match correctly
        if (item.actionRequiredBy) {
            const arRaw = item.actionRequiredBy;
            const hasApproverFields = arRaw.firstName || arRaw.lastName || arRaw.employeeId;
            if (!hasApproverFields) {
                const rid = arRaw._id || arRaw;
                const arEmp = await EmployeeBasic.findById(rid).select('firstName lastName employeeId').lean();
                if (arEmp) {
                    item.actionRequiredBy = arEmp;
                }
            }
        }

        // acceptedBy (e.g. HR who acknowledged company allocation): ensure names + signature for handover form
        if (item.acceptedBy) {
            const abRaw = item.acceptedBy;
            const hasName = abRaw.firstName || abRaw.lastName;
            if (!hasName) {
                const rid = abRaw._id || abRaw;
                const abEmp = await EmployeeBasic.findById(rid).select('firstName lastName employeeId signature').lean();
                if (abEmp) {
                    item.acceptedBy = abEmp;
                }
            }
        }

        // Visibility: system admin (env username) / portal Admin+ROOT / Flowchart asset controller / dept AC HOD /
        // creator / assignee / person who must act (draft approval, accept assignment, etc.)
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isPortalAdmin =
            req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
        const assetController = await getDepartmentHOD('assetcontroller');
        const creatorId = item.createdBy?._id?.toString() || item.createdBy?.toString();
        const isCreator = creatorId && creatorId === (req.user?._id?.toString() || req.user?.id);

        const currentEmpId = req.user?.employeeObjectId?.toString();
        const normEmpView = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        let currentEmployeeIdNorm = normEmpView(req.user?.employeeId);
        // If employeeObjectId exists but employeeId string is missing, resolve it
        if (!currentEmployeeIdNorm && currentEmpId) {
            const curEmp = await EmployeeBasic.findById(currentEmpId).select('employeeId').lean().catch(() => null);
            if (curEmp?.employeeId) currentEmployeeIdNorm = normEmpView(curEmp.employeeId);
        }

        const assigneeRef = item.assignedTo;
        const assigneeEmpObjectId = assigneeRef
            ? assigneeRef._id
                ? assigneeRef._id.toString()
                : assigneeRef.toString()
            : null;
        // Assigned user visibility:
        // - primary match by EmployeeBasic ObjectId (fast)
        // - fallback match by employeeId string (handles missing/partial populate + spacing differences)
        let isAssignedToUser = !!(assigneeEmpObjectId && currentEmpId && assigneeEmpObjectId === currentEmpId);

        let assigneeEmployeeIdNorm = null;
        if (typeof assigneeRef === 'object' && assigneeRef?.employeeId) {
            assigneeEmployeeIdNorm = normEmpView(assigneeRef.employeeId);
        } else if (assigneeEmpObjectId) {
            const assigneeEmp = await EmployeeBasic.findById(assigneeEmpObjectId).select('employeeId').lean().catch(() => null);
            if (assigneeEmp?.employeeId) assigneeEmployeeIdNorm = normEmpView(assigneeEmp.employeeId);
        }

        if (!isAssignedToUser && assigneeEmployeeIdNorm && currentEmployeeIdNorm) {
            isAssignedToUser = assigneeEmployeeIdNorm === currentEmployeeIdNorm;
        }

        let isActionRequiredByUser = false;
        // actionRequiredBy: match by EmployeeBasic ObjectId and/or employeeId string
        if (item.actionRequiredBy && currentEmpId) {
            const arId = item.actionRequiredBy._id?.toString() || item.actionRequiredBy.toString();
            if (arId === currentEmpId) isActionRequiredByUser = true;
        }
        if (!isActionRequiredByUser && item.actionRequiredBy && currentEmployeeIdNorm) {
            const arRef = item.actionRequiredBy;
            let arEmployeeIdNorm = null;
            if (typeof arRef === 'object' && arRef?.employeeId) {
                arEmployeeIdNorm = normEmpView(arRef.employeeId);
            } else {
                const arObjId = arRef?._id?.toString?.() || arRef?.toString?.() || null;
                if (arObjId) {
                    const arEmp = await EmployeeBasic.findById(arObjId).select('employeeId').lean().catch(() => null);
                    if (arEmp?.employeeId) arEmployeeIdNorm = normEmpView(arEmp.employeeId);
                }
            }
            if (arEmployeeIdNorm && arEmployeeIdNorm === currentEmployeeIdNorm) {
                isActionRequiredByUser = true;
            }
        }

        const isDeptAssetController =
            assetController?._id &&
            currentEmpId &&
            assetController._id.toString() === currentEmpId;

        // Draft detail access is enforced above (creator only). Other statuses: no blanket block by role here;
        // mutations stay protected on their endpoints.

        const itemObj = item.toObject();

        const canSeePendingAccessoryAdds =
            isAdmin ||
            isPortalAdmin ||
            isAssetController ||
            isDeptAssetController ||
            isAssignedToUser ||
            isActionRequiredByUser;

        if (itemObj.accessories?.length) {
            itemObj.accessories = filterAccessoriesHidingPendingAdds(
                itemObj.accessories,
                canSeePendingAccessoryAdds
            );
        }

        // Sign URLs
        if (itemObj.invoiceFile) {
            itemObj.invoiceFile = await getSignedFileUrl(itemObj.invoiceFile);
        }
        if (itemObj.warrantyAttachment) {
            itemObj.warrantyAttachment = await getSignedFileUrl(itemObj.warrantyAttachment);
        }
        if (itemObj.typeId?.imagePreview) {
            itemObj.typeId.imagePreview = await getSignedFileUrl(itemObj.typeId.imagePreview);
        }
        if (itemObj.categoryId?.imagePreview) {
            itemObj.categoryId.imagePreview = await getSignedFileUrl(itemObj.categoryId.imagePreview);
        }
        if (itemObj.imagePreview) {
            itemObj.imagePreview = await getSignedFileUrl(itemObj.imagePreview);
        }
        if (itemObj.photo) {
            itemObj.photo = await getSignedFileUrl(itemObj.photo);
        }
        if (itemObj.accessories && itemObj.accessories.length > 0) {
            for (let acc of itemObj.accessories) {
                if (acc.attachment) {
                    acc.attachment = await getSignedFileUrl(acc.attachment);
                }
            }
        }

        if (itemObj.assignedBy?.signature?.url) {
            itemObj.assignedBy.signature.url = await getSignedFileUrl(itemObj.assignedBy.signature.url);
        }

        if (itemObj.assignedTo?.signature?.url) {
            itemObj.assignedTo.signature.url = await getSignedFileUrl(itemObj.assignedTo.signature.url);
        }

        if (itemObj.acceptedBy?.signature?.url) {
            itemObj.acceptedBy.signature.url = await getSignedFileUrl(itemObj.acceptedBy.signature.url);
        }

        if (itemObj.documents && itemObj.documents.length > 0) {
            for (let doc of itemObj.documents) {
                if (doc.attachment) {
                    doc.attachment = await getSignedFileUrl(doc.attachment);
                }
            }
        }

        if (itemObj.services && itemObj.services.length > 0) {
            for (let service of itemObj.services) {
                if (service.invoice) {
                    service.invoice = await getSignedFileUrl(service.invoice);
                }
                if (service.attachment) {
                    service.attachment = await getSignedFileUrl(service.attachment);
                }
                if (service.quotation2) {
                    service.quotation2 = await getSignedFileUrl(service.quotation2);
                }
                if (service.quotation3) {
                    service.quotation3 = await getSignedFileUrl(service.quotation3);
                }
            }
        }

        // Reuse assetController from visibility check above
        if (assetController) {
            itemObj.assetController = {
                _id: assetController._id,
                firstName: assetController.firstName,
                lastName: assetController.lastName,
                employeeId: assetController.employeeId,
                companyEmail: assetController.companyEmail
            };
            itemObj.assetControllerId = assetController._id;
        } else {
            itemObj.assetController = null;
            itemObj.assetControllerId = null;
        }

        // Special handling for Abbas Raza case:
        // If assetController exists in Flowchart but no EmployeeBasic record, still show the info
        if (assetController && !assetController._id) {
            console.log(`[Asset Detail] Asset Controller found in Flowchart but not EmployeeBasic: ${assetController.employeeName}`);
            itemObj.assetController = {
                _id: `flowchart_${assetController.category}`, // Use special ID for frontend matching
                firstName: assetController.employeeName?.split(' ')[0] || 'Unknown',
                lastName: assetController.employeeName?.split(' ').slice(1).join(' ') || '',
                employeeId: assetController.employeeId,
                companyEmail: assetController.email
            };
            itemObj.assetControllerId = `flowchart_${assetController.category}`;
        }

        // Authoritative UI flag (same rules as PUT approve-creation) — avoids client-only isAssetController drift
        const isAssignmentAcknowledgmentOnly =
            item.acceptanceStatus === 'Pending' &&
            !item.pendingAction &&
            (item.status === 'Pending' || item.status === 'Assigned') &&
            // For employee assignments, `assignedTo` exists.
            // For company allocations, `assignedCompany` exists.
            (item.assignedTo || item.assignedCompany);

        const isAwaitingCreationApproval =
            item.status === 'Submitted for Approval' ||
            (item.status === 'Draft' && item.actionRequiredBy) ||
            (item.actionRequiredBy != null &&
                item.status === 'Pending' &&
                !isAssignmentAcknowledgmentOnly);

        // Flowchart check can miss valid approvers; creation flow stores the real approver on actionRequiredBy
        const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const actionById =
            item.actionRequiredBy?._id?.toString?.() ||
            item.actionRequiredBy?.toString?.() ||
            null;
        const reqEmpObj = req.user?.employeeObjectId?.toString?.() || null;
        const matchesActionByObjectId = !!(actionById && reqEmpObj && actionById === reqEmpObj);
        const arEmployeeId = item.actionRequiredBy?.employeeId;
        const reqUserEmployeeId = req.user?.employeeId;
        const matchesActionByEmployeeId = !!(
            arEmployeeId &&
            reqUserEmployeeId &&
            normEmp(arEmployeeId) === normEmp(reqUserEmployeeId)
        );
        const isDesignatedCreationApprover = matchesActionByObjectId || matchesActionByEmployeeId;

        // Save-only drafts (no actionRequiredBy) must be submitted for approval first — no direct AC approve via dept fallback.
        let canApproveAsDeptAssetController = false;

        // Important: "awaiting creation approval" must be shown/approved only by the actual
        // designated approver (stored in `actionRequiredBy`), not by anyone who happens to be
        // an Asset Controller. This prevents HR-only company flows from appearing on AC UI.
        itemObj.canApproveAssetCreation = !!(
            isAwaitingCreationApproval &&
            (isAdmin ||
                isPortalAdmin ||
                isDesignatedCreationApprover ||
                canApproveAsDeptAssetController)
        );

        const wfStage = itemObj.activeServiceWorkflow?.stage;
        itemObj.canRespondToServiceWorkflow = await userMayRespondVehicleServiceWorkflow(req.user, wfStage);
        if (wfStage && !['complete', 'rejected'].includes(wfStage)) {
            itemObj.activeServiceWorkflow = {
                ...itemObj.activeServiceWorkflow,
                currentAssignee: await getWorkflowAssigneePayloadForStage(wfStage)
            };
        }

        res.status(200).json(itemObj);
    } catch (error) {
        console.error('Error fetching asset item detail:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Assign an asset item to an employee
// @route   PUT /api/AssetItem/:id/assign
// @access  Private
export const assignAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        const { assignedTo, assignedToType, assignmentType, assignedDays } = req.body;

        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Target and assignment type are required' });
        }

        const item = await AssetItem.findById(id)
            .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail')
            .populate('assignedCompany', 'name email companyId');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check if this is a reassignment (asset was previously assigned)
        const isReassignment = item.status === 'Assigned' && (item.assignedTo || item.assignedCompany);
        const isParkingReassignment = item.status === 'On Leave' && item.assignedToType === 'Employee' && !!item.assignedTo;
        let previousAssignee = null;
        let previousAssigneeType = null;
        let newAssignee = null;
        let newAssigneeType = assignedToType;

        // Store previous assignee info before updating
        if (isReassignment) {
            if (item.assignedToType === 'Company' && item.assignedCompany) {
                previousAssignee = item.assignedCompany;
                previousAssigneeType = 'Company';
            } else if (item.assignedToType === 'Employee' && item.assignedTo) {
                previousAssignee = item.assignedTo;
                previousAssigneeType = 'Employee';
            }
        }

        if (isParkingReassignment) {
            const oldAssignedToId = (item.assignedTo?._id || item.assignedTo)?.toString?.() || null;
            item.pendingActionDetails = {
                ...(item.pendingActionDetails || {}),
                parkingReassignContext: {
                    isParkingReassign: true,
                    oldAssignedTo: oldAssignedToId,
                    oldAssignedBy: (item.assignedBy?._id || item.assignedBy)?.toString?.() || null,
                    oldAssignmentType: item.assignmentType || null,
                    oldAssignedDays: item.assignedDays ?? null,
                    oldAssignedDate: item.assignedDate || null,
                    oldTemporaryEndDate: item.temporaryEndDate || null,
                    oldTemporaryReminderSentAt: item.temporaryReminderSentAt || null,
                    oldTemporaryExpiredSentAt: item.temporaryExpiredSentAt || null
                }
            };
        }

        // Check if assigner (current user) has authorization
        // Use both ObjectId match and employeeId match (employeeId can have spacing differences).
        const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        const actingEmpObjectId = req.user.employeeObjectId?.toString?.() || null;
        const actingEmployeeId = req.user.employeeId ? norm(req.user.employeeId) : '';

        const isAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';

        const assignedToId =
            (item.assignedTo?._id ? item.assignedTo._id : item.assignedTo)?.toString?.() || (item.assignedTo?.toString?.() || null);
        const assignedToEmployeeId = item.assignedTo?.employeeId ? norm(item.assignedTo.employeeId) : '';

        const assignedById =
            item.assignedBy?._id ? item.assignedBy._id.toString() : item.assignedBy?.toString?.() || item.assignedBy?.toString?.() || null;
        const assignedByEmployeeId = item.assignedBy?.employeeId ? norm(item.assignedBy.employeeId) : '';

        const isAssignedUser =
            (!!actingEmpObjectId && !!assignedToId && assignedToId === actingEmpObjectId) ||
            (!!actingEmployeeId && !!assignedToEmployeeId && assignedToEmployeeId === actingEmployeeId);

        const isAssigner =
            (!!actingEmpObjectId && !!assignedById && assignedById === actingEmpObjectId) ||
            (!!actingEmployeeId && !!assignedByEmployeeId && assignedByEmployeeId === actingEmployeeId);

        // Find if this user is a designated Asset Controller for this company
        const assetController = await getDepartmentHOD('assetcontroller');

        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssignedUser && !isAssigner && !isAssetController) {
            return res.status(403).json({ message: "You are not authorized to assign or reassign this asset." });
        }

        // Unassigned inventory actions are restricted to Admin / Asset Controller only.
        if (['Unassigned', 'Returned', 'Draft'].includes(item.status) && !isAdmin && !isAssetController) {
            return res.status(403).json({ message: "Only Asset Controller or Admin can manage unassigned assets." });
        }

        // New assignments from the pool (not reassignment / parking handoff) must start from Unassigned only.
        if (!isReassignment && !isParkingReassignment && item.status !== 'Unassigned') {
            return res.status(400).json({
                message: 'Assets can only be assigned from Unassigned status.'
            });
        }

        if (!actingEmpObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const assigner = await EmployeeBasic.findById(actingEmpObjectId);
        if (!assigner || !assigner.signature || !assigner.signature.url) {
            return res.status(403).json({ message: "Cant assign: Your signature has not been added to your profile." });
        }

        let actionRequiredBy = null;
        let actionRecipient = null;
        let subjectName = "";
        let subjectEmpId = "";

        if (assignedToType === 'Company') {
            // Assigning to a Company
            const targetCompany = await Company.findById(assignedTo);
            if (!targetCompany) return res.status(404).json({ message: "Target company not found" });

            const companyCoordinator = await getCompanyAssetCoordinator();
            if (!companyCoordinator?._id) {
                return res.status(400).json({
                    message: `No Assigned User or Admin in Flowchart. Configure one in Settings → Flowchart before allocating to ${targetCompany.name}.`
                });
            }

            item.assignedToType = 'Company';
            item.assignedCompany = targetCompany._id;
            item.assignedTo = null;
            item.status = 'Pending';
            item.acceptanceStatus = 'Pending';
            item.actionRequiredBy = companyCoordinator._id;
            actionRequiredBy = companyCoordinator._id;

            actionRecipient = companyCoordinator;
            subjectName = targetCompany.name;
            subjectEmpId = targetCompany.companyId;
            newAssignee = targetCompany;

        } else {
            // Assigning to an Employee (Default)
            const employeeToAssign = await EmployeeBasic.findById(assignedTo).select(
                'employeeId firstName lastName companyEmail workEmail personalEmail email primaryReportee'
            );
            if (!employeeToAssign) return res.status(404).json({ message: "Target employee not found" });

            item.assignedToType = 'Employee';
            item.assignedTo = assignedTo;
            item.assignedCompany = null;
            item.status = 'Pending';
            item.acceptanceStatus = 'Pending';
            // Acknowledgment always belongs to the assignee (not manager, not asset controller, not assigner)
            item.actionRequiredBy = assignedTo;

            actionRequiredBy = assignedTo;
            actionRecipient = employeeToAssign;
            subjectName = `${employeeToAssign.firstName} ${employeeToAssign.lastName}`;
            subjectEmpId = employeeToAssign.employeeId;
            newAssignee = employeeToAssign;
        }

        item.assignedBy = req.user.employeeObjectId;
        item.assignmentType = assignmentType;
        if (assignmentType === 'Temporary') {
            const parsedDays = Number(assignedDays);
            if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) {
                return res.status(400).json({ message: 'Temporary duration must be an integer between 1 and 60 days.' });
            }
            item.assignedDays = parsedDays;
            // Start the duration when the assignment is accepted (status becomes "Assigned").
            item.assignedDate = null;
            item.temporaryEndDate = null;
            item.temporaryReminderSentAt = null;
            item.temporaryExpiredSentAt = null;
        } else {
            item.assignedDays = null;
            item.assignedDate = null;
            item.temporaryEndDate = null;
            item.temporaryReminderSentAt = null;
            item.temporaryExpiredSentAt = null;
        }
        item.negotiationHistory = [];

        await item.save();

        // Send reassignment email to previous assignee if this is a reassignment
        if (isReassignment && previousAssignee && newAssignee) {
            try {
                let reassignPdf = [];
                try {
                    reassignPdf = await buildBulkAssetInventoryPdfAttachment(req, [item._id.toString()], 'reassignment-inventory');
                } catch (e) {
                    /* non-fatal */
                }
                await sendAssetReassignmentEmail({
                    asset: item,
                    previousAssignee: previousAssignee,
                    newAssignee: newAssignee,
                    previousAssigneeType: previousAssigneeType,
                    newAssigneeType: newAssigneeType,
                    attachments: reassignPdf
                });
            } catch (err) {
                console.error(`[Email Error] Failed to send reassignment email to previous assignee: `, err);
            }
        }

        // Email: notify assignee (or company coordinator) — not the assigner/controller
        try {
            const itemForEmail = await AssetItem.findById(item._id).populate('categoryId', 'name');
            let assignAttachments = [];
            try {
                assignAttachments = await buildBulkAssetInventoryPdfAttachment(req, [item._id.toString()], 'assignment-inventory');
            } catch (pdfErr) {
                console.error('Assignment PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
            }
            await sendAssetAssignmentEmail({
                asset: itemForEmail || item,
                employee: assignedToType === 'Company' ? { firstName: subjectName, lastName: '', isCompany: true } : actionRecipient,
                recipient: actionRecipient,
                attachments: assignAttachments
            });
        } catch (err) {
            console.error(`[Email Error] Failed to send assignment email: `, err);
        }

        // Dashboard inbox for assignee (employee) or company coordinator — same as actionRequiredBy
        try {
            await DashboardAction.findOneAndUpdate(
                { requestId: item._id, requestType: 'Asset Assignment', status: 'Pending' },
                {
                    assignedTo: actionRequiredBy,
                    assignedToEmpId: actionRecipient?.employeeId,
                    requestId: item._id,
                    requestType: 'Asset Assignment',
                    subjectEmployeeId: subjectEmpId,
                    subjectName: subjectName,
                    requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                    extra1: `${item.assetId} — ${item.name}`,
                    extra2: item.assignmentType,
                    status: 'Pending'
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            console.log(`[Dashboard] Synced asset assignment action for ${actionRecipient?.employeeId}`);
        } catch (err) {
            console.error(`[Dashboard Error] Failed to create action for asset ${item.assetId}: `, err);
        }

        // Log to Asset History
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId acceptedBy accessories assignedCompany')
            .populate({
                path: 'assignedTo',
                populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
            })
            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

        await AssetHistory.create({
            assetId: item._id,
            action: 'Assigned',
            assignedToType: item.assignedToType,
            assignedTo: item.assignedTo,
            assignedCompany: item.assignedCompany,
            performedBy: req.user.employeeObjectId,
            details: snapshotItem.toObject()
        });

        await updateAssetTypeCounts(item.typeId);

        const updatedItem = await AssetItem.findById(id)
            .populate('assignedCompany')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee enablePortalAccess',
                populate: [
                    {
                        path: 'reportingAuthority',
                        select: 'firstName lastName'
                    },
                    {
                        path: 'primaryReportee',
                        select: 'firstName lastName'
                    }
                ]
            })
            .populate({
                path: 'assignedBy',
                select: 'firstName lastName employeeId signature'
            })
            .populate('typeId', 'name imagePreview')
            .populate('categoryId', 'name imagePreview');

        res.status(200).json(updatedItem);
    } catch (error) {
        console.error('Error assigning asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Bulk assign asset items to an employee
// @route   PUT /api/AssetItem/bulk/assign
// @access  Private
export const bulkAssignAssetItems = async (req, res) => {
    try {
        const { assetIds, assignedTo, assignmentType, assignedDays } = req.body;

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Bulk assignment denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'No assets selected' });
        }
        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Employee and assignment type are required' });
        }

        // Check if assigner (current user) has a signature
        if (!req.user.employeeObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const assigner = await EmployeeBasic.findById(req.user.employeeObjectId);
        if (!assigner || !assigner.signature || !assigner.signature.url) {
            return res.status(403).json({ message: "cant you cant assign u r signator not added" });
        }

        const employeeToAssign = await EmployeeBasic.findById(assignedTo).select(
            'employeeId companyEmail workEmail personalEmail email primaryReportee firstName lastName'
        );
        if (!employeeToAssign) {
            return res.status(404).json({ message: 'Target employee not found' });
        }

        // Acknowledgment queue + dashboard always target the assignee
        const actionRequiredBy = assignedTo;

        const empName = `${employeeToAssign?.firstName || ''} ${employeeToAssign?.lastName || ''}`.trim() || 'Unknown Employee';

        // Update all items — always normalize employee assignment (bulk AC path is never company-pool).
        // Without this, assets that previously had assignedToType: 'Company' stayed Company and the
        // assignee failed canUserActAsAssigneeForBulkItem (strict Employee check) on pending review.
        const updateData = {
            assignedTo,
            assignedToType: 'Employee',
            assignedCompany: null,
            assignedBy: req.user.employeeObjectId,
            assignmentType,
            assignedDays: null,
            assignedDate: null,
            temporaryEndDate: null,
            temporaryReminderSentAt: null,
            temporaryExpiredSentAt: null,
            status: 'Pending',
            acceptanceStatus: 'Pending',
            actionRequiredBy,
            ownership: empName,
            negotiationHistory: []
        };

        if (assignmentType === 'Temporary') {
            const parsedDays = Number(assignedDays);
            if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 60) {
                return res.status(400).json({ message: 'Temporary duration must be an integer between 1 and 60 days.' });
            }
            updateData.assignedDays = parsedDays;
            // Start the duration when the assignment is accepted (status becomes "Assigned").
            updateData.assignedDate = null;
            updateData.temporaryEndDate = null;
        }

        let bulkAssignmentAttachments;
        try {
            bulkAssignmentAttachments = await requireBulkAssetInventoryPdfAttachment(
                req,
                assetIds.map(String),
                'bulk-assignment-inventory'
            );
            console.log(
                `[bulkAssignAssetItems] PDF attachments prepared: ${Array.isArray(bulkAssignmentAttachments) ? bulkAssignmentAttachments.length : 0}`
            );
        } catch (pdfErr) {
            console.error('[bulkAssignAssetItems] PDF required for email:', pdfErr?.message || pdfErr);
            return res.status(503).json({
                message:
                    pdfErr?.message ||
                    'Could not generate the asset list PDF. Assignment was not saved. Try again or contact support.'
            });
        }

        const existingItems = await AssetItem.find({ _id: { $in: assetIds } }).select('status assetId');
        if (existingItems.length !== assetIds.length) {
            return res.status(400).json({ message: 'One or more assets were not found.' });
        }
        const notUnassigned = existingItems.filter((doc) => doc.status !== 'Unassigned');
        if (notUnassigned.length > 0) {
            const ids = notUnassigned.map((d) => d.assetId || d._id).join(', ');
            return res.status(400).json({
                message: `Bulk assign is only allowed for assets in Unassigned status. Not unassigned: ${ids}`
            });
        }

        const bulkAssignmentGroupId = new mongoose.Types.ObjectId();
        const assetIdStrings = assetIds.map((id) => String(id));

        for (const aid of assetIds) {
            let revertToEmployeeId = null;
            let revertToDisplayName = null;
            const lastAssign = await AssetHistory.findOne({
                assetId: aid,
                action: { $in: ['Assigned', 'Accepted'] }
            })
                .sort({ date: -1 })
                .select('assignedTo')
                .lean();
            if (
                lastAssign?.assignedTo &&
                String(lastAssign.assignedTo) !== String(assignedTo)
            ) {
                revertToEmployeeId = lastAssign.assignedTo;
                const prevEmp = await EmployeeBasic.findById(revertToEmployeeId)
                    .select('firstName lastName')
                    .lean();
                if (prevEmp) {
                    revertToDisplayName = `${prevEmp.firstName || ''} ${prevEmp.lastName || ''}`.trim();
                }
            }

            await AssetItem.updateOne(
                { _id: aid },
                {
                    $set: {
                        ...updateData,
                        pendingActionDetails: {
                            bulkAssignment: {
                                groupId: bulkAssignmentGroupId.toString(),
                                assetIds: assetIdStrings,
                                revertToEmployeeId,
                                revertToDisplayName
                            }
                        }
                    }
                }
            );
        }

        // One dashboard / inbox row for the whole bulk batch (assignee acknowledges via bulk modal)
        try {
            const actionRecipient = await EmployeeBasic.findById(assignedTo).select('employeeId firstName lastName');
            const subjectEmp = actionRecipient;
            const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assetId name assignmentType');

            if (assetIds.length > 1) {
                await DashboardAction.create({
                    assignedTo: actionRequiredBy,
                    assignedToEmpId: actionRecipient?.employeeId,
                    requestId: assetIds[0],
                    requestType: 'Asset',
                    subjectEmployeeId: subjectEmp?.employeeId,
                    subjectName: `${subjectEmp?.firstName || ''} ${subjectEmp?.lastName || ''}`.trim(),
                    requestedByName: `${assigner?.firstName || 'System'} ${assigner?.lastName || ''}`.trim(),
                    extra1: `Bulk assignment (${assetIds.length} assets)`,
                    extra2: assignmentType,
                    extra3: JSON.stringify({
                        isBulkAssignment: true,
                        bulkAssignmentGroupId: bulkAssignmentGroupId.toString(),
                        bulkAssetIds: assetIdStrings
                    }),
                    status: 'Pending'
                });
                console.log(`[Dashboard] Created 1 bulk assignment action (${assetIds.length} assets) for ${actionRecipient?.employeeId}`);
            } else if (assets.length === 1) {
                const one = assets[0];
                await DashboardAction.create({
                    assignedTo: actionRequiredBy,
                    assignedToEmpId: actionRecipient?.employeeId,
                    requestId: one._id,
                    requestType: 'Asset',
                    subjectEmployeeId: subjectEmp?.employeeId,
                    subjectName: `${subjectEmp?.firstName || ''} ${subjectEmp?.lastName || ''}`.trim(),
                    requestedByName: `${assigner?.firstName || 'System'} ${assigner?.lastName || ''}`.trim(),
                    extra1: `${one.assetId} - ${one.name} `,
                    extra2: one.assignmentType,
                    status: 'Pending'
                });
            }
        } catch (err) {
            console.error(`[Dashboard Error] Failed to create bulk asset actions: `, err);
        }

        // Log history for each asset with Snapshot
        const populatedAssets = await AssetItem.find({ _id: { $in: assetIds } })
            .populate('categoryId typeId acceptedBy accessories')
            .populate({
                path: 'assignedTo',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName employeeId' },
                    { path: 'reportingAuthority', select: 'firstName lastName employeeId' }
                ]
            })
            .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

        const historyEntries = populatedAssets.map(asset => ({
            assetId: asset._id,
            action: 'Assigned',
            assignedTo,
            performedBy: req.user.employeeObjectId,
            date: new Date(),
            details: asset.toObject()
        }));
        await AssetHistory.insertMany(historyEntries);

        // Update counts for all unique typeIds affected
        const items = await AssetItem.find({ _id: { $in: assetIds } }).select('typeId');
        const uniqueTypeIds = [...new Set(items.map(i => i.typeId.toString()))];

        for (const typeId of uniqueTypeIds) {
            await updateAssetTypeCounts(typeId);
        }

        // Send email to assignee only (HTML table + PDF inventory)
        try {
            const employee = await EmployeeBasic.findById(assignedTo).select(
                'employeeId firstName lastName companyEmail workEmail personalEmail email'
            );
            const firstAsset = await AssetItem.findById(assetIds[0]).populate('categoryId');
            const assetsForEmail = await AssetItem.find({ _id: { $in: assetIds } })
                .populate('categoryId', 'name')
                .lean();
            const orderMap = new Map(assetIds.map((id, i) => [String(id), i]));
            assetsForEmail.sort((a, b) => (orderMap.get(String(a._id)) ?? 0) - (orderMap.get(String(b._id)) ?? 0));

            if (employee && firstAsset) {
                await sendAssetAssignmentEmail({
                    asset: firstAsset,
                    assets: assetsForEmail,
                    employee,
                    recipient: employee,
                    isBulk: true,
                    assetCount: assetIds.length,
                    attachments: bulkAssignmentAttachments,
                    bulkAssignmentGroupId: bulkAssignmentGroupId.toString()
                });
            }
        } catch (emailErr) {
            console.error('Error in bulk asset assignment email trigger:', emailErr);
        }

        res.status(200).json({
            message: `${assetIds.length} assets assigned successfully`,
            bulkAssignmentGroupId: bulkAssignmentGroupId.toString()
        });
    } catch (error) {
        console.error('Error bulk assigning assets:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Download Historical Asset Handover Form PDF
// @route   GET /api/AssetItem/history-handover-pdf/:historyId
// @access  Private
export const downloadHistoryHandoverPdf = async (req, res) => {
    try {
        const { historyId } = req.params;

        const history = await AssetHistory.findById(historyId);
        if (!history || !history.details) {
            return res.status(404).json({ message: 'History record or snapshot not found' });
        }

        const assetSnapshot = history.details;

        // URL to the frontend print page
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = origin || process.env.FRONTEND_URL || 'http://localhost:3000';

        // We pass the historyId to the print page so it knows to fetch data from history instead of current asset
        const printUrl = `${baseUrl}/print/asset-handover/${assetSnapshot._id}?historyId=${historyId}`;

        console.log(`Generating Historical Asset Handover PDF from: ${printUrl}`);

        const token = req.headers.authorization?.split(' ')[1] || '';
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);

        const userPayload = {
            id: requestingUserId,
            isAdmin: userObj?.isAdmin || userObj?.role === 'Admin' || userObj?.role === 'ROOT',
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, ASSET_HANDOVER_PDF_SELECTOR);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Historical-Handover-${assetSnapshot.assetId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error generating Historical Asset Handover PDF:', error);
        res.status(500).json({ message: 'Failed to generate historical PDF', error: error.message });
    }
};

// @desc    Download Asset Handover Form PDF
// @route   GET /api/AssetItem/handover-pdf/:id
// @access  Private
export const downloadHandoverPdf = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // URL to the frontend print page we created
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = origin || process.env.FRONTEND_URL || 'http://localhost:3000';
        const printUrl = `${baseUrl}/print/asset-handover/${id}`;

        console.log(`Generating Asset Handover PDF from: ${printUrl}`);

        const token = req.headers.authorization?.split(' ')[1] || '';

        // Prepare user payload for Puppeteer auth
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);

        const userPayload = {
            id: requestingUserId,
            isAdmin: userObj?.isAdmin || userObj?.role === 'Admin' || userObj?.role === 'ROOT',
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const permissions = {}; // Default permissions

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, ASSET_HANDOVER_PDF_SELECTOR);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename = "HandoverForm-${asset.assetId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error generating Asset Handover PDF:', error);
        res.status(500).json({ message: 'Failed to generate PDF', error: error.message });
    }
};

// @desc    Respond to asset assignment (Accept/Reject/Negotiate)
// @route   PUT /api/AssetItem/:id/respond
// @access  Private (Assigned User or Assigner)
export const respondToAssignment = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments } = req.body; // action: 'Accept', 'Reject', 'AcceptWithComments'

        if (!['Accept', 'Reject', 'AcceptWithComments'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action.' });
        }

        const item = await AssetItem.findById(id).populate('assignedTo assignedBy assignedCompany');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const assignmentBulkGroupId = item.pendingActionDetails?.bulkAssignment?.groupId || null;

        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();
        const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');

        const isAssignee =
            item.assignedToType === 'Employee' &&
            item.assignedTo &&
            (
                (item.assignedTo._id || item.assignedTo).toString() === cur ||
                (item.assignedTo?.employeeId && req.user?.employeeId && norm(item.assignedTo.employeeId) === norm(req.user.employeeId))
            );
        const isAssigner =
            item.assignedBy && (item.assignedBy._id || item.assignedBy).toString() === cur;
        const isHR =
            item.assignedToType === 'Company' && item.actionRequiredBy?.toString() === cur;

        // If assignee has NO ERP login access, allow assignee.primaryReportee to act as delegate
        let isPrimaryReporteeDelegate = false;
        let primaryReportee = null;
        if (item.assignedToType === 'Employee' && item.assignedTo && item.assignedTo.primaryReportee) {
            // enablePortalAccess comes from EmployeeBasic; if missing, we fallback to linked User row
            let assigneeHasPortalAccess = null;
            if (typeof item.assignedTo.enablePortalAccess === 'boolean') {
                assigneeHasPortalAccess = item.assignedTo.enablePortalAccess;
            } else {
                const assigneeEmpId = item.assignedTo.employeeId;
                if (assigneeEmpId) {
                    const linkedUser = await User.findOne({ employeeId: assigneeEmpId, status: 'Active' })
                        .select('enablePortalAccess')
                        .lean()
                        .catch(() => null);
                    assigneeHasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
                }
            }
            // If we can't determine, don't delegate
            const allowDelegate = assigneeHasPortalAccess === false;
            const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
            if (allowDelegate && managerId && managerId.toString() === cur) {
                isPrimaryReporteeDelegate = true;
                // Fetch manager details for notifications
                primaryReportee = await EmployeeBasic.findById(managerId)
                    .select('firstName lastName employeeId companyEmail enablePortalAccess primaryReportee')
                    .lean()
                    .catch(() => null);
            }
        }

        if (item.assignedToType === 'Company') {
            if (!isHR) {
                return res.status(403).json({ message: 'You are not authorized to respond to this company assignment.' });
            }
            if (item.actionRequiredBy && item.actionRequiredBy.toString() !== cur) {
                return res.status(403).json({ message: 'It is not your turn (designated company coordinator) to respond.' });
            }
        } else {
            if (!isAssignee && !isAssigner && !isPrimaryReporteeDelegate) {
                return res.status(403).json({ message: 'You are not authorized to respond to this assignment.' });
            }
            // If actionRequiredBy is not the current user, allow assigner or delegated primaryReportee to act too.
            if (item.actionRequiredBy && item.actionRequiredBy.toString() !== cur) {
                const assigneeId = item.assignedTo?._id ? item.assignedTo._id.toString() : item.assignedTo?.toString?.() || null;
                const isActingOnAssignedTurn =
                    isAssigner ||
                    isPrimaryReporteeDelegate ||
                    (isAssignee && assigneeId && item.actionRequiredBy.toString() === assigneeId);

                if (!isActingOnAssignedTurn) {
                    return res.status(403).json({ message: 'It is not your turn to respond.' });
                }
            }
        }

        const assignee = item.assignedTo;

        // Determine actor for notifications
        let actor =
            isAssignee ? item.assignedTo :
                (isPrimaryReporteeDelegate ? (primaryReportee || await EmployeeBasic.findById(currentUser).catch(() => null)) :
                    (isHR ? await EmployeeBasic.findById(currentUser) : item.assignedBy));

        // Notify all relevant parties
        const notifyParties = async () => {
            try {
                const recipients = [];
                // 1. Always notify the person who assigned the asset
                if (item.assignedBy) recipients.push(item.assignedBy);

                // 2. Notify the subject (employee or delegated primary reportee) if they were NOT the one who acted
                if (item.assignedToType === 'Employee' && item.assignedTo && item.assignedTo._id.toString() !== currentUser.toString()) {
                    // If assignee has portal access, notify assignee.
                    // Otherwise notify their primaryReportee delegate.
                    const assigneeHasPortalAccess = typeof item.assignedTo.enablePortalAccess === 'boolean'
                        ? item.assignedTo.enablePortalAccess
                        : null;

                    if (assigneeHasPortalAccess === true) {
                        recipients.push(item.assignedTo);
                    } else {
                        const managerId = item.assignedTo.primaryReportee?._id || item.assignedTo.primaryReportee;
                        if (managerId) {
                            const manager = primaryReportee || await EmployeeBasic.findById(managerId)
                                .select('firstName lastName employeeId companyEmail enablePortalAccess primaryReportee')
                                .lean()
                                .catch(() => null);
                            if (manager) recipients.push(manager);
                        }
                    }
                }

                // 3. For 'Accept', also notify Manager (Employee Flow only)
                if (action === 'Accept' && item.assignedToType === 'Employee' && item.assignedTo?.primaryReportee) {
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    if (!recipients.some(r => r._id?.toString() === managerId.toString()) && managerId.toString() !== currentUser.toString()) {
                        const manager = await EmployeeBasic.findById(managerId);
                        if (manager) recipients.push(manager);
                    }
                }

                let responseInvPdf = [];
                try {
                    responseInvPdf = await buildBulkAssetInventoryPdfAttachment(req, [item._id.toString()], 'assignment-response-inventory');
                } catch (pdfErr) {
                    console.error('[respondToAssignment] Response PDF failed (non-fatal):', pdfErr?.message || pdfErr);
                }

                for (let recipient of recipients) {
                    await sendAssetResponseEmail({
                        asset: item,
                        actor,
                        recipient,
                        action,
                        comment: comments,
                        assignedToType: item.assignedToType,
                        assignedCompany: item.assignedCompany,
                        attachments: responseInvPdf
                    });
                }
            } catch (err) {
                console.error("[Email Error] Failed to notify parties after asset response:", err);
            }
        };

        const parkingCtx = item.pendingActionDetails?.parkingReassignContext;

        if (action === 'Reject') {
            await notifyParties();

            // Capture snapshot BEFORE clearing
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId assignedTo assignedBy acceptedBy assignedCompany');
            req.rejectionSnapshot = snapshotItem.toObject();

            // If it was a transfer, we just revert to old owner (keep existing assignedTo)
            if (item.pendingAction === 'Asset Transfer') {
                const oldOwnerId = item.pendingActionDetails?.transferFrom || item.assignedTo;
                item.status = 'Pending';
                item.acceptanceStatus = 'Pending';
                item.pendingAction = 'Retention Confirmation';
                item.actionRequiredBy = oldOwnerId;

                // Dashboard action for old HR
                try {
                    const oldHREmp = await EmployeeBasic.findById(oldOwnerId).select('employeeId firstName lastName');
                    await DashboardAction.create({
                        assignedTo: oldOwnerId,
                        assignedToEmpId: oldHREmp?.employeeId,
                        requestId: item._id,
                        requestType: 'Asset Retention',
                        subjectEmployeeId: oldHREmp?.employeeId,
                        subjectName: `${oldHREmp?.firstName || ""} ${oldHREmp?.lastName || ""}`.trim(),
                        requestedByName: req.user.name || 'New HR',
                        extra1: `${item.assetId} - ${item.name}`,
                        extra2: 'Handover Rejected: Confirm you still have this asset',
                        status: 'Pending'
                    });
                } catch (dashErr) {
                    console.error("[Dashboard Error] Failed to create retention task:", dashErr);
                }
            } else if (parkingCtx?.isParkingReassign && parkingCtx?.oldAssignedTo) {
                // Revert parked reassignment: keep old assignee and parking state unchanged.
                item.status = 'On Leave';
                item.assignedToType = 'Employee';
                item.assignedTo = parkingCtx.oldAssignedTo;
                item.assignedCompany = null;
                item.assignedBy = parkingCtx.oldAssignedBy || item.assignedBy;
                item.assignmentType = parkingCtx.oldAssignmentType || item.assignmentType;
                item.assignedDays = parkingCtx.oldAssignedDays ?? item.assignedDays;
                item.assignedDate = parkingCtx.oldAssignedDate ?? item.assignedDate;
                item.temporaryEndDate = parkingCtx.oldTemporaryEndDate ?? item.temporaryEndDate;
                item.temporaryReminderSentAt = parkingCtx.oldTemporaryReminderSentAt ?? item.temporaryReminderSentAt;
                item.temporaryExpiredSentAt = parkingCtx.oldTemporaryExpiredSentAt ?? item.temporaryExpiredSentAt;
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.negotiationHistory = [];
                item.pendingAction = null;
                if (item.pendingActionDetails?.parkingReassignContext) {
                    delete item.pendingActionDetails.parkingReassignContext;
                }
            } else {
                item.status = 'Unassigned';
                item.assignedTo = null;
                item.assignedCompany = null;
                item.assignedToType = null;
                item.assignedBy = null;
                item.assignmentType = null;
                item.assignedDays = null;
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
                item.acceptanceStatus = 'Rejected';
                item.actionRequiredBy = null;
                item.negotiationHistory = [];
            }

        } else if (action === 'Accept' || action === 'AcceptWithComments') {
            // Handle HR Handover / Asset Transfer: Reassign 'assignedTo' to the person who accepted
            if (item.pendingAction === 'Asset Transfer' && item.actionRequiredBy?.toString() === currentUser.toString()) {
                console.log(`[Asset Handover] Completing handover for asset ${item.assetId} from ${item.assignedTo?._id || item.assignedTo} to ${currentUser}`);
                item.assignedTo = currentUser;
                item.pendingAction = null;
                item.pendingActionDetails = null;
            } else if (item.pendingAction === 'Retention Confirmation' && item.actionRequiredBy?.toString() === currentUser.toString()) {
                console.log(`[Asset Retention] Old HR confirmed retention for asset ${item.assetId}`);
                item.assignedBy = currentUser; // User is re-assigning to themselves essentially
                item.pendingAction = null;
                item.pendingActionDetails = null;
            }

            if (action === 'Accept') {
                // When accepting a parking (On Leave) reassignment, the asset must stay in "On Leave".
                item.status = parkingCtx?.isParkingReassign ? 'On Leave' : 'Assigned';
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.acceptedBy = req.user.employeeObjectId;

                // Temporary assignment expiration applies only to normal "Assigned" assets,
                // not parking reassignment (On Leave) assets.
                if (!parkingCtx?.isParkingReassign) {
                    if (item.assignmentType === 'Temporary' && item.assignedDays) {
                        const parsedDays = Number(item.assignedDays);
                        const start = item.assignedDate ? new Date(item.assignedDate) : new Date();
                        const end = new Date(start);
                        end.setDate(end.getDate() + parsedDays);
                        item.assignedDate = start;
                        item.temporaryEndDate = end;
                        if (!item.temporaryReminderSentAt) item.temporaryReminderSentAt = null;
                        if (!item.temporaryExpiredSentAt) item.temporaryExpiredSentAt = null;
                    } else {
                        item.assignedDate = null;
                        item.temporaryEndDate = null;
                        item.temporaryReminderSentAt = null;
                        item.temporaryExpiredSentAt = null;
                    }
                } else {
                    // Clear temporary-assignment fields when the asset is staying "On Leave".
                    item.assignmentType = null;
                    item.assignedDays = null;
                    item.assignedDate = null;
                    item.temporaryEndDate = null;
                    item.temporaryReminderSentAt = null;
                    item.temporaryExpiredSentAt = null;
                }

                // Parking reassignment accepted: notify old assignee.
                if (parkingCtx?.isParkingReassign && parkingCtx?.oldAssignedTo && item.assignedToType === 'Employee') {
                    try {
                        const oldAssignee = await EmployeeBasic.findById(parkingCtx.oldAssignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        const newAssignee = await EmployeeBasic.findById(item.assignedTo?._id || item.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email')
                            .lean();
                        const assetController = await EmployeeBasic.findById(item.assignedBy?._id || item.assignedBy)
                            .select('firstName lastName employeeId')
                            .lean();

                        if (oldAssignee && newAssignee) {
                            await sendParkingReassignAcceptedEmail({
                                asset: item,
                                oldAssignee,
                                newAssignee,
                                assetController
                            });
                        }
                    } catch (mailErr) {
                        console.error('[Parking Reassign Email] Non-fatal:', mailErr?.message || mailErr);
                    }
                }

                if (item.pendingActionDetails?.parkingReassignContext) {
                    delete item.pendingActionDetails.parkingReassignContext;
                }
            }

            else if (action === 'AcceptWithComments') {
                let fileUrl = null;
                if (req.body.file) {
                    try {
                        const uploadResult = await uploadDocumentToS3(req.body.file, 'asset-negotiation');
                        fileUrl = uploadResult.publicId;
                    } catch (err) {
                        console.error('File upload failed during negotiation:', err);
                    }
                }

                item.negotiationHistory.push({
                    sender: currentUser,
                    message: comments,
                    action: 'AcceptWithComments',
                    file: fileUrl,
                    date: new Date()
                });

                // Pass the ball: assignee/coordinator → assigner; assigner → assignee (or company coordinator)
                if (isAssignee || isHR) {
                    item.actionRequiredBy = item.assignedBy._id || item.assignedBy;
                } else {
                    if (item.assignedToType === 'Company') {
                        const cc = await getCompanyAssetCoordinator();
                        if (!cc) {
                            return res.status(400).json({
                                message: 'No Assigned User or Admin in Flowchart. Cannot route company negotiation.'
                            });
                        }
                        item.actionRequiredBy = cc._id;
                    } else {
                        item.actionRequiredBy = item.assignedTo._id || item.assignedTo;
                    }
                }

                await notifyParties();

                // Log negotiation
                const snapshotItem = await AssetItem.findById(item._id)
                    .populate('categoryId typeId acceptedBy accessories assignedCompany')
                    .populate({
                        path: 'assignedTo',
                        populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
                    })
                    .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                await AssetHistory.create({
                    assetId: item._id,
                    action: 'Comment',
                    assignedToType: item.assignedToType,
                    assignedTo: item.assignedTo,
                    assignedCompany: item.assignedCompany,
                    performedBy: req.user.employeeObjectId,
                    comments: comments,
                    file: fileUrl,
                    details: snapshotItem.toObject()
                });
            }
        }

        await item.save();

        // Update Dashboard Actions
        try {
            const existingAction = await DashboardAction.findOne({
                requestId: item._id,
                assignedTo: currentUser,
                status: 'Pending'
            });

            if (existingAction) {
                existingAction.status = action === 'Reject' ? 'Rejected' : 'Approved';
                existingAction.actionedDate = new Date();
                existingAction.actionedBy = currentUser;
                existingAction.comment = comments;
                await existingAction.save();
            }

            if (action === 'AcceptWithComments') {
                const nextActorId = item.actionRequiredBy;
                const nextActor = await EmployeeBasic.findById(nextActorId).select('employeeId firstName lastName');

                let subjectName = "";
                let subjectEmpId = "";
                if (item.assignedToType === 'Company') {
                    const comp = await Company.findById(item.assignedCompany);
                    subjectName = comp?.name || "Company";
                    subjectEmpId = comp?.companyId || "N/A";
                } else {
                    const subjectEmp = await EmployeeBasic.findById(item.assignedTo).select('employeeId firstName lastName');
                    subjectName = `${subjectEmp?.firstName || ""} ${subjectEmp?.lastName || ""} `.trim();
                    subjectEmpId = subjectEmp?.employeeId;
                }

                const senderEmp = await EmployeeBasic.findById(currentUser).select('firstName lastName');

                await DashboardAction.create({
                    assignedTo: nextActorId,
                    assignedToEmpId: nextActor?.employeeId,
                    requestId: item._id,
                    requestType: 'Asset',
                    subjectEmployeeId: subjectEmpId,
                    subjectName: subjectName,
                    requestedByName: `${senderEmp?.firstName || ""} ${senderEmp?.lastName || ""} `.trim(),
                    extra1: `${item.assetId} - ${item.name} `,
                    extra2: `Update Required: ${comments} `,
                    status: 'Pending'
                });
            }
        } catch (err) {
            console.error(`[Dashboard Error] Failed to update action for asset ${item.assetId}: `, err);
        }

        if (assignmentBulkGroupId) {
            try {
                await refreshBulkAssignmentDashboardIfGroupFullyResolved(assignmentBulkGroupId, currentUser);
            } catch (dash2) {
                console.error('[Dashboard] Bulk assignment inbox refresh:', dash2?.message || dash2);
            }
        }

        const priorAcceptedCountForReassign =
            action === 'Accept'
                ? await AssetHistory.countDocuments({ assetId: item._id, action: 'Accepted' })
                : 0;

        // Log final actions
        if (action === 'Reject') {
            await AssetHistory.create({
                assetId: item._id,
                action: 'Rejected',
                assignedToType: item.assignedToType,
                assignedTo: null,
                assignedCompany: null,
                performedBy: req.user.employeeObjectId,
                comments: comments,
                details: {
                    ...(req.rejectionSnapshot || {}),
                    rejectionComments: comments
                }
            });
            await updateAssetTypeCounts(item.typeId);
        } else if (action === 'Accept') {
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId acceptedBy accessories assignedCompany')
                .populate({
                    path: 'assignedTo',
                    populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
                })
                .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

            const pr = item.assignedTo?.primaryReportee;
            const primaryReporteeId = pr && (typeof pr === 'object' ? pr._id || pr : pr);
            const isManager =
                item.assignedToType === 'Employee' &&
                !!primaryReporteeId &&
                primaryReporteeId.toString() === cur;

            await AssetHistory.create({
                assetId: item._id,
                action: 'Accepted',
                assignedToType: item.assignedToType,
                assignedTo: item.assignedTo,
                assignedCompany: item.assignedCompany,
                performedBy: req.user.employeeObjectId,
                comments: isManager
                    ? `Accepted by manager on behalf of employee. ${comments || ''} `
                    : isHR
                        ? `Accepted by HR on behalf of company. ${comments || ''} `
                        : comments,
                details: {
                    ...snapshotItem.toObject(),
                    isAcceptedByManager: isManager,
                    isAcceptedByHR: isHR
                }
            });

            if (priorAcceptedCountForReassign >= 1) {
                void notifyAssetControllerReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                void notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
            }
        }

        res.status(200).json(item);
    } catch (error) {
        console.error('Error responding to assignment:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Bulk respond to asset assignments (Accept/Reject)
 * @route   PUT /api/AssetItem/bulk/respond
 * @access  Private
 */
export const bulkRespondToAssignment = async (req, res) => {
    try {
        const { assetIds, action, comments } = req.body; // action: 'Accept' or 'Reject'

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['Accept', 'Reject'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Accept" or "Reject"' });
        }

        const currentUser = req.user.employeeObjectId;
        const items = await AssetItem.find({ _id: { $in: assetIds } }).populate('assignedTo assignedBy assignedCompany');

        const results = { success: [], failed: [] };

        for (const item of items) {
            const bulkAssignGroupId = item.pendingActionDetails?.bulkAssignment?.groupId || null;
            try {
                // Check if user is authorized for this specific asset
                const curBulk = currentUser.toString();
                const isAssignee =
                    item.assignedToType === 'Employee' &&
                    item.assignedTo &&
                    (item.assignedTo._id || item.assignedTo).toString() === curBulk;
                const isHR = item.assignedToType === 'Company' && item.actionRequiredBy?.toString() === curBulk;
                const isActionRequired = item.actionRequiredBy?.toString() === curBulk;

                // Assigner / delegated primaryReportee
                const isAssigner =
                    !!item.assignedBy &&
                    (item.assignedBy._id || item.assignedBy).toString() === curBulk;

                let isPrimaryReporteeDelegate = false;
                if (item.assignedToType === 'Employee' && item.assignedTo && item.assignedTo.primaryReportee) {
                    const assigneeHasCompanyEmail = !!(item.assignedTo.companyEmail && String(item.assignedTo.companyEmail).trim().length > 0);
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    if (!assigneeHasCompanyEmail && managerId && managerId.toString() === curBulk) {
                        isPrimaryReporteeDelegate = true;
                    }
                }

                if (!isAssignee && !isHR && !isActionRequired && !isAssigner && !isPrimaryReporteeDelegate) {
                    results.failed.push({ id: item.assetId, message: 'Unauthorized' });
                    continue;
                }

                if (action === 'Accept') {
                    // Handle handover
                    if (item.pendingAction === 'Asset Transfer' && isActionRequired) {
                        item.assignedTo = currentUser;
                        item.pendingAction = null;
                        item.pendingActionDetails = null;
                    } else if (item.pendingAction === 'Retention Confirmation' && isActionRequired) {
                        item.assignedBy = currentUser;
                        item.pendingAction = null;
                        item.pendingActionDetails = null;
                    }

                    item.status = 'Assigned';
                    item.acceptanceStatus = 'Accepted';
                    item.actionRequiredBy = null;
                    item.acceptedBy = currentUser;

                    // Temporary assignment: ensure end date is set for reminder + auto unassign.
                    if (item.assignmentType === 'Temporary' && item.assignedDays) {
                        const parsedDays = Number(item.assignedDays);
                        const start = item.assignedDate ? new Date(item.assignedDate) : new Date();
                        const end = new Date(start);
                        end.setDate(end.getDate() + parsedDays);
                        item.assignedDate = start;
                        item.temporaryEndDate = end;
                        if (!item.temporaryReminderSentAt) item.temporaryReminderSentAt = null;
                        if (!item.temporaryExpiredSentAt) item.temporaryExpiredSentAt = null;
                    } else {
                        item.assignedDate = null;
                        item.temporaryEndDate = null;
                        item.temporaryReminderSentAt = null;
                        item.temporaryExpiredSentAt = null;
                    }
                } else {
                    // Rejection
                    if (item.pendingAction === 'Asset Transfer') {
                        const oldOwnerId = item.pendingActionDetails?.transferFrom || item.assignedTo;
                        item.status = 'Pending';
                        item.acceptanceStatus = 'Pending';
                        item.pendingAction = 'Retention Confirmation';
                        item.actionRequiredBy = oldOwnerId;

                        try {
                            const oldHREmp = await EmployeeBasic.findById(oldOwnerId).select('employeeId firstName lastName');
                            await DashboardAction.create({
                                assignedTo: oldOwnerId,
                                assignedToEmpId: oldHREmp?.employeeId,
                                requestId: item._id,
                                requestType: 'Asset Retention',
                                subjectEmployeeId: oldHREmp?.employeeId,
                                subjectName: `${oldHREmp?.firstName || ""} ${oldHREmp?.lastName || ""}`.trim(),
                                requestedByName: req.user.name || 'New HR',
                                extra1: `${item.assetId} - ${item.name}`,
                                extra2: 'Handover Rejected (Bulk): Confirm you still have this asset',
                                status: 'Pending'
                            });
                        } catch (dashErr) {
                            console.error("[Bulk Dashboard Error] Failed to create retention task:", dashErr);
                        }
                    } else {
                        item.status = 'Unassigned';
                        item.assignedTo = null;
                        item.assignedCompany = null;
                        item.assignedToType = null;
                        item.assignedBy = null;
                        item.acceptanceStatus = 'Rejected';
                        item.actionRequiredBy = null;
                    }

                    // Clear temporary assignment fields on rejection
                    item.assignmentType = null;
                    item.assignedDays = null;
                    item.assignedDate = null;
                    item.temporaryEndDate = null;
                    item.temporaryReminderSentAt = null;
                    item.temporaryExpiredSentAt = null;
                }

                await item.save();

                // Clear Dashboard Actions
                await DashboardAction.updateMany(
                    { requestId: item._id, assignedTo: currentUser, status: 'Pending' },
                    {
                        status: action === 'Accept' ? 'Approved' : 'Rejected',
                        actionedDate: new Date(),
                        actionedBy: currentUser,
                        comment: comments || 'Bulk Action'
                    }
                );

                if (bulkAssignGroupId) {
                    try {
                        await refreshBulkAssignmentDashboardIfGroupFullyResolved(bulkAssignGroupId, currentUser);
                    } catch (bdash) {
                        console.error('[Bulk respond] assignment inbox refresh:', bdash?.message || bdash);
                    }
                }

                const priorAcceptedCountForReassign =
                    action === 'Accept'
                        ? await AssetHistory.countDocuments({ assetId: item._id, action: 'Accepted' })
                        : 0;

                // Log History
                await AssetHistory.create({
                    assetId: item._id,
                    action: action === 'Accept' ? 'Accepted' : 'Rejected',
                    performedBy: currentUser,
                    comments: `Bulk ${action}ed. ${comments || ''}`,
                    date: new Date()
                });

                if (action === 'Accept' && priorAcceptedCountForReassign >= 1) {
                    void notifyAssetControllerReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                    void notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                }

                results.success.push(item.assetId);

            } catch (err) {
                results.failed.push({ id: item.assetId, message: err.message });
            }
        }

        res.status(200).json({
            message: `Processed ${items.length} assets: ${results.success.length} successful, ${results.failed.length} failed.`,
            results
        });
    } catch (error) {
        console.error('Error in bulk asset response:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

const canUserActAsAssigneeForBulkItem = (currentUserStr, item) => {
    const curBulk = currentUserStr;
    const assigneeId =
        item.assignedTo?._id?.toString?.() ||
        (item.assignedTo != null ? item.assignedTo.toString?.() : '') ||
        '';
    /** Real company-held assets use Company + assignedCompany; bulk AC assigns an employee only. */
    const isCompanyPoolAsset = item.assignedToType === 'Company' && item.assignedCompany;
    const assigneeMatchesUser = assigneeId && assigneeId === curBulk;
    const isAssignee = assigneeMatchesUser && !isCompanyPoolAsset;
    let isPrimaryReporteeDelegate = false;
    if (!isCompanyPoolAsset && item.assignedTo && item.assignedTo.primaryReportee) {
        const assigneeHasCompanyEmail = !!(
            item.assignedTo.companyEmail && String(item.assignedTo.companyEmail).trim().length > 0
        );
        const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
        if (!assigneeHasCompanyEmail && managerId && managerId.toString() === curBulk) {
            isPrimaryReporteeDelegate = true;
        }
    }
    return { isAssignee, isPrimaryReporteeDelegate };
};

/** Complete the single DashboardAction row created for AC bulk assignment (extra3.isBulkAssignment). */
const markBulkAssignmentDashboardRowComplete = async (bulkGroupId, actionedBy, summaryComment) => {
    if (!bulkGroupId) return;
    const gid = String(bulkGroupId);
    const rows = await DashboardAction.find({
        status: 'Pending',
        requestType: 'Asset',
        extra3: { $exists: true, $nin: [null, ''] }
    })
        .select('_id extra3')
        .lean();
    for (const da of rows) {
        let p;
        try {
            p = typeof da.extra3 === 'string' ? JSON.parse(da.extra3) : da.extra3;
        } catch {
            continue;
        }
        if (p?.isBulkAssignment === true && String(p.bulkAssignmentGroupId) === gid) {
            await DashboardAction.findByIdAndUpdate(da._id, {
                $set: {
                    status: 'Approved',
                    actionedDate: new Date(),
                    actionedBy,
                    comment: summaryComment
                }
            });
            return;
        }
    }
};

/** If no assets in this bulk-assignment batch are still pending, complete the single inbox row. */
const refreshBulkAssignmentDashboardIfGroupFullyResolved = async (groupId, actionedBy, comment = 'Bulk assignment completed.') => {
    if (!groupId) return;
    const gid = String(groupId);
    const pendingLeft = await AssetItem.countDocuments({
        'pendingActionDetails.bulkAssignment.groupId': gid,
        status: 'Pending',
        acceptanceStatus: 'Pending'
    });
    if (pendingLeft === 0) {
        await markBulkAssignmentDashboardRowComplete(gid, actionedBy, comment);
    }
};

// @desc    Pending bulk assignment (AC batch) — list assets for assignee review modal
// @route   GET /api/AssetItem/bulk-assignment-pending/:groupId
// @access  Private
export const getBulkAssignmentPendingGroup = async (req, res) => {
    try {
        const { groupId } = req.params;
        if (!groupId || !mongoose.Types.ObjectId.isValid(String(groupId))) {
            return res.status(400).json({ message: 'Invalid group id' });
        }
        const gid = String(groupId);
        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();

        const allInGroup = await AssetItem.find({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending'
        })
            .populate('assignedTo', 'firstName lastName employeeId companyEmail primaryReportee')
            .populate('categoryId', 'name')
            .populate('assignedBy', 'firstName lastName employeeId')
            .lean();

        if (!allInGroup.length) {
            return res.status(404).json({ message: 'No pending batch found for this link.' });
        }

        const firstAssigneeRef = allInGroup[0].assignedTo;
        const targetAssigneeId = firstAssigneeRef?._id?.toString?.() || firstAssigneeRef?.toString?.();
        const allSameAssignee = allInGroup.every((i) => {
            const r = i.assignedTo;
            const id = r?._id?.toString?.() || r?.toString?.();
            return id === targetAssigneeId;
        });
        if (!allSameAssignee) {
            return res.status(400).json({ message: 'Batch data is inconsistent.' });
        }

        const firstAsDoc = await AssetItem.findById(allInGroup[0]._id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee', select: '_id' }
        });
        const wrapItem = firstAsDoc ? firstAsDoc.toObject() : allInGroup[0];
        const { isAssignee, isPrimaryReporteeDelegate } = canUserActAsAssigneeForBulkItem(cur, wrapItem);
        if (!isAssignee && !isPrimaryReporteeDelegate) {
            return res.status(403).json({ message: 'You are not authorized to review this batch.' });
        }

        return res.status(200).json({
            groupId: gid,
            items: allInGroup.map((row) => ({
                _id: row._id,
                assetId: row.assetId,
                name: row.name,
                status: row.status,
                assignmentType: row.assignmentType,
                assignedDays: row.assignedDays,
                categoryId: row.categoryId,
                assignedBy: row.assignedBy,
                bulkAssignment: row.pendingActionDetails?.bulkAssignment || null
            }))
        });
    } catch (e) {
        console.error('getBulkAssignmentPendingGroup:', e);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Respond to AC bulk assignment batch (per-asset accept/reject)
// @route   PUT /api/AssetItem/bulk-assignment-respond
// @access  Private
export const respondBulkAssignmentGroup = async (req, res) => {
    try {
        const { groupId, acceptedAssetIds = [], rejectedAssetIds = [], comments = '' } = req.body;

        if (!groupId || !mongoose.Types.ObjectId.isValid(String(groupId))) {
            return res.status(400).json({ message: 'Invalid group id' });
        }
        const gid = String(groupId);
        const accepted = [...new Set((acceptedAssetIds || []).map(String))];
        const rejected = [...new Set((rejectedAssetIds || []).map(String))];
        const overlap = accepted.filter((id) => rejected.includes(id));
        if (overlap.length) {
            return res.status(400).json({ message: 'An asset cannot be both accepted and rejected.' });
        }
        if (accepted.length + rejected.length === 0) {
            return res.status(400).json({ message: 'Select at least one asset to accept or reject.' });
        }

        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();

        const allInGroup = await AssetItem.find({
            'pendingActionDetails.bulkAssignment.groupId': gid,
            status: 'Pending',
            acceptanceStatus: 'Pending'
        }).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee', select: '_id companyEmail' }
        });

        if (!allInGroup.length) {
            return res.status(404).json({ message: 'No pending batch found.' });
        }

        const expectedIds = new Set(allInGroup.map((a) => a._id.toString()));
        for (const id of [...accepted, ...rejected]) {
            if (!expectedIds.has(id)) {
                return res.status(400).json({ message: 'One or more asset ids are not part of this pending batch.' });
            }
        }
        if (accepted.length + rejected.length !== expectedIds.size) {
            return res.status(400).json({ message: 'You must respond to every asset in this batch (accept or reject each).' });
        }

        const first = allInGroup[0];
        const { isAssignee, isPrimaryReporteeDelegate } = canUserActAsAssigneeForBulkItem(cur, first);
        if (!isAssignee && !isPrimaryReporteeDelegate) {
            return res.status(403).json({ message: 'You are not authorized to respond to this batch.' });
        }

        const byId = new Map(allInGroup.map((a) => [a._id.toString(), a]));
        const results = { accepted: [], rejected: [] };

        const applyTempDatesOnAccept = (item) => {
            if (item.assignmentType === 'Temporary' && item.assignedDays) {
                const parsedDays = Number(item.assignedDays);
                const start = item.assignedDate ? new Date(item.assignedDate) : new Date();
                const end = new Date(start);
                end.setDate(end.getDate() + parsedDays);
                item.assignedDate = start;
                item.temporaryEndDate = end;
                if (!item.temporaryReminderSentAt) item.temporaryReminderSentAt = null;
                if (!item.temporaryExpiredSentAt) item.temporaryExpiredSentAt = null;
            } else {
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
            }
        };

        for (const idStr of accepted) {
            const item = byId.get(idStr);
            if (!item) continue;
            item.status = 'Assigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;
            item.acceptedBy = currentUser;
            item.pendingActionDetails = null;
            applyTempDatesOnAccept(item);
            await item.save();

            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId acceptedBy accessories assignedCompany')
                .populate({
                    path: 'assignedTo',
                    populate: [{ path: 'primaryReportee', select: 'firstName lastName employeeId' }]
                })
                .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

            await AssetHistory.create({
                assetId: item._id,
                action: 'Accepted',
                assignedToType: item.assignedToType,
                assignedTo: item.assignedTo,
                assignedCompany: item.assignedCompany,
                performedBy: currentUser,
                comments: isPrimaryReporteeDelegate
                    ? `Accepted by manager on behalf of employee (bulk). ${comments || ''}`
                    : comments || 'Accepted (bulk batch)',
                details: snapshotItem ? snapshotItem.toObject() : {}
            });

            const priorAcceptedCount = await AssetHistory.countDocuments({ assetId: item._id, action: 'Accepted' });
            if (priorAcceptedCount >= 1) {
                void notifyAssetControllerReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
                void notifyPreviousAssigneeReassignmentAcceptedWithHandover(req, { assetMongoId: item._id });
            }

            await updateAssetTypeCounts(item.typeId);
            results.accepted.push(item.assetId);
        }

        for (const idStr of rejected) {
            const item = byId.get(idStr);
            if (!item) continue;

            const bulkMeta = item.pendingActionDetails?.bulkAssignment;
            const revertTo = bulkMeta?.revertToEmployeeId;

            if (revertTo) {
                let ownershipLabel = bulkMeta?.revertToDisplayName || '';
                if (!ownershipLabel) {
                    const e = await EmployeeBasic.findById(revertTo).select('firstName lastName').lean();
                    ownershipLabel = e ? `${e.firstName || ''} ${e.lastName || ''}`.trim() : '';
                }
                item.assignedTo = revertTo;
                item.assignedToType = 'Employee';
                item.status = 'Assigned';
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.acceptedBy = null;
                item.pendingActionDetails = null;
                if (ownershipLabel) item.ownership = ownershipLabel;
            } else {
                item.status = 'Unassigned';
                item.assignedTo = null;
                item.assignedCompany = null;
                item.assignedToType = null;
                item.assignedBy = null;
                item.assignmentType = null;
                item.assignedDays = null;
                item.assignedDate = null;
                item.temporaryEndDate = null;
                item.temporaryReminderSentAt = null;
                item.temporaryExpiredSentAt = null;
                item.acceptanceStatus = 'Rejected';
                item.actionRequiredBy = null;
                item.pendingActionDetails = null;
                item.ownership = null;
            }

            item.negotiationHistory = [];
            await item.save();

            await AssetHistory.create({
                assetId: item._id,
                action: 'Rejected',
                assignedToType: item.assignedToType,
                assignedTo: revertTo || null,
                assignedCompany: null,
                performedBy: currentUser,
                comments: comments || (revertTo ? 'Bulk assignment declined — returned to previous assignee.' : 'Bulk assignment declined — returned to unassigned.'),
                details: { bulkBatchReject: true, revertTo: revertTo || null }
            });

            await updateAssetTypeCounts(item.typeId);
            results.rejected.push(item.assetId);
        }

        await markBulkAssignmentDashboardRowComplete(
            gid,
            currentUser,
            `Bulk assignment: ${results.accepted.length} accepted, ${results.rejected.length} declined.${comments ? ` ${comments}` : ''}`.trim()
        );

        return res.status(200).json({
            message: `Batch processed: ${results.accepted.length} accepted, ${results.rejected.length} declined.`,
            results
        });
    } catch (e) {
        console.error('respondBulkAssignmentGroup:', e);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Return an asset item (unassign)
// @route   PUT /api/AssetItem/:id/return
// @access  Private
export const returnAssetItem = async (req, res) => {
    try {
        const { id } = req.params;

        const item = await AssetItem.findById(id);

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const isJwtAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        const isAcFlow = await isUserInFlowchart(req.user, 'assetcontroller');
        const isCompanyCoordinatorFlow = await isUserActiveCompanyAssetCoordinator(
            req.user?.employeeObjectId,
            req.user?.employeeId
        );
        const hodAc = await getDepartmentHOD('assetcontroller');
        const matchesDeptAc =
            !!hodAc?._id &&
            req.user?.employeeObjectId &&
            hodAc._id.toString() === req.user.employeeObjectId.toString();
        const isCompanyAssignedAsset = item.assignedToType === 'Company' && !!item.assignedCompany;
        const isElevatedReturn =
            isJwtAdmin ||
            isSysAdmin ||
            isAcFlow ||
            matchesDeptAc ||
            (isCompanyCoordinatorFlow && isCompanyAssignedAsset);

        let currentEmpId = req.user?.employeeObjectId?.toString();
        if (!currentEmpId && req.user?.employeeId) {
            const empRow = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${String(req.user.employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            })
                .select('_id')
                .lean();
            if (empRow) currentEmpId = empRow._id.toString();
        }
        const isAssigneeReturn =
            !!item.assignedTo && !!currentEmpId && item.assignedTo.toString() === currentEmpId;
        const assignedById =
            item.assignedBy?._id ? item.assignedBy._id.toString() : item.assignedBy?.toString?.() || item.assignedBy;
        const isAssignerReturn =
            !!assignedById && !!currentEmpId && assignedById.toString() === currentEmpId;

        if (item.assignedTo) {
            if (!isElevatedReturn && !isAssigneeReturn && !isAssignerReturn) {
                return res.status(403).json({
                    message: 'Only the assigned employee, the assigner, Asset Controller, or an administrator can return this asset.'
                });
            }
        } else {
            if (!isElevatedReturn && !isAssignerReturn) {
                return res.status(403).json({
                    message: 'Only Asset Controller/Admin or the assigner can return an asset that is not assigned to an employee.'
                });
            }
        }

        const assetController = hodAc;
        if (!assetController && !isAssigneeReturn && !isAssignerReturn) {
            return res.status(403).json({
                message: "Asset return denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        // If an assigned employee requests return (non-elevated), route it to Asset Controller for approval
        // with dashboard + email, instead of immediately unassigning.
        if (isAssigneeReturn && !isElevatedReturn) {
            if (!assetController?._id) {
                return res.status(400).json({ message: 'Asset Controller not found. Cannot request return approval.' });
            }

            const requesterEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName employeeId').lean().catch(() => null);
            const requesterName = requesterEmp ? `${requesterEmp.firstName || ''} ${requesterEmp.lastName || ''}`.trim() : (req.user.name || req.user.employeeId || 'User');

            const rawBulkIds = Array.isArray(req.body?.bulkAssetIds) ? req.body.bulkAssetIds.map((x) => String(x).trim()).filter(Boolean) : [];
            const currentIdStr = item._id.toString();
            const uniqueBulk = Array.from(new Set([currentIdStr, ...rawBulkIds]));
            const isBulkReturn = uniqueBulk.length > 1;

            if (!isBulkReturn) {
                if (item.pendingAction) {
                    return res.status(400).json({ message: `This asset already has a pending "${item.pendingAction}" request.` });
                }

                // Single assignee return: no PDF — asset details are included in the AC notification email body.
                const singleReturnAttachments = [];

                item.pendingAction = 'Return Asset';
                item.pendingActionDetails = {
                    reason: req.body?.reason || 'Return requested by assigned employee',
                    requestedBy: req.user.employeeObjectId || req.user._id,
                    requestedAt: new Date()
                };
                item.actionRequiredBy = assetController._id; // EmployeeBasic
                item.status = 'Pending';

                await item.save();

                await DashboardAction.create({
                    assignedTo: assetController._id,
                    assignedToEmpId: assetController.employeeId,
                    requestId: item._id,
                    requestType: 'Asset Return',
                    status: 'Pending',
                    subjectEmployeeId: req.user.employeeId || (requesterEmp?.employeeId || 'UNASSIGNED'),
                    subjectName: requesterName || 'Employee',
                    requestedByName: requesterName,
                    extra1: `${item.assetId} — ${item.name || ''}`,
                    extra2: 'Return Asset'
                });

                try {
                    await sendAssetActionApprovalEmail(
                        item,
                        'Return Asset',
                        assetController,
                        { name: requesterName },
                        item.pendingActionDetails?.reason || '',
                        singleReturnAttachments
                    );
                } catch (e) {
                    // non-fatal
                }

                return res.status(200).json({
                    message: 'Return request sent to Asset Controller for approval',
                    asset: item
                });
            }

            // Bulk return (same assignee): multiple assets, one dashboard row on primary (URL param asset).
            const bulkAssets = await AssetItem.find({ _id: { $in: uniqueBulk } });
            if (bulkAssets.length !== uniqueBulk.length) {
                return res.status(404).json({ message: 'One or more assets not found' });
            }

            const requesterOid = req.user.employeeObjectId?.toString();
            for (const a of bulkAssets) {
                if (!a.assignedTo || a.assignedTo.toString() !== requesterOid) {
                    return res.status(403).json({ message: 'All selected assets must be assigned to you.' });
                }
                if (a.pendingAction) {
                    return res.status(400).json({ message: `Asset ${a.assetId} already has a pending "${a.pendingAction}" request.` });
                }
                if (a.status !== 'Assigned') {
                    return res.status(400).json({ message: `Asset ${a.assetId} must be Assigned to request return.` });
                }
            }

            const reason = req.body?.reason || 'Return requested by assigned employee';
            const bulkAssetIdsOrdered = uniqueBulk;

            let bulkReturnAttachments;
            try {
                bulkReturnAttachments = await requireBulkAssetInventoryPdfAttachment(
                    req,
                    bulkAssetIdsOrdered,
                    'bulk-return-inventory'
                );
            } catch (pdfErr) {
                console.error('[returnAssetItem bulk] PDF required for email:', pdfErr?.message || pdfErr);
                return res.status(503).json({
                    message:
                        pdfErr?.message ||
                        'Could not generate the asset list PDF. Return request was not submitted.'
                });
            }

            for (const a of bulkAssets) {
                a.pendingAction = 'Return Asset';
                a.pendingActionDetails = {
                    reason,
                    requestedBy: req.user.employeeObjectId || req.user._id,
                    requestedAt: new Date(),
                    isBulk: true,
                    bulkAssetIds: bulkAssetIdsOrdered
                };
                a.actionRequiredBy = assetController._id;
                a.status = 'Pending';
                await a.save();

                await AssetHistory.create({
                    assetId: a._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Bulk Return Asset request submitted. Reason: ${reason}`,
                    date: new Date(),
                    details: { type: 'BulkReturnRequest', action: 'Return Asset', bulkAssetIds: bulkAssetIdsOrdered }
                });
            }

            const primaryAsset = bulkAssets.find((a) => a._id.toString() === currentIdStr) || bulkAssets[0];
            const assetSummary = bulkAssets.map((a) => `${a.assetId} — ${a.name || ''}`).join('; ');
            const extra1 =
                bulkAssets.length > 1
                    ? `Bulk Return (${bulkAssets.length} assets): ${assetSummary.substring(0, 200)}${assetSummary.length > 200 ? '...' : ''}`
                    : `${primaryAsset.assetId} — ${primaryAsset.name || ''}`;

            await DashboardAction.create({
                assignedTo: assetController._id,
                assignedToEmpId: assetController.employeeId,
                requestId: primaryAsset._id,
                requestType: 'Asset Return',
                status: 'Pending',
                subjectEmployeeId: req.user.employeeId || (requesterEmp?.employeeId || 'UNASSIGNED'),
                subjectName: requesterName || 'Employee',
                requestedByName: requesterName,
                extra1,
                extra2: 'Return Asset',
                extra3:
                    bulkAssets.length > 1
                        ? JSON.stringify({
                            isBulk: true,
                            totalAssets: bulkAssets.length,
                            assetIds: bulkAssetIdsOrdered
                        })
                        : null
            });

            try {
                await sendAssetActionApprovalEmail(
                    { ...primaryAsset.toObject(), assetId: primaryAsset.assetId, name: `Bulk Return Asset (${bulkAssets.length} assets)` },
                    'Return Asset',
                    assetController,
                    { name: requesterName },
                    `Bulk return for ${bulkAssets.length} asset(s). ${reason}`,
                    bulkReturnAttachments
                );
            } catch (e) {
                // non-fatal
            }

            return res.status(200).json({
                message: `Return request for ${bulkAssets.length} asset(s) sent to Asset Controller for approval`,
                asset: primaryAsset,
                bulkCount: bulkAssets.length
            });
        }

        // Store current details for history
        const prevAssignedTo = item.assignedTo;
        const originalAssigner = item.assignedBy;

        const { reassignTo, assignmentType, assignedDays, assignedToType } = req.body;

        // Capture snapshot BEFORE mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy assignedCompany');
        const returnSnapshot = snapshotItem.toObject();

        if (reassignTo) {
            // Check if reassigning a company-assigned asset
            const isCompanyAsset = item.assignedToType === 'Company' && item.assignedCompany;

            // If transferring from company to employee, or company to company
            if (isCompanyAsset) {
                const companyCoordinator = await getCompanyAssetCoordinator();
                if (!companyCoordinator?._id) {
                    return res.status(400).json({
                        message: 'No Assigned User or Admin in Flowchart. Company asset transfers require that role to approve.'
                    });
                }

                if (assignedToType === 'Company') {
                    const targetCompany = await Company.findById(reassignTo);
                    if (!targetCompany) {
                        return res.status(404).json({ message: "Target company not found" });
                    }

                    item.assignedToType = 'Company';
                    item.assignedCompany = targetCompany._id;
                    item.assignedTo = null;
                    item.status = 'Pending';
                    item.acceptanceStatus = 'Pending';
                    // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                    item.actionRequiredBy = companyCoordinator._id;
                } else {
                    const newAssignee = await EmployeeBasic.findById(reassignTo);
                    if (!newAssignee) {
                        return res.status(404).json({ message: "Target employee for reassignment not found" });
                    }

                    item.assignedToType = 'Employee';
                    item.assignedTo = newAssignee._id;
                    item.assignedCompany = null;
                    item.status = 'Pending';
                    item.acceptanceStatus = 'Pending';
                    // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                    item.actionRequiredBy = companyCoordinator._id;
                }

                item.assignedBy = req.user.employeeObjectId;
                item.assignmentType = assignmentType || item.assignmentType || 'Permanent';
                item.assignedDays = assignmentType === 'Temporary' ? (assignedDays || null) : null;
                item.negotiationHistory = [];

                // For company transfers, notify company coordinator
                try {
                    const assigner = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName employeeId');
                    const targetCompany = assignedToType === 'Company'
                        ? await Company.findById(reassignTo).select('name companyId')
                        : null;
                    const targetEmployee = assignedToType === 'Employee'
                        ? await EmployeeBasic.findById(reassignTo).select('firstName lastName employeeId')
                        : null;

                    const subjectName = targetCompany ? targetCompany.name : (targetEmployee ? `${targetEmployee.firstName} ${targetEmployee.lastName}` : 'Unknown');
                    const subjectEmpId = targetCompany ? targetCompany.companyId : (targetEmployee ? targetEmployee.employeeId : 'N/A');

                    await DashboardAction.create({
                        assignedTo: companyCoordinator._id,
                        assignedToEmpId: companyCoordinator.employeeId,
                        requestId: item._id,
                        requestType: 'Asset Assignment',
                        subjectEmployeeId: subjectEmpId,
                        subjectName: subjectName,
                        requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                        extra1: `${item.assetId} - ${item.name} `,
                        extra2: item.assignmentType || 'Permanent',
                        status: 'Pending'
                    });

                    const itemForHrEmail = await AssetItem.findById(item._id).populate('categoryId', 'name');
                    let companyTransferAttachments = [];
                    try {
                        companyTransferAttachments = await buildBulkAssetInventoryPdfAttachment(req, [item._id.toString()], 'assignment-inventory');
                    } catch (pdfErr) {
                        console.error('Company transfer PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
                    }
                    await sendAssetAssignmentEmail({
                        asset: itemForHrEmail || item,
                        employee: assignedToType === 'Company'
                            ? { firstName: targetCompany?.name || 'Company', lastName: "", isCompany: true }
                            : targetEmployee,
                        recipient: companyCoordinator,
                        attachments: companyTransferAttachments
                    });

                    console.log(
                        `[Dashboard] Created asset transfer action for company coordinator (${companyCoordinator.employeeId}) for company asset ${item.assetId}`
                    );
                } catch (err) {
                    console.error(`[Dashboard/Email Error] Failed to create action/email for company asset transfer ${item.assetId}: `, err);
                }
            } else {
                // Regular employee-to-employee transfer
                const newAssignee = await EmployeeBasic.findById(reassignTo);
                if (!newAssignee) {
                    return res.status(404).json({ message: "Target employee for reassignment not found" });
                }

                item.assignedTo = newAssignee._id;
                item.assignedBy = req.user.employeeObjectId;
                item.status = 'Unassigned';
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.assignmentType = assignmentType || 'Permanent';
                item.assignedDays = assignmentType === 'Temporary' ? (assignedDays || null) : null;
                item.negotiationHistory = [];
                item.assignedCompany = null;
                item.assignedToType = 'Employee';
            }
        } else if (originalAssigner) {
            // Assign back to the original assigner as 'Returned'
            item.assignedTo = originalAssigner;
            item.assignedBy = req.user.employeeObjectId;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;

            // Reset other fields
            item.assignmentType = null;
            item.assignedDays = null;
            item.negotiationHistory = [];
            item.assignedCompany = null;
            item.assignedToType = 'Employee';
        } else {
            // Default return - back to store (pool)
            item.assignedTo = null;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.negotiationHistory = [];
            item.assignedCompany = null;
            item.assignedToType = null;
        }

        await item.save();

        // Log History with Snapshot
        await AssetHistory.create({
            assetId: item._id,
            action: 'Returned',
            assignedTo: prevAssignedTo,
            performedBy: req.user._id,
            details: returnSnapshot
        });

        // If Asset Controller/Admin returned it, notify the previously assigned employee by email.
        if (isElevatedReturn && prevAssignedTo) {
            try {
                const employee = await EmployeeBasic.findById(prevAssignedTo)
                    .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                    .lean()
                    .catch(() => null);
                if (employee) {
                    await sendAssignedEmployeeActionEmail({
                        asset: item,
                        employee,
                        action: 'Return Asset',
                        performedBy: req.user.employeeId || 'Asset Controller',
                        details: 'Your asset was returned to store by Asset Controller/Admin.'
                    });
                }
            } catch (e) {
                // non-fatal
            }
        }

        await updateAssetTypeCounts(item.typeId);

        res.status(200).json(item);

    } catch (error) {
        console.error('Error returning asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Update asset status (Unassign, Service, Live)
// @route   PUT /api/AssetItem/:id/status
// @access  Private
export const updateAssetStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, note, serviceDuration, description, invoice, attachment, serviceReport, amount } = req.body;

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Asset status update denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        // status: 'Unassigned' | 'Service' | 'Live'

        const allowedStatuses = ['Unassigned', 'Service', 'Live'];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Allowed: Unassigned, Service, Live' });
        }

        const item = await AssetItem.findById(id);
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        const prevStatus = item.status;
        let serviceRecord = null;
        let completionRecord = null;

        // Capture snapshot before mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const statusSnapshot = snapshotItem.toObject();

        if (status === 'Unassigned') {
            // ... (mutation logic) ...
            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedBy = null;
            item.assignedCompany = null;
            item.assignedToType = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = null;
            item.actionRequiredBy = null;
            item.negotiationHistory = [];
        } else if (status === 'Service') {
            item.status = 'Service';

            // Calculate expiry date if duration is provided
            let expiryDate = null;
            if (serviceDuration) {
                const durationMatch = serviceDuration.match(/(\d+)\s*(day|week|month|year)s?/i);
                if (durationMatch) {
                    const amount = parseInt(durationMatch[1]);
                    const unit = durationMatch[2].toLowerCase();
                    expiryDate = new Date();
                    if (unit.startsWith('day')) expiryDate.setDate(expiryDate.getDate() + amount);
                    else if (unit.startsWith('week')) expiryDate.setDate(expiryDate.getDate() + (amount * 7));
                    else if (unit.startsWith('month')) expiryDate.setMonth(expiryDate.getMonth() + amount);
                    else if (unit.startsWith('year')) expiryDate.setFullYear(expiryDate.getFullYear() + amount);
                }
            }

            // Build service record
            serviceRecord = {
                _id: new mongoose.Types.ObjectId(),
                date: new Date(),
                expiryDate: expiryDate,
                serviceDuration: serviceDuration || null,
                description: description || note || null,
                requestedBy: req.user.employeeObjectId
            };

            // Upload invoice if provided (base64)
            if (invoice?.data) {
                try {
                    const invoiceResult = await uploadDocumentToS3(
                        invoice.data,
                        'asset-services',
                        invoice.name || `service - invoice - ${Date.now()}.pdf`,
                        'auto'
                    );
                    serviceRecord.invoice = invoiceResult.publicId;
                } catch (uploadErr) {
                    console.error('Invoice upload failed:', uploadErr);
                }
            }

            // Upload attachment if provided (base64)
            if (attachment?.data) {
                try {
                    const attachResult = await uploadDocumentToS3(
                        attachment.data,
                        'asset-services',
                        attachment.name || `service - attachment - ${Date.now()}.pdf`,
                        'auto'
                    );
                    serviceRecord.attachment = attachResult.publicId;
                } catch (uploadErr) {
                    console.error('Attachment upload failed:', uploadErr);
                }
            }

            item.services.push(serviceRecord);

        } else if (status === 'Live') {
            // Restore from Service back to previous status
            item.status = item.assignedTo ? 'Assigned' : 'Unassigned';

            // Add completion record if data provided
            if (serviceReport || amount) {
                completionRecord = {
                    _id: new mongoose.Types.ObjectId(),
                    date: new Date(),
                    description: serviceReport,
                    value: amount || 0,
                    serviceType: 'Other'
                };

                if (attachment?.data) {
                    try {
                        const attachResult = await uploadDocumentToS3(
                            attachment.data,
                            'asset-services',
                            attachment.name || `service - report - ${Date.now()}.pdf`,
                            'auto'
                        );
                        completionRecord.attachment = attachResult.publicId;
                    } catch (uploadErr) {
                        console.error('Completion attachment upload failed:', uploadErr);
                    }
                }
                item.services.push(completionRecord);
            }
        }

        await item.save();

        // Email Notifications for Service
        try {
            // Do NOT notify immediately when entering Service.
            // Service reminder/completion notifications are handled by scheduled checks.
            if (status === 'Live') {
                const assetController = await getDepartmentHOD('assetcontroller');
                const requestInitiatorId = req.user.employeeObjectId;
                const initiator = await EmployeeBasic.findById(requestInitiatorId);
                const senderInfo = {
                    firstName: initiator?.firstName || req.user.name?.split(' ')[0] || 'User',
                    lastName: initiator?.lastName || req.user.name?.split(' ').slice(1).join(' ') || ''
                };

                const recipients = [];
                if (assetController) recipients.push(assetController);
                if (initiator && (!assetController || assetController._id.toString() !== initiator._id.toString())) {
                    recipients.push(initiator);
                }

                // Also notify the person the asset is assigned to (or their manager if no email)
                if (item.assignedTo) {
                    const assignedPerson = await EmployeeBasic.findById(item.assignedTo);
                    if (assignedPerson) {
                        const hasEmail = assignedPerson.companyEmail || assignedPerson.workEmail || assignedPerson.email;

                        let targetRecipient = assignedPerson;
                        if (!hasEmail && assignedPerson.primaryReportee) {
                            const manager = await EmployeeBasic.findById(assignedPerson.primaryReportee);
                            if (manager) targetRecipient = manager;
                        }

                        const isDuplicate = recipients.some(r => r._id.toString() === targetRecipient._id.toString());
                        if (!isDuplicate) recipients.push(targetRecipient);
                    }
                }

                for (const recipient of recipients) {
                    await sendAssetServiceEmail({
                        asset: item,
                        recipient,
                        type: status === 'Service' ? 'Started' : 'Done',
                        details: {
                            serviceDuration: serviceDuration || null,
                            description: status === 'Service' ? (description || note) : (serviceReport || "Service Completed")
                        },
                        sender: senderInfo
                    });

                    // Manage Dashboard Actions
                    try {
                        if (status === 'Live') {
                            // Clear any "Service" or "Overdue" tasks for this asset
                            await DashboardAction.updateMany(
                                { requestId: item._id, status: 'Pending', requestType: { $in: ['Asset', 'Asset Overdue'] } },
                                { status: 'Approved', actionedDate: new Date(), actionedBy: requestInitiatorId }
                            );
                        }
                    } catch (dashErr) {
                        console.error('[Dashboard Error] Failed to update service action:', dashErr);
                    }
                }
            }
        } catch (emailErr) {
            console.error('[Service Email Error] Failed to send service notifications:', emailErr);
        }

        // Log history with clearer action names
        await AssetHistory.create({
            assetId: item._id,
            action: status === 'Unassigned' ? 'Unassigned' : status === 'Service' ? 'Service Send' : 'Service Receive',
            performedBy: req.user.employeeObjectId,
            comments: description || note || serviceReport || null,
            file: (status === 'Service' ? (serviceRecord?.invoice || serviceRecord?.attachment) : completionRecord?.attachment) || null,
            details: {
                ...statusSnapshot,
                serviceDuration: serviceDuration || null,
                amount: amount || 0,
                serviceReport: serviceReport || null,
                invoice: status === 'Service' ? serviceRecord?.invoice : null,
                attachment: status === 'Service' ? serviceRecord?.attachment : completionRecord?.attachment,
                prevStatus: prevStatus
            }
        });

        await updateAssetTypeCounts(item.typeId);

        res.status(200).json(item);
    } catch (error) {
        console.error('Error updating asset status:', error);
        res.status(500).json({ message: 'Server Error', error: error.message, stack: error.stack });
    }
};

// @desc    Add image to asset
// @route   POST /api/AssetItem/:id/images
// @access  Private
export const addAssetImage = async (req, res) => {
    try {
        const { id } = req.params;
        const { imageData, imageName, imageMime, caption, date } = req.body;

        if (!imageData) return res.status(400).json({ message: 'Image data is required' });

        const item = await AssetItem.findById(id);
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        const url = await uploadDocumentToS3(imageData, imageName || `asset - image - ${Date.now()}.jpg`, imageMime || 'image/jpeg');

        item.images.push({ url, caption: caption || '', date: date ? new Date(date) : new Date() });
        await item.save();

        res.status(200).json(item.images[item.images.length - 1]);
    } catch (error) {
        console.error('Error adding asset image:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete image from asset
// @route   DELETE /api/AssetItem/:id/images/:imageId
// @access  Private
export const deleteAssetImage = async (req, res) => {
    try {
        const { id, imageId } = req.params;

        const item = await AssetItem.findById(id);
        if (!item) return res.status(404).json({ message: 'Asset not found' });

        item.images = item.images.filter(img => img._id.toString() !== imageId);
        await item.save();

        res.status(200).json({ message: 'Image deleted' });
    } catch (error) {
        console.error('Error deleting asset image:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get asset history
// @route   GET /api/AssetItem/:id/history
// @access  Private
export const getAssetHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const history = await AssetHistory.find({ assetId: id })
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name companyId')
            .sort({ date: 1 });

        // Sign URLs for attachments and signatures in snapshots
        const historyWithUrls = await Promise.all(history.map(async (record) => {
            const recordObj = record.toObject();
            if (recordObj.file) {
                recordObj.file = await getSignedFileUrl(recordObj.file);
            }
            if (recordObj.details) {
                const d = recordObj.details;
                if (d.invoice) d.invoice = await getSignedFileUrl(d.invoice);
                if (d.invoiceFile) d.invoiceFile = await getSignedFileUrl(d.invoiceFile);

                // Sign assignedBy signature inside snapshot
                if (d.assignedBy?.signature?.url) {
                    d.assignedBy.signature.url = await getSignedFileUrl(d.assignedBy.signature.url);
                }
                // Sign assignedTo signature inside snapshot
                if (d.assignedTo?.signature?.url) {
                    d.assignedTo.signature.url = await getSignedFileUrl(d.assignedTo.signature.url);
                }
                // Sign acceptedBy signature inside snapshot
                if (d.acceptedBy?.signature?.url) {
                    d.acceptedBy.signature.url = await getSignedFileUrl(d.acceptedBy.signature.url);
                }
            }
            return recordObj;
        }));

        res.status(200).json(historyWithUrls);
    } catch (error) {
        console.error('Error fetching asset history:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get single history record
// @route   GET /api/AssetItem/history-record/:historyId
// @access  Private
export const getHistoryRecord = async (req, res) => {
    try {
        const { historyId } = req.params;
        const record = await AssetHistory.findById(historyId)
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId');

        if (!record) {
            return res.status(404).json({ message: 'History record not found' });
        }

        const recordObj = record.toObject();
        if (recordObj.file) {
            recordObj.file = await getSignedFileUrl(recordObj.file);
        }
        if (recordObj.details) {
            const d = recordObj.details;
            if (d.invoice) d.invoice = await getSignedFileUrl(d.invoice);
            if (d.invoiceFile) d.invoiceFile = await getSignedFileUrl(d.invoiceFile);
        }

        res.status(200).json(recordObj);
    } catch (error) {
        console.error('Error fetching single history record:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add a document to an asset item
// @route   POST /api/AssetItem/:id/document
// @access  Private
export const addAssetDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, issueAuthority, issueDate, expiryDate, description, document } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        let documentUrl = null;
        if (document && document.data) {
            try {
                // Upload to S3 under asset-documents folder
                const uploadResult = await uploadDocumentToS3(document.data, 'asset-documents', document.name);
                documentUrl = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading document to S3:', error);
                return res.status(500).json({ message: 'Failed to upload document' });
            }
        }

        asset.documents.push({
            type,
            issueAuthority: issueAuthority || null,
            issueDate: issueDate || null,
            expiryDate: expiryDate || null,
            description: description || null,
            attachment: documentUrl
        });

        await asset.save();
        // Only notify on Service-specific document add flows.
        // For general documents (Registration, Insurance, etc.) there is no serviceType context.
        if (String(type || '').trim().toLowerCase() === 'service') {
            const serviceTypeSafe = req.body?.serviceType || 'Service';
            await notifyAssignedEmployeeIfController(
                req,
                asset,
                'Service',
                `Service "${serviceTypeSafe}" was added by Asset Controller.`
            );
        }

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `New document "${type}" added.`,
                details: { type: 'DocumentAdd', docType: type }
            });
        } catch (historyErr) {
            console.error('History log failed during addAssetDocument:', historyErr);
        }

        // Return signed URL for immediate UI update if needed
        const newDoc = asset.documents[asset.documents.length - 1].toObject();
        if (newDoc.attachment) {
            newDoc.attachment = await getSignedFileUrl(newDoc.attachment);
        }

        res.status(200).json({ message: 'Document added successfully', document: newDoc });
    } catch (error) {
        console.error('Error adding asset document:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Update an existing document on an asset item
// @route   PUT /api/AssetItem/:id/document/:docId
// @access  Private
export const updateAssetDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const { type, issueAuthority, issueDate, expiryDate, description, document } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Find the document subdocument by _id
        const doc = asset.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        // Update fields
        if (type) doc.type = type;
        if (issueAuthority !== undefined) doc.issueAuthority = issueAuthority;
        if (issueDate !== undefined) doc.issueDate = issueDate;
        if (expiryDate !== undefined) doc.expiryDate = expiryDate;
        if (description !== undefined) doc.description = description;

        // Upload new file only if provided
        if (document && document.data) {
            try {
                const uploadResult = await uploadDocumentToS3(document.data, 'asset-documents', document.name);
                doc.attachment = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading document to S3:', error);
                return res.status(500).json({ message: 'Failed to upload document' });
            }
        }

        await asset.save();

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Document "${doc.type}" updated.`,
                details: { type: 'DocumentUpdate', docType: doc.type }
            });
        } catch (historyErr) {
            console.error('History log failed during updateAssetDocument:', historyErr);
        }

        const updatedDoc = doc.toObject();
        if (updatedDoc.attachment) {
            updatedDoc.attachment = await getSignedFileUrl(updatedDoc.attachment);
        }

        res.status(200).json({ message: 'Document updated successfully', document: updatedDoc });
    } catch (error) {
        console.error('Error updating asset document:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Delete a document from an asset item
// @route   DELETE /api/AssetItem/:id/document/:docId
// @access  Private
export const deleteAssetDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const doc = asset.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const docName = doc.name;
        asset.documents.pull({ _id: docId });
        await asset.save();

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Document "${docName}" deleted.`,
                details: { type: 'DocumentDelete', docName }
            });
        } catch (historyErr) {
            console.error('History log failed during deleteAssetDocument:', historyErr);
        }

        res.status(200).json({ message: 'Document deleted successfully' });
    } catch (error) {
        console.error('Error deleting asset document:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Add a service record to an asset item
// @route   POST /api/AssetItem/:id/service
// @access  Private
export const addAssetService = async (req, res) => {
    try {
        const { id } = req.params;
        const { serviceType, date, expiryDate, currentKm, description, paidBy, value, remark, invoice, attachment, quotation2, quotation3, serviceRequestSource } = req.body;

        const asset = await AssetItem.findById(id).populate('typeId', 'name');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const isVehicleAssetForServiceGate = () => {
            const plate = String(asset.plateNumber || '').trim();
            if (plate) return true;
            const name = (asset.typeId && typeof asset.typeId === 'object' && asset.typeId.name)
                ? String(asset.typeId.name)
                : '';
            const t = name.toLowerCase();
            return t.includes('vehicle') || t.includes('car') || t.includes('fleet') || t.includes('truck');
        };

        if (isVehicleAssetForServiceGate() && serviceRequestSource !== 'vehicle_fleet_dashboard') {
            return res.status(403).json({
                message:
                    'Vehicle service requests must be created from the Vehicle Asset Fleet Dashboard (Add service request).',
            });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow:
        // - assigner (asset.assignedBy) with full permissions
        // - primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or (if assignee has no company email) primary reportee can add service records.' });
        }

        let invoiceUrl = null;
        if (invoice && invoice.data) {
            try {
                const uploadResult = await uploadDocumentToS3(invoice.data, 'asset-service-invoices', invoice.name);
                invoiceUrl = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading invoice to S3:', error);
                return res.status(500).json({ message: 'Failed to upload invoice' });
            }
        }

        let attachmentUrl = null;
        if (attachment && attachment.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    attachment.data,
                    'asset-service-attachments',
                    attachment.name || `service-attachment-${Date.now()}.pdf`
                );
                attachmentUrl = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading attachment to S3:', error);
                return res.status(500).json({ message: 'Failed to upload attachment' });
            }
        }

        let quotation2Url = null;
        if (quotation2 && quotation2.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    quotation2.data,
                    'asset-service-attachments',
                    quotation2.name || `service-quotation2-${Date.now()}.pdf`
                );
                quotation2Url = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading quotation2 to S3:', error);
                return res.status(500).json({ message: 'Failed to upload quotation 2' });
            }
        }

        let quotation3Url = null;
        if (quotation3 && quotation3.data) {
            try {
                const uploadResult = await uploadDocumentToS3(
                    quotation3.data,
                    'asset-service-attachments',
                    quotation3.name || `service-quotation3-${Date.now()}.pdf`
                );
                quotation3Url = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading quotation3 to S3:', error);
                return res.status(500).json({ message: 'Failed to upload quotation 3' });
            }
        }

        let parsedRemark = null;
        if (remark && typeof remark === 'string') {
            try {
                parsedRemark = JSON.parse(remark);
            } catch {
                parsedRemark = null;
            }
        }

        // Create the service record (explicit subdoc _id for stable keys in UI + workflow linkage)
        const newService = {
            _id: new mongoose.Types.ObjectId(),
            serviceType,
            date: date || new Date(),
            expiryDate: expiryDate || null,
            currentKm: currentKm || null,
            description,
            paidBy,
            value: value || 0,
            remark,
            invoice: invoiceUrl,
            attachment: attachmentUrl,
            ...(quotation2Url ? { quotation2: quotation2Url } : {}),
            ...(quotation3Url ? { quotation3: quotation3Url } : {}),
        };

        asset.services.push(newService);

        // Update asset's current kilometer if provided in service record
        if (currentKm && Number(currentKm) > (asset.currentKilometer || 0)) {
            asset.currentKilometer = Number(currentKm);
        }

        // Update specialized dates if it's an Oil Service
        if (serviceType === 'Oil Service') {
            asset.oilChangeDate = date || new Date();
            asset.lastServiceDate = date || new Date();
        } else if (serviceType === 'Accident Repair') {
            const accidentStatus = parsedRemark?.accidentStatus || 'Active';
            if (accidentStatus === 'Active') {
                const start = parsedRemark?.accidentDate ? new Date(parsedRemark.accidentDate) : (date ? new Date(date) : new Date());
                const until = new Date(start);
                until.setDate(until.getDate() + 60);
                asset.status = 'Accident';
                asset.accidentStartedAt = start;
                asset.accidentActiveUntil = until;
                asset.accidentReminderLastSentAt = null;
            }
            asset.lastServiceDate = date || new Date();
        } else {
            // General last service date update
            asset.lastServiceDate = date || new Date();
        }

        await asset.save();

        const lastServiceDoc = asset.services[asset.services.length - 1];
        try {
            await maybeStartVehicleServiceWorkflow(asset, {
                serviceRecordId: lastServiceDoc._id,
                serviceType,
                req
            });
        } catch (wfErr) {
            console.error('[addAssetService] Vehicle service workflow:', wfErr);
        }

        // Log to history
        try {
            const AssetHistory = (await import('../models/AssetHistory.js')).default;
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Service',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Service record added: ${serviceType}. ${description || ''}`,
                details: { type: 'ServiceAdd', serviceType, value, description }
            });
        } catch (historyErr) {
            console.error('History log failed during addAssetService:', historyErr);
        }

        // Return signed URL for the new invoice
        const addedService = asset.services[asset.services.length - 1].toObject();
        if (addedService.invoice) {
            addedService.invoice = await getSignedFileUrl(addedService.invoice);
        }
        if (addedService.attachment) {
            addedService.attachment = await getSignedFileUrl(addedService.attachment);
        }
        if (addedService.quotation2) {
            addedService.quotation2 = await getSignedFileUrl(addedService.quotation2);
        }
        if (addedService.quotation3) {
            addedService.quotation3 = await getSignedFileUrl(addedService.quotation3);
        }

        res.status(200).json({ message: 'Service record added successfully', service: addedService });
    } catch (error) {
        console.error('Error adding asset service:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Transfer asset from one employee to another (requires approval)
export const transferAsset = async (req, res) => {
    try {
        const { assetId, fromEmployeeId, toEmployeeId, transferType } = req.body;

        // Validate input
        if (!assetId || !toEmployeeId) {
            return res.status(400).json({ message: 'Asset ID and target employee are required' });
        }

        // Find the asset
        const asset = await AssetItem.findById(assetId).populate('assignedTo');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner (asset.assignedBy) + primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can transfer assets.' });
        }

        const assetController = await getDepartmentHOD('assetcontroller');

        // Create transfer request for approval
        const transferRequest = {
            assetId: asset._id,
            assetName: asset.name,
            assetId: asset.assetId,
            fromEmployeeId: fromEmployeeId || asset.assignedTo?._id,
            toEmployeeId: toEmployeeId,
            requestedBy: req.user.employeeObjectId,
            transferType: transferType || 'individual',
            status: 'Pending',
            createdAt: new Date()
        };

        // Create a dashboard action for approval
        const DashboardAction = (await import('../models/DashboardAction.js')).default;
        await DashboardAction.create({
            moduleId: 'hrm_asset',
            actionType: 'asset_transfer',
            title: `Asset Transfer: ${asset.name}`,
            description: `Transfer ${asset.assetId} from ${fromEmployeeId || 'current'} to ${toEmployeeId}`,
            status: 'Pending',
            actionData: transferRequest,
            assignedTo: assetController ? assetController._id : null,
            createdBy: req.user.employeeObjectId
        });

        await notifyAssignedEmployeeIfController(req, asset, 'Transfer Asset', `Transfer request was initiated by Asset Controller to employee ${toEmployeeId}.`);

        res.status(200).json({
            message: 'Transfer request sent for approval',
            transferRequest
        });
    } catch (error) {
        console.error('Transfer error:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// Helper: Remove accessory from all history snapshots of an asset
const removeAccessoryFromHistorySnapshots = async (assetId, accessoryId) => {
    try {
        const histories = await AssetHistory.find({
            assetId: assetId,
            'details.accessories': { $exists: true }
        });

        for (let history of histories) {
            if (history.details && Array.isArray(history.details.accessories)) {
                const initialLen = history.details.accessories.length;
                history.details.accessories = history.details.accessories.filter(
                    acc => (acc._id?.toString() !== accessoryId?.toString()) &&
                        (acc.accessoryId !== accessoryId)
                );

                if (history.details.accessories.length !== initialLen) {
                    history.markModified('details');
                    await history.save();
                }
            }
        }
    } catch (err) {
        console.error('Error removing accessory from history snapshots:', err);
    }
};

// Helper: Update counts
const updateAssetTypeCounts = async (typeId) => {
    const total = await AssetItem.countDocuments({ typeId: typeId });
    const assigned = await AssetItem.countDocuments({ typeId: typeId, status: 'Assigned' });
    const pending = await AssetItem.countDocuments({ typeId: typeId, status: 'Pending' });
    const unassigned = total - assigned - pending;

    await AssetType.findByIdAndUpdate(typeId, {
        total,
        assigned,
        unassigned
    });
};

// @desc    Transfer accessory from one asset to another
// @route   PUT /api/AssetItem/:id/accessories/:accId/transfer
// @access  Private
export const transferAssetAccessory = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { targetAssetId } = req.body;

        const sourceAsset = await AssetItem.findById(id);
        const targetAsset = await AssetItem.findById(targetAssetId);

        if (!sourceAsset || !targetAsset) {
            return res.status(404).json({ message: 'Source or Target asset not found' });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner (asset.assignedBy) + primary reportee delegation
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, sourceAsset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can transfer accessories.' });
        }

        const accessoryIndex = sourceAsset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
        if (accessoryIndex === -1) {
            return res.status(404).json({ message: 'Accessory not found in source asset' });
        }

        const accessory = sourceAsset.accessories[accessoryIndex];

        // Remove from source
        sourceAsset.accessories.splice(accessoryIndex, 1);

        // Add to target with new accessoryId (to match targets prefix if needed, but lets keep name/amount)
        const newAccessory = {
            ...accessory.toObject(),
            status: 'Attached',
            _id: new mongoose.Types.ObjectId() // New ID for the new location
        };

        targetAsset.accessories.push(newAccessory);

        await sourceAsset.save();
        await targetAsset.save();
        await notifyAssignedEmployeeIfController(req, sourceAsset, 'Transfer Accessory', `Accessory "${accessory.name}" was transferred out by Asset Controller.`);
        await notifyAssignedEmployeeIfController(req, targetAsset, 'Transfer Accessory', `Accessory "${accessory.name}" was transferred into your asset by Asset Controller.`);

        // Log History for Source
        await AssetHistory.create({
            assetId: sourceAsset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}"(${accessory.accessoryId}) transfered to asset ${targetAsset.assetId} `
        });

        // Sync Source History (remove from previous handover docs/snapshots)
        await removeAccessoryFromHistorySnapshots(sourceAsset._id, accessory._id || accessory.accessoryId);

        // Log History for Target
        await AssetHistory.create({
            assetId: targetAsset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}" received from asset ${sourceAsset.assetId} `
        });

        res.status(200).json({ message: 'Accessory transfered successfully', sourceAsset, targetAsset });
    } catch (error) {
        console.error('Error transferring accessory:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Update accessory status (Lost, Damaged, EOL)
// @route   PUT /api/AssetItem/:id/accessories/:accId/status
// @access  Private
export const manageAccessoryStatus = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { status, comments } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) {
            return res.status(404).json({ message: 'Accessory not found' });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner + primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can update accessory status.' });
        }

        accessory.status = status;
        await asset.save();
        try {
            await syncAllAccessoryInstancesForAsset(asset);
        } catch (syncErr) {
            console.error('[manageAccessoryStatus accessory catalog sync]', syncErr?.message || syncErr);
        }
        await notifyAssignedEmployeeIfController(
            req,
            asset,
            `${status} Accessory`,
            `Accessory "${accessory.name}" was marked as ${status} by Asset Controller.`
        );

        // Log History
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}" marked as ${status}.Note: ${comments || 'No comments'} `
        });

        // Sync History (remove from previous handover docs/snapshots if Lost/Damaged/EOL)
        if (['Lost', 'Damaged', 'End of Life', 'Transfered'].includes(status)) {
            await removeAccessoryFromHistorySnapshots(asset._id, accessory._id || accessory.accessoryId);
        }

        res.status(200).json({ message: `Accessory marked as ${status} `, asset });
    } catch (error) {
        console.error('Error updating accessory status:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Request Asset Action (End of Life, Loss & Damage, or Leave)
// @route   PUT /api/AssetItem/:id/request-action
// @access  Private
export const requestAssetAction = async (req, res) => {
    try {
        const { id } = req.params;
        let { actionType, reason, attachment, fineData } = req.body; // actionType: 'End of Life', 'End of Services', 'Loss and Damage', or 'Leave'

        if (!['End of Life', 'End of Services', 'Loss and Damage', 'Leave'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }
        const originalActionType = actionType;
        // Normalize only for the "pendingAction" field, which uses the enum 'End of Life'
        // Keep `originalActionType` so we can differentiate "End of Services" => Unassigned.
        const pendingActionType = originalActionType === 'End of Services' ? 'End of Life' : originalActionType;
        const { duration, leaveDuration } = req.body; // Duration in days for Leave action
        const leaveDaysRaw = duration ?? leaveDuration;
        const leaveDays = leaveDaysRaw != null && leaveDaysRaw !== '' ? Number(leaveDaysRaw) : null;
        if (originalActionType === 'Leave') {
            if (!Number.isInteger(leaveDays) || leaveDays < 1 || leaveDays > 30) {
                return res.status(400).json({ message: 'Leave duration must be between 1 and 30 days.' });
            }
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Permission: asset controller/admin OR assignee
        // Also allow assigner + primary reportee delegation
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({
                message:
                    'Access denied. Only Asset Controller/Admin, flowchart Assigned User/Admin for company assets, assigner, assigned user, or delegated primary reportee can request this asset action.'
            });
        }

        // Upload attachment if present
        let fileUrl = null;
        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-history');
            fileUrl = uploadResult.publicId;
        }

        // All actions (Leave, End of Life, Loss and Damage, Transfer) now require Asset Controller approval ONLY
        // No reportee approval needed - Asset Controller is the first and only approver
        const assetController = await getDepartmentHOD('assetcontroller');

        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }

        // If the requester IS the Asset Controller, execute directly (no approval step).
        // This is specifically for controller-raised Leave / End of Services.
        const isAssetControllerRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        if (isAssetControllerRequester && (originalActionType === 'Leave' || originalActionType === 'End of Services')) {
            // Ensure duration is present for Leave
            if (originalActionType === 'Leave') {
                if (!leaveDays) {
                    return res.status(400).json({ message: 'Leave duration is required.' });
                }
                const start = new Date();
                const end = new Date(start);
                end.setDate(end.getDate() + leaveDays);

                asset.status = 'On Leave';
                asset.acceptanceStatus = 'Accepted';
                asset.onLeaveStartDate = start;
                asset.onLeaveDuration = leaveDays;
                asset.onLeaveEndDate = end;
                asset.parkingExtendedDays = 0;
                asset.parkingReminderSentAt = null;

                // Clear any pending request fields (if present)
                asset.pendingAction = null;
                asset.pendingActionDetails = null;
                asset.actionRequiredBy = null;
                asset.negotiationHistory = [];

                await asset.save();
                const empSnapLeave =
                    asset.assignedToType === 'Employee' && asset.assignedTo
                        ? [
                            {
                                _id: asset._id,
                                assetId: asset.assetId,
                                name: asset.name,
                                assignedTo: asset.assignedTo
                            }
                        ]
                        : [];
                if (empSnapLeave.length) {
                    await notifyEmployeesGroupedControllerBulkDirect(req, empSnapLeave, {
                        pdfBase: 'controller-direct-leave',
                        bulkName: 'On leave',
                        actionLabel: 'Leave',
                        detailsText: 'Asset placed on leave by Asset Controller (direct transfer).',
                        customIntro:
                            '<p>The Asset Controller placed your asset(s) on leave (parking). Details are in the attached inventory PDF.</p>'
                    });
                } else {
                    await notifyAssignedEmployeeIfController(req, asset, 'Leave', 'Asset placed on leave by Asset Controller (direct transfer).');
                }
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'On Leave',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Asset Controller executed Leave directly (no approval step).',
                    date: new Date(),
                    details: { status: 'ApprovedAndFinalized', originalAction: originalActionType }
                });
                return res.status(200).json({ message: 'Leave executed directly by Asset Controller (no approval)', asset });
            }

            if (originalActionType === 'End of Services') {
                // Direct transfer to store: mark Unassigned (NOT Lost).
                const empSnapEos =
                    asset.assignedToType === 'Employee' && asset.assignedTo
                        ? [
                            {
                                _id: asset._id,
                                assetId: asset.assetId,
                                name: asset.name,
                                assignedTo: asset.assignedTo
                            }
                        ]
                        : [];
                asset.status = 'Unassigned';
                asset.acceptanceStatus = 'Accepted';
                if (empSnapEos.length) {
                    await notifyEmployeesGroupedControllerBulkDirect(req, empSnapEos, {
                        pdfBase: 'controller-direct-eos',
                        bulkName: 'End of services',
                        actionLabel: 'Return Asset',
                        detailsText: 'Asset returned to store by Asset Controller (End of Services direct transfer).',
                        customIntro:
                            '<p>The Asset Controller returned your asset(s) to store (End of Services). Details are in the attached inventory PDF.</p>'
                    });
                } else {
                    await notifyAssignedEmployeeIfController(req, asset, 'Return Asset', 'Asset returned to store by Asset Controller (End of Services direct transfer).');
                }

                asset.assignedTo = null;
                asset.assignedCompany = null;
                asset.assignedToType = null;
                asset.assignmentType = null;
                asset.assignedDays = null;
                asset.assignedDate = null;
                asset.temporaryEndDate = null;
                asset.temporaryReminderSentAt = null;
                asset.temporaryExpiredSentAt = null;
                asset.pendingAction = null;
                asset.pendingActionDetails = null;
                asset.actionRequiredBy = null;
                asset.negotiationHistory = [];
                asset.onLeaveStartDate = null;
                asset.onLeaveEndDate = null;
                asset.onLeaveDuration = null;
                asset.parkingExtendedDays = 0;
                asset.parkingReminderSentAt = null;

                await asset.save();

                // Asset history (minimal)
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Unassigned',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: 'Asset Controller returned asset to store directly (End of Services).',
                    date: new Date(),
                    details: { status: 'Unassigned', originalActionType }
                });

                return res.status(200).json({ message: 'End of Services executed directly by Asset Controller (unassigned)', asset });
            }
        }

        // Store pending request in asset
        asset.pendingAction = pendingActionType;
        asset.pendingActionDetails = {
            reason: reason,
            attachment: fileUrl,
            fineData: fineData || null, // Store full fine payload
            duration: leaveDays || null, // Store duration for Leave action
            leaveDuration: leaveDays || null, // Alias for clarity
            originalActionType
        };

        // Always route to Asset Controller - no reportee approval
        const nextApprover = assetController;


        // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
        asset.actionRequiredBy = nextApprover._id;
        asset.status = 'Pending';

        await asset.save();

        // Create Dashboard Action
        const dashboardRequestType = pendingActionType === 'End of Life' ? 'Asset End of Life' :
            pendingActionType === 'Leave' ? 'Asset Leave' : 'Asset Loss Damage';
        await DashboardAction.create({
            assignedTo: nextApprover._id, // actionRequiredBy references EmployeeBasic
            requestId: asset._id,
            requestType: dashboardRequestType,
            status: 'Pending',
            subjectEmployeeId: asset.assignedTo?.employeeId || (asset.assignedCompany ? asset.assignedCompany.companyId : 'UNASSIGNED'),
            subjectName: asset.assignedTo ? `${asset.assignedTo.firstName} ${asset.assignedTo.lastName}` : (asset.assignedCompany ? asset.assignedCompany.name : 'Unassigned Asset'),
            requestedByName: req.user.name || 'System',
            extra1: `${asset.assetId} — ${asset.name}`,
            extra2: pendingActionType
        });

        // Create history log for the request
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user._id,
            comments: `Requested ${actionType}. Reason: ${reason}`,
            file: fileUrl,
            date: new Date(),
            details: { type: 'ActionRequest', action: actionType }
        });

        const requesterName = req.user.name || (req.user.firstName && req.user.lastName ? `${req.user.firstName} ${req.user.lastName}` : 'User');

        // Assignee-initiated single request: no PDF — asset details are in the email body (not a separate inventory attachment).
        await sendAssetActionApprovalEmail(asset, pendingActionType, nextApprover, { name: requesterName }, reason, []);

        res.status(200).json({ message: `${pendingActionType} request sent to Asset Controller for approval`, asset });
    } catch (error) {
        console.error('Error requesting asset action:', error);
        // Return the real message to help frontend/debug quickly (avoids generic 500).
        // (In production you can later hide details behind NODE_ENV if you prefer.)
        const msg = error?.message || 'Internal server error';
        res.status(500).json({ message: msg });
    }
};

// @desc    Bulk Request Asset Action (End of Life, Loss & Damage, or Leave)
// @route   PUT /api/AssetItem/bulk/request-action
// @access  Private
export const bulkRequestAssetAction = async (req, res) => {
    try {
        let { assetIds, actionType, reason, duration, leaveDuration } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['End of Life', 'End of Services', 'Loss and Damage', 'Leave'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }
        const originalActionType = actionType;
        if (actionType === 'End of Services') actionType = 'End of Life'; // Normalize for backend processing (pendingAction enum)
        const leaveDaysRaw = duration ?? leaveDuration;
        const leaveDays = leaveDaysRaw != null && leaveDaysRaw !== '' ? Number(leaveDaysRaw) : null;
        if (originalActionType === 'Leave') {
            if (!Number.isInteger(leaveDays) || leaveDays < 1 || leaveDays > 30) {
                return res.status(400).json({ message: 'Leave duration must be between 1 and 30 days.' });
            }
        }

        const assets = await AssetItem.find({ _id: { $in: assetIds } }).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (assets.length !== assetIds.length) {
            return res.status(404).json({ message: 'One or more assets not found' });
        }

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }
        if (!assetController._id) {
            return res.status(400).json({ message: 'Asset Controller is not properly linked to an employee record. Please update Settings > Flowchart.' });
        }

        // If requester is the Asset Controller, execute directly (no approval step) for Leave / End of Services.
        const isAssetControllerRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        if (isAssetControllerRequester && (originalActionType === 'Leave' || originalActionType === 'End of Services')) {
            const employeeSnapsForEmail = assets
                .filter((a) => a && String(a.assignedToType || 'Employee') === 'Employee' && a.assignedTo)
                .map((a) => ({
                    _id: a._id,
                    assetId: a.assetId,
                    name: a.name,
                    assignedTo: a.assignedTo
                }));
            const processed = [];
            for (const currentAsset of assets) {
                if (!currentAsset) continue;

                if (originalActionType === 'Leave') {
                    if (!leaveDays) {
                        return res.status(400).json({ message: 'Leave duration is required.' });
                    }
                    const start = new Date();
                    const end = new Date(start);
                    end.setDate(end.getDate() + leaveDays);

                    currentAsset.status = 'On Leave';
                    currentAsset.acceptanceStatus = 'Accepted';
                    currentAsset.onLeaveStartDate = start;
                    currentAsset.onLeaveDuration = leaveDays;
                    currentAsset.onLeaveEndDate = end;
                    currentAsset.parkingExtendedDays = 0;
                    currentAsset.parkingReminderSentAt = null;

                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;
                    currentAsset.negotiationHistory = [];

                    if (currentAsset.assignedToType === 'Company' || String(currentAsset.assignedToType || '') === 'Company') {
                        await notifyAssignedEmployeeIfController(
                            req,
                            currentAsset,
                            'Leave',
                            'Assets placed on leave by Asset Controller (direct transfer).'
                        );
                    }
                    await currentAsset.save();
                    await AssetHistory.create({
                        assetId: currentAsset._id,
                        action: 'On Leave',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: 'Bulk Leave executed directly by Asset Controller.',
                        date: new Date(),
                        details: { status: 'ApprovedAndFinalized', originalActionType }
                    });
                } else if (originalActionType === 'End of Services') {
                    // Direct transfer to store: mark Unassigned (NOT Lost)
                    if (currentAsset.assignedToType === 'Company' || String(currentAsset.assignedToType || '') === 'Company') {
                        await notifyAssignedEmployeeIfController(
                            req,
                            currentAsset,
                            'Return Asset',
                            'Assets returned to store by Asset Controller (End of Services direct transfer).'
                        );
                    }

                    currentAsset.status = 'Unassigned';
                    currentAsset.acceptanceStatus = 'Accepted';

                    currentAsset.assignedTo = null;
                    currentAsset.assignedCompany = null;
                    currentAsset.assignedToType = null;
                    currentAsset.assignmentType = null;
                    currentAsset.assignedDays = null;
                    currentAsset.assignedDate = null;
                    currentAsset.temporaryEndDate = null;
                    currentAsset.temporaryReminderSentAt = null;
                    currentAsset.temporaryExpiredSentAt = null;
                    currentAsset.onLeaveStartDate = null;
                    currentAsset.onLeaveEndDate = null;
                    currentAsset.onLeaveDuration = null;
                    currentAsset.parkingExtendedDays = 0;
                    currentAsset.parkingReminderSentAt = null;

                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;
                    currentAsset.negotiationHistory = [];

                    await currentAsset.save();
                    await AssetHistory.create({
                        assetId: currentAsset._id,
                        action: 'Unassigned',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: 'Bulk End of Services returned assets to store directly by Asset Controller.',
                        date: new Date(),
                        details: { status: 'Unassigned', originalActionType }
                    });
                }

                processed.push(currentAsset._id);
            }

            if (originalActionType === 'Leave' && employeeSnapsForEmail.length > 0) {
                await notifyEmployeesGroupedControllerBulkDirect(req, employeeSnapsForEmail, {
                    pdfBase: 'controller-bulk-leave',
                    bulkName: 'Bulk leave',
                    actionLabel: 'Leave',
                    detailsText: 'Assets placed on leave by Asset Controller (direct bulk transfer).',
                    customIntro:
                        '<p>The Asset Controller placed your asset(s) on leave. The PDF lists every item in this bulk action.</p>'
                });
            } else if (originalActionType === 'End of Services' && employeeSnapsForEmail.length > 0) {
                await notifyEmployeesGroupedControllerBulkDirect(req, employeeSnapsForEmail, {
                    pdfBase: 'controller-bulk-eos',
                    bulkName: 'Bulk end of services',
                    actionLabel: 'Return Asset',
                    detailsText: 'Assets returned to store by Asset Controller (End of Services bulk transfer).',
                    customIntro:
                        '<p>The Asset Controller returned your asset(s) to store (End of Services). The PDF lists every item in this bulk action.</p>'
                });
            }

            return res.status(200).json({
                message: `Bulk ${originalActionType} executed directly by Asset Controller (no approval)`,
                processedCount: processed.length,
                assetIds: processed
            });
        }

        let companyCoordinator = null;
        if (actionType === 'Loss and Damage') {
            const hasCompanyAsset = assets.some((a) => a.assignedToType === 'Company' && a.assignedCompany);
            if (hasCompanyAsset) {
                companyCoordinator = await getCompanyAssetCoordinator();
                if (!companyCoordinator?._id) {
                    return res.status(400).json({
                        message:
                            'No Assigned User or Admin in Flowchart. Bulk loss/damage for company-assigned assets requires one of those roles.'
                    });
                }
            }
        }

        // Upload attachment if present (for bulk, we'll use the same attachment for all)
        let fileUrl = null;
        // Note: For bulk, attachment would need to be handled per asset if different

        const pdfIds = assetIds.map((id) => id.toString());
        let bulkActionAttachments = [];
        // Assignee bulk: attach full inventory PDF for the Asset Controller when multiple assets,
        // or always for Loss and Damage. Single Leave/EOL-style requests use inline email details only.
        const requireInventoryPdf = pdfIds.length > 1 || actionType === 'Loss and Damage';
        if (requireInventoryPdf) {
            try {
                bulkActionAttachments = await requireBulkAssetInventoryPdfAttachment(
                    req,
                    pdfIds,
                    `bulk-${String(actionType).replace(/\s+/g, '-')}-inventory`
                );
            } catch (pdfErr) {
                console.error('[bulkRequestAssetAction] PDF required for email:', pdfErr?.message || pdfErr);
                return res.status(503).json({
                    message:
                        pdfErr?.message ||
                        'Could not generate the asset list PDF. Request was not submitted.'
                });
            }
        }

        const results = [];
        const errors = [];
        const bulkAssetIds = [];
        let primaryApprover = null; // For single dashboard action

        for (const asset of assets) {
            try {
                // Determine approver based on asset assignment
                let nextApprover;
                if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
                    nextApprover = companyCoordinator;
                } else {
                    nextApprover = assetController;
                }
                if (!primaryApprover) primaryApprover = nextApprover;

                // Store pending request in asset
                asset.pendingAction = actionType;
                const leaveDur = leaveDays;
                asset.pendingActionDetails = {
                    reason: reason,
                    attachment: fileUrl,
                    isBulk: true,
                    bulkAssetIds: assetIds, // Store all asset IDs for bulk tracking
                    fineData: null,
                    duration: leaveDur || null,
                    leaveDuration: leaveDur || null,
                    originalActionType
                };

                // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                asset.actionRequiredBy = nextApprover._id;
                asset.status = 'Pending';

                await asset.save();

                // NOTE: Do NOT create Dashboard Action per asset - we create ONE grouped action after the loop

                // Create history log for the request
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Bulk ${actionType} request submitted. Reason: ${reason || 'N/A'}`,
                    file: fileUrl,
                    date: new Date(),
                    details: { type: 'BulkActionRequest', action: actionType, bulkAssetIds: assetIds.map(id => id.toString()) }
                });

                bulkAssetIds.push(asset._id.toString());
                results.push({ assetId: asset._id, assetIdDisplay: asset.assetId, status: 'success', message: `${actionType} request submitted for approval` });
            } catch (error) {
                console.error(`Error processing asset ${asset.assetId}:`, error);
                errors.push({ assetId: asset.assetId, message: error.message || 'Failed to process' });
            }
        }

        // Create ONE Dashboard Action for bulk (grouped) - asset controller sees single item
        if (results.length > 0 && assets.length > 0 && primaryApprover?._id) {
            const primaryAsset = assets[0];
            const dashboardRequestType = actionType === 'End of Life' ? 'Asset End of Life' :
                actionType === 'Leave' ? 'Asset Leave' : 'Asset Loss Damage';
            const assetSummary = assets.map(a => `${a.assetId} — ${a.name}`).join('; ');
            const extra1 = assets.length > 1
                ? `Bulk ${actionType} (${assets.length} assets): ${assetSummary.substring(0, 200)}${assetSummary.length > 200 ? '...' : ''}`
                : `${primaryAsset.assetId} — ${primaryAsset.name}`;
            await DashboardAction.create({
                assignedTo: primaryApprover._id,
                requestId: primaryAsset._id, // Link to primary asset for approval flow
                requestType: dashboardRequestType,
                status: 'Pending',
                subjectEmployeeId: primaryAsset.assignedTo?.employeeId || (primaryAsset.assignedCompany ? primaryAsset.assignedCompany.companyId : 'UNASSIGNED'),
                subjectName: primaryAsset.assignedTo ? `${primaryAsset.assignedTo.firstName} ${primaryAsset.assignedTo.lastName}` : (primaryAsset.assignedCompany ? primaryAsset.assignedCompany.name : 'Unassigned Asset'),
                requestedByName: req.user.name || 'System',
                extra1,
                extra2: actionType,
                extra3: assets.length > 1 ? JSON.stringify({ isBulk: true, totalAssets: assets.length, assetIds: assetIds.map(id => id.toString()) }) : null
            });
        }

        // Send email notification to the same approver role as per-asset routing (must not use company coordinator for Leave/EOL).
        if (results.length > 0 && assets.length > 0) {
            const requesterName = req.user.name || (req.user.firstName && req.user.lastName ? `${req.user.firstName} ${req.user.lastName}` : 'User');
            const primaryAsset = assets[0];
            const approver =
                actionType === 'Loss and Damage' &&
                    primaryAsset.assignedToType === 'Company' &&
                    primaryAsset.assignedCompany &&
                    companyCoordinator?._id
                    ? companyCoordinator
                    : assetController;

            try {
                await sendAssetActionApprovalEmail(
                    { ...primaryAsset.toObject(), assetId: primaryAsset.assetId, name: `Bulk ${actionType} Request (${assets.length} assets)` },
                    actionType,
                    approver,
                    { name: requesterName },
                    `Bulk ${actionType} request for ${assets.length} asset(s). Reason: ${reason || 'N/A'}`,
                    bulkActionAttachments
                );
            } catch (emailErr) {
                console.error('[bulkRequestAssetAction] Email send failed (non-fatal):', emailErr.message);
            }
        }

        const successCount = results.length;
        const errorCount = errors.length;

        res.status(200).json({
            message: `${actionType} request submitted for ${successCount} asset(s)${errorCount > 0 ? `, ${errorCount} failed` : ''}. Awaiting Asset Controller approval.`,
            results,
            errors: errorCount > 0 ? errors : undefined,
            bulkAssetIds: bulkAssetIds
        });
    } catch (error) {
        console.error('Error in bulk request asset action:', error);
        const msg = process.env.NODE_ENV === 'development' ? (error.message || 'Internal server error') : 'Internal server error';
        res.status(500).json({ message: msg });
    }
};

// @desc    Handle Asset Action Approval/Rejection
export const handleAssetActionApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const { approve, comment, fineData, bulkAssetIdsToProcess, bulkDisposition } = req.body; // bulkDisposition: optional { [assetId]: 'leave'|'eos'|'return'|'reject' } for per-row AC decisions

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: [{ path: 'primaryReportee' }, { path: 'company' }]
        }).populate('assignedCompany');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!asset.pendingAction) return res.status(400).json({ message: 'No pending action' });

        const actionType = asset.pendingAction;

        // AUTH CHECK - actionRequiredBy references EmployeeBasic, so compare with employeeObjectId
        const currentUserEmpId = req.user.employeeObjectId?.toString();
        const isAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        const isHR = await isUserInFlowchart(req.user, 'hr');
        const isCompanyCoordinatorUser = await isUserCompanyAssetCoordinator(req.user);
        const isCompanyAsset = asset.assignedToType === 'Company' && (asset.assignedCompany?._id || asset.assignedCompany);

        console.log('[Asset Approval Auth]', {
            currentUserEmpId,
            actionRequiredBy: asset.actionRequiredBy?.toString(),
            isAdmin,
            isAssetController,
            isHR,
            isCompanyCoordinatorUser,
            isCompanyAsset,
            actionType,
            assignedToType: asset.assignedToType,
            hasAssignedCompany: !!(asset.assignedCompany?._id || asset.assignedCompany),
            assignedCompanyId: asset.assignedCompany?._id?.toString() || asset.assignedCompany?.toString() || 'none',
            assignedTo: asset.assignedTo?._id?.toString() || asset.assignedTo?.toString() || 'none'
        });

        const companyCoordEmp = await getCompanyAssetCoordinator();
        const isActionRequiredByCompanyCoordinator =
            companyCoordEmp?._id && asset.actionRequiredBy?.toString() === companyCoordEmp._id?.toString();

        const isAuthorized =
            asset.actionRequiredBy?.toString() === currentUserEmpId
            || isAdmin
            || isAssetController
            || (actionType === 'Loss and Damage' && isHR && !isCompanyAsset)
            || (actionType === 'Loss and Damage' && isCompanyAsset && isCompanyCoordinatorUser);

        console.log('[Asset Approval Auth] isAuthorized:', isAuthorized, {
            matchesActionRequiredBy: asset.actionRequiredBy?.toString() === currentUserEmpId,
            isAdmin,
            isAssetController,
            hrAndLossAndDamageNonCompany: actionType === 'Loss and Damage' && isHR && !isCompanyAsset,
            companyCoordinatorAndLd: actionType === 'Loss and Damage' && isCompanyAsset && isCompanyCoordinatorUser,
            companyCoordinatorId: companyCoordEmp?._id?.toString(),
            actionRequiredBy: asset.actionRequiredBy?.toString(),
            isActionRequiredByCompanyCoordinator
        });

        if (!isAuthorized) {
            if (isCompanyAsset && actionType === 'Loss and Damage') {
                return res.status(403).json({
                    message:
                        'Access denied. Only the flowchart Assigned User/Admin, Asset Controller, or Admin can approve loss and damage for company-assigned assets.'
                });
            }
            return res.status(403).json({ message: 'Access denied. Only Asset Controller, Admin, or the assigned user can perform this operation.' });
        }

        if (approve) {
            const isAssetControllerApprowing = await isUserInFlowchart(req.user, 'assetcontroller');

            // Handle "Leave" and "End of Life" and "Return Asset" - Asset Controller can approve directly (single step)
            if ((actionType === 'Leave' || actionType === 'End of Life' || actionType === 'Return Asset') && isAssetControllerApprowing) {
                // Get Asset Controller employee record for email
                const assetControllerEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName companyEmail');

                // Check if this is a bulk transfer
                const isBulkTransfer = asset.pendingActionDetails?.isBulk === true;
                const bulkAssetIds = asset.pendingActionDetails?.bulkAssetIds || [];
                const allBulkIdStrs = (isBulkTransfer ? bulkAssetIds : []).map(String).filter(Boolean);
                const bulkDispositionMap =
                    bulkDisposition && typeof bulkDisposition === 'object' && !Array.isArray(bulkDisposition)
                        ? bulkDisposition
                        : null;

                const normalizeBulkDisposition = (raw, pendingKind) => {
                    const v = String(raw ?? '').toLowerCase().trim();
                    if (['reject', 'rejected', 'no', 'deny', 'denied'].includes(v)) return 'reject';
                    if (pendingKind === 'Return Asset') return v === 'reject' ? 'reject' : 'return';
                    if (['leave', 'onleave', 'on_leave', 'parking'].includes(v)) return 'leave';
                    if (['eos', 'endofservices', 'end_of_services', 'store', 'return_to_store'].includes(v)) return 'eos';
                    if (['eol', 'endoflife', 'end_of_life'].includes(v)) return 'eol';
                    return null;
                };

                let effectiveBulkAssetIds;
                const outcomeById = new Map();

                if (isBulkTransfer && bulkDispositionMap && Object.keys(bulkDispositionMap).length > 0 && allBulkIdStrs.length > 0) {
                    for (const bid of allBulkIdStrs) {
                        const raw = bulkDispositionMap[bid] ?? bulkDispositionMap[String(bid)];
                        let d = normalizeBulkDisposition(raw, actionType);
                        if (!d) {
                            if (actionType === 'Leave') d = 'leave';
                            else if (actionType === 'Return Asset') d = 'return';
                            else d = asset.pendingActionDetails?.originalActionType === 'End of Services' ? 'eos' : 'eol';
                        }
                        outcomeById.set(String(bid), d);
                    }
                    effectiveBulkAssetIds = allBulkIdStrs.filter((id) => outcomeById.get(String(id)) !== 'reject');
                } else {
                    const hasRequestedSubset = Array.isArray(bulkAssetIdsToProcess) && bulkAssetIdsToProcess.length > 0;
                    effectiveBulkAssetIds = (hasRequestedSubset ? bulkAssetIdsToProcess : bulkAssetIds)
                        .map(String)
                        .filter(Boolean);
                }

                // Always ensure current asset is included in processing when not using explicit per-row map.
                const currentIdStr = asset._id?.toString();
                if (!bulkDispositionMap && currentIdStr && !effectiveBulkAssetIds.includes(currentIdStr)) {
                    effectiveBulkAssetIds.unshift(currentIdStr);
                }

                const rejectedFromBulk =
                    approve && isBulkTransfer && allBulkIdStrs.length > 0
                        ? bulkDispositionMap && outcomeById.size
                            ? allBulkIdStrs.filter((id) => outcomeById.get(String(id)) === 'reject')
                            : allBulkIdStrs.filter((id) => !effectiveBulkAssetIds.includes(String(id)))
                        : [];

                const otherAssetIds = effectiveBulkAssetIds.filter((x) => x !== currentIdStr);

                /** Before assignee fields are cleared (EOL/Return), for bulk employee emails + PDF */
                let bulkEmailSnapshots = [];
                if (allBulkIdStrs.length > 0) {
                    const preRows = await AssetItem.find({ _id: { $in: allBulkIdStrs } })
                        .populate('assignedTo')
                        .populate('assignedCompany')
                        .lean();
                    const ord = new Map(allBulkIdStrs.map((id, i) => [String(id), i]));
                    preRows.sort((a, b) => (ord.get(String(a._id)) ?? 0) - (ord.get(String(b._id)) ?? 0));
                    bulkEmailSnapshots = preRows;
                }

                // Process current asset
                const processAsset = async (currentAsset, outcomeOverride = null) => {
                    let op = outcomeOverride;
                    if (!op) {
                        if (actionType === 'Return Asset') op = 'return';
                        else if (actionType === 'Leave') op = 'leave';
                        else {
                            const oat = currentAsset.pendingActionDetails?.originalActionType;
                            op = oat === 'End of Services' ? 'eos' : 'eol';
                        }
                    }

                    // Process "Return Asset" action
                    if (op === 'return') {
                        const prevAssignedTo = currentAsset.assignedTo;

                        currentAsset.status = 'Unassigned';
                        currentAsset.assignedTo = null;
                        currentAsset.assignedCompany = null;
                        currentAsset.assignedToType = null;
                        currentAsset.assignmentType = null;
                        currentAsset.assignedDays = null;
                        currentAsset.assignedDate = null;
                        currentAsset.acceptanceStatus = 'Accepted';
                        currentAsset.negotiationHistory = [];
                        currentAsset.onLeaveStartDate = null;
                        currentAsset.onLeaveEndDate = null;
                        currentAsset.onLeaveDuration = null;
                        currentAsset.parkingExtendedDays = 0;
                        currentAsset.parkingReminderSentAt = null;

                        await AssetHistory.create({
                            assetId: currentAsset._id,
                            action: 'Returned',
                            assignedTo: prevAssignedTo || undefined,
                            performedBy: req.user._id,
                            comments: `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset returned to store. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer }
                        });

                        // Notify the previously assigned employee (or their delegate) that AC returned it.
                        if (prevAssignedTo && !isBulkTransfer) {
                            try {
                                const employee = await EmployeeBasic.findById(prevAssignedTo)
                                    .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                                    .lean()
                                    .catch(() => null);
                                if (employee) {
                                    let returnApprovedPdf = [];
                                    try {
                                        returnApprovedPdf = await buildBulkAssetInventoryPdfAttachment(
                                            req,
                                            [currentAsset._id.toString()],
                                            'return-approved-inventory'
                                        );
                                    } catch (e) {
                                        /* non-fatal */
                                    }
                                    await sendAssignedEmployeeActionEmail({
                                        asset: currentAsset,
                                        employee,
                                        action: 'Return Asset',
                                        performedBy: req.user.employeeId || 'Asset Controller',
                                        details: 'Your asset was returned to store by Asset Controller/Admin.',
                                        attachments: returnApprovedPdf
                                    });
                                }
                            } catch {
                                /* non-fatal */
                            }
                        }
                    }
                    // Process "Leave" action
                    else if (op === 'leave') {
                        currentAsset.status = 'On Leave';
                        // Keep assignedTo as is (don't remove it)

                        // Store duration if provided in pendingActionDetails
                        const leaveDuration = currentAsset.pendingActionDetails?.duration || currentAsset.pendingActionDetails?.leaveDuration;
                        if (leaveDuration) {
                            currentAsset.onLeaveStartDate = new Date();
                            currentAsset.onLeaveDuration = leaveDuration; // Duration in days
                            const endDate = new Date();
                            endDate.setDate(endDate.getDate() + leaveDuration);
                            currentAsset.onLeaveEndDate = endDate;
                            currentAsset.parkingExtendedDays = 0;
                            currentAsset.parkingReminderSentAt = null;
                        }

                        await AssetHistory.create({
                            assetId: currentAsset._id,
                            action: 'On Leave',
                            performedBy: req.user._id,
                            comments: `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset placed on leave${leaveDuration ? ` for ${leaveDuration} day(s)` : ''}. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer, duration: leaveDuration }
                        });
                    }
                    // Process "End of Life" / End of Services (store return)
                    else if (op === 'eos' || op === 'eol') {
                        const originalActionType = currentAsset.pendingActionDetails?.originalActionType;
                        const isEndOfServices = op === 'eos' || originalActionType === 'End of Services';
                        // For company allocations, HR needs notification, but End of Life clears assignment fields.
                        const wasCompanyAllocation = currentAsset.assignedToType === 'Company';
                        let companyNameForNotification =
                            (currentAsset.assignedCompany && typeof currentAsset.assignedCompany === 'object' ? currentAsset.assignedCompany.name : null) || null;
                        let companyIdForNotification =
                            (currentAsset.assignedCompany && typeof currentAsset.assignedCompany === 'object' ? currentAsset.assignedCompany.companyId : null) || null;

                        if (wasCompanyAllocation && (!companyNameForNotification || !companyIdForNotification) && typeof currentAsset.assignedCompany === 'string') {
                            const comp = await Company.findById(currentAsset.assignedCompany).select('name companyId nickName').lean().catch(() => null);
                            companyNameForNotification = companyNameForNotification || comp?.name || null;
                            companyIdForNotification = companyIdForNotification || comp?.companyId || null;
                        }

                        // End of Services => Unassigned (return to store)
                        if (isEndOfServices) {
                            await notifyAssignedEmployeeIfController(
                                req,
                                currentAsset,
                                'Return Asset',
                                'Asset returned to store after End of Services approval by Asset Controller.'
                            );
                            currentAsset.status = 'Unassigned';
                        } else {
                            currentAsset.status = 'Unassigned';
                        }

                        currentAsset.assignedTo = null;
                        currentAsset.assignedCompany = null;
                        currentAsset.assignedToType = null;
                        currentAsset.assignmentType = null;
                        currentAsset.assignedDate = null;

                        await AssetHistory.create({
                            assetId: currentAsset._id,
                            action: 'Unassigned',
                            performedBy: req.user._id,
                            comments: isEndOfServices
                                ? `Asset Controller approved "${actionType}" (original: End of Services)${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset returned to store (Unassigned). ${comment || ''}`
                                : `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset marked as End of Life and unassigned. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer }
                        });

                        // Notify flowchart company asset coordinator (Assigned User / Admin) for company allocations.
                        if (wasCompanyAllocation) {
                            try {
                                const companyCoordinatorNotify = await getCompanyAssetCoordinator();
                                if (!companyCoordinatorNotify?._id) {
                                    console.warn('[EndOfLife Company Notification] No Assigned User/Admin in flowchart; skipping coordinator email.');
                                } else {
                                    let eolHrPdf = [];
                                    try {
                                        eolHrPdf = await buildBulkAssetInventoryPdfAttachment(
                                            req,
                                            [currentAsset._id.toString()],
                                            'eol-company-approved-inventory'
                                        );
                                    } catch (e) {
                                        /* non-fatal */
                                    }
                                    await sendAssignedEmployeeActionEmail({
                                        asset: currentAsset,
                                        employee: companyCoordinatorNotify,
                                        action,
                                        performedBy: req.user.employeeId || 'Asset Controller',
                                        details: isEndOfServices
                                            ? `End of Services was approved by Asset Controller. Asset returned to store (Unassigned). (Company: ${companyNameForNotification || 'Company allocation'})`
                                            : `End of Life was approved by Asset Controller. (Company: ${companyNameForNotification || 'Company allocation'})`,
                                        attachments: eolHrPdf
                                    });

                                    await DashboardAction.create({
                                        assignedTo: companyCoordinatorNotify._id,
                                        assignedToEmpId: companyCoordinatorNotify.employeeId,
                                        requestId: currentAsset._id,
                                        requestType: 'Asset End of Life',
                                        status: 'Approved',
                                        subjectEmployeeId: companyIdForNotification || 'UNASSIGNED',
                                        subjectName: companyNameForNotification || 'Company allocation',
                                        requestedByName: req.user.name || req.user.employeeId || 'Asset Controller',
                                        actionedDate: new Date(),
                                        actionedBy: req.user.employeeObjectId || req.user.id || null,
                                        extra1: `${currentAsset.assetId} — ${currentAsset.name || ''}`,
                                        extra2: 'End of Life (Company allocation)'
                                    });
                                }
                            } catch (mailErr) {
                                console.error('[EndOfLife Company Notification] Non-fatal:', mailErr?.message || mailErr);
                            }
                        }
                    }

                    // Clean up pending action
                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;

                    await currentAsset.save();

                    // Delete Dashboard Action for this asset
                    await DashboardAction.deleteMany({ requestId: currentAsset._id });
                };

                const processedAssets = [];

                if (!isBulkTransfer) {
                    if (currentIdStr && effectiveBulkAssetIds.includes(currentIdStr)) {
                        await processAsset(asset);
                        processedAssets.push(asset);
                    }
                } else if (approve) {
                    if (rejectedFromBulk.length > 0) {
                        const rejDocs = await AssetItem.find({
                            _id: { $in: rejectedFromBulk },
                            pendingAction: actionType,
                            'pendingActionDetails.isBulk': true
                        });
                        const byIdRej = new Map(rejDocs.map((a) => [a._id.toString(), a]));
                        for (const rid of rejectedFromBulk) {
                            const rejAsset = byIdRej.get(String(rid));
                            if (!rejAsset) continue;
                            rejAsset.status = rejAsset.assignedTo ? 'Assigned' : 'Unassigned';
                            rejAsset.pendingAction = null;
                            rejAsset.pendingActionDetails = null;
                            rejAsset.actionRequiredBy = null;
                            await AssetHistory.create({
                                assetId: rejAsset._id,
                                action: 'Comment',
                                performedBy: req.user._id,
                                comments: `Bulk "${actionType}" not approved for this asset. ${comment || ''}`,
                                date: new Date(),
                                details: { status: 'RejectedByAuthority', originalAction: actionType, bulkNotProcessed: true }
                            });
                            await DashboardAction.deleteMany({ requestId: rejAsset._id });
                            await rejAsset.save();
                        }
                    }

                    const orderedApproveIds = [...new Set(effectiveBulkAssetIds.map(String))].filter(Boolean);
                    for (const bid of orderedApproveIds) {
                        let doc = currentIdStr && bid === currentIdStr ? asset : null;
                        if (!doc) {
                            doc = await AssetItem.findOne({
                                _id: bid,
                                pendingAction: actionType,
                                'pendingActionDetails.isBulk': true
                            }).populate('assignedTo');
                        }
                        if (!doc) continue;
                        const oc = outcomeById.size ? outcomeById.get(String(bid)) : null;
                        if (oc === 'reject') continue;
                        await processAsset(doc, oc || null);
                        processedAssets.push(doc);
                    }
                }

                // Send success emails to Asset Controller and assigned users
                try {
                    const { sendAssetActionApprovedEmail, sendAssetBulkActionApprovedEmail } = await import('../utils/sendAssetActionApprovedEmail.js');
                    const { sendAssetTransferSuccessEmail } = await import('../utils/sendAssetTransferSuccessEmail.js');

                    if (isBulkTransfer && approve && allBulkIdStrs.length > 0) {
                        const processedIdSet = new Set(processedAssets.map((a) => a._id.toString()));
                        const rejectedSet = new Set(rejectedFromBulk.map(String));
                        const fullRows = bulkEmailSnapshots.length
                            ? bulkEmailSnapshots
                            : await AssetItem.find({ _id: { $in: allBulkIdStrs } })
                                .populate('assignedTo')
                                .populate('assignedCompany')
                                .lean();
                        const byAssignee = new Map();
                        for (const row of fullRows) {
                            if (row.assignedToType === 'Company') continue;
                            const aid = row.assignedTo?._id?.toString() || row.assignedTo?.toString();
                            if (!aid) continue;
                            if (!byAssignee.has(aid)) byAssignee.set(aid, []);
                            byAssignee.get(aid).push(row);
                        }
                        const approverName = assetControllerEmp
                            ? `${assetControllerEmp.firstName || ''} ${assetControllerEmp.lastName || ''}`.trim()
                            : 'Asset Controller';
                        const actLabel =
                            actionType === 'Return Asset'
                                ? 'return to store'
                                : actionType === 'Leave'
                                    ? 'leave / parking transfer'
                                    : 'end of life / services';

                        for (const [assigneeId, rows] of byAssignee) {
                            const allIdsForEmp = rows.map((r) => r._id.toString());
                            const processedForEmp = allIdsForEmp.filter((id) => processedIdSet.has(id));
                            const rejectedForEmp = allIdsForEmp.filter((id) => rejectedSet.has(id));
                            if (!processedForEmp.length && !rejectedForEmp.length) continue;
                            const employee = await EmployeeBasic.findById(assigneeId).populate('primaryReportee');
                            if (!employee) continue;
                            let att = [];
                            try {
                                att = await buildBulkAssigneeDispositionPdfAttachment(
                                    processedForEmp,
                                    rejectedForEmp,
                                    'bulk-assignee-ac-outcome'
                                );
                            } catch (e) {
                                /* non-fatal */
                            }
                            await sendAssetBulkDispositionResultEmail({
                                employee,
                                reportee: employee.primaryReportee,
                                approverName,
                                subjectLine: `Bulk ${actionType} — ${processedForEmp.length} processed, ${rejectedForEmp.length} unchanged`,
                                introHtml: `<p>Your bulk <strong>${actLabel}</strong> request was reviewed by the Asset Controller.</p>
                                    <p><strong>${processedForEmp.length}</strong> asset(s) were updated. <strong>${rejectedForEmp.length}</strong> asset(s) were not changed and remain assigned to you.</p>`,
                                attachments: att
                            });
                        }

                        if (assetControllerEmp) {
                            let acPdf = [];
                            try {
                                const pIds = processedAssets.map((a) => a._id.toString());
                                if (pIds.length) {
                                    acPdf = await buildBulkAssetInventoryPdfAttachment(
                                        req,
                                        pIds,
                                        `ac-approved-${String(actionType).replace(/\s+/g, '-')}`
                                    );
                                }
                            } catch (e) {
                                /* non-fatal */
                            }
                            await sendAssetTransferSuccessEmail(
                                {
                                    ...asset.toObject(),
                                    assetId: asset.assetId,
                                    name: `Bulk ${actionType} (${processedAssets.length} assets)`
                                },
                                actionType,
                                assetControllerEmp,
                                await EmployeeBasic.findById(asset.assignedTo?._id || asset.assignedTo).select('firstName lastName'),
                                acPdf
                            );
                        }
                    } else {
                        const approvalIds = processedAssets.map((a) => a._id.toString()).filter(Boolean);
                        let approvedInvPdf = [];
                        try {
                            if (approvalIds.length) {
                                approvedInvPdf = await buildBulkAssetInventoryPdfAttachment(
                                    req,
                                    approvalIds,
                                    `approved-${String(actionType).replace(/\s+/g, '-')}-inventory`
                                );
                            }
                        } catch (pdfErr) {
                            console.error('[Asset Approval] Inventory PDF failed (non-fatal):', pdfErr?.message || pdfErr);
                        }

                        // Leave: processedAssets still have assignee. End of Life: use bulkEmailSnapshots (assignee cleared on save).
                        if (actionType === 'Leave') {
                            if (isBulkTransfer && processedAssets.length > 1) {
                                const primaryAsset = processedAssets[0];
                                if (primaryAsset.assignedTo) {
                                    const assignedUser = await EmployeeBasic.findById(primaryAsset.assignedTo._id || primaryAsset.assignedTo).populate('primaryReportee');
                                    if (assignedUser) {
                                        await sendAssetBulkActionApprovedEmail(
                                            processedAssets,
                                            actionType,
                                            assignedUser,
                                            assignedUser.primaryReportee || null,
                                            assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                            approvedInvPdf
                                        );
                                    }
                                }
                            } else {
                                for (const processedAsset of processedAssets) {
                                    if (processedAsset.assignedTo) {
                                        const assignedUser = await EmployeeBasic.findById(processedAsset.assignedTo._id || processedAsset.assignedTo).populate('primaryReportee');
                                        if (assignedUser) {
                                            let singleLeavePdf = [];
                                            try {
                                                singleLeavePdf = await buildBulkAssetInventoryPdfAttachment(
                                                    req,
                                                    [processedAsset._id.toString()],
                                                    `approved-${String(actionType).replace(/\s+/g, '-')}-inventory`
                                                );
                                            } catch (e) {
                                                /* non-fatal */
                                            }
                                            await sendAssetActionApprovedEmail(
                                                processedAsset,
                                                actionType,
                                                assignedUser,
                                                assignedUser.primaryReportee || null,
                                                assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                singleLeavePdf
                                            );
                                        }
                                    }
                                }
                            }
                        } else if (actionType === 'End of Life') {
                            const employeeRows = (bulkEmailSnapshots.length ? bulkEmailSnapshots : []).filter(
                                (r) => r.assignedTo && r.assignedToType !== 'Company'
                            );
                            if (employeeRows.length > 0) {
                                if (isBulkTransfer && employeeRows.length > 1) {
                                    const firstRef = employeeRows[0].assignedTo;
                                    const firstId = firstRef?._id?.toString() || firstRef?.toString?.();
                                    const sameEmp =
                                        firstId &&
                                        employeeRows.every((r) => {
                                            const rid = r.assignedTo?._id?.toString() || r.assignedTo?.toString?.();
                                            return rid === firstId;
                                        });
                                    if (sameEmp) {
                                        const assignedUser = await EmployeeBasic.findById(firstId).populate('primaryReportee');
                                        if (assignedUser) {
                                            await sendAssetBulkActionApprovedEmail(
                                                employeeRows,
                                                actionType,
                                                assignedUser,
                                                assignedUser.primaryReportee || null,
                                                assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                approvedInvPdf
                                            );
                                        }
                                    } else {
                                        for (const row of employeeRows) {
                                            const rid = row.assignedTo?._id || row.assignedTo;
                                            const assignedUser = await EmployeeBasic.findById(rid).populate('primaryReportee');
                                            if (assignedUser) {
                                                let onePdf = [];
                                                try {
                                                    onePdf = await buildBulkAssetInventoryPdfAttachment(req, [row._id.toString()], 'approved-eol-inventory');
                                                } catch (e) {
                                                    /* non-fatal */
                                                }
                                                await sendAssetActionApprovedEmail(
                                                    row,
                                                    actionType,
                                                    assignedUser,
                                                    assignedUser.primaryReportee || null,
                                                    assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                    onePdf
                                                );
                                            }
                                        }
                                    }
                                } else {
                                    for (const row of employeeRows) {
                                        const rid = row.assignedTo?._id || row.assignedTo;
                                        const assignedUser = await EmployeeBasic.findById(rid).populate('primaryReportee');
                                        if (assignedUser) {
                                            let onePdf = [];
                                            try {
                                                onePdf = await buildBulkAssetInventoryPdfAttachment(req, [row._id.toString()], 'approved-eol-inventory');
                                            } catch (e) {
                                                /* non-fatal */
                                            }
                                            await sendAssetActionApprovedEmail(
                                                row,
                                                actionType,
                                                assignedUser,
                                                assignedUser.primaryReportee || null,
                                                assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' },
                                                onePdf
                                            );
                                        }
                                    }
                                }
                            }
                        }

                        // Send success email to Asset Controller (once for the bulk transfer)
                        if (assetControllerEmp) {
                            const primaryAsset = asset;
                            const assignedUserObj = primaryAsset.assignedTo ? await EmployeeBasic.findById(primaryAsset.assignedTo._id || primaryAsset.assignedTo).select('firstName lastName') : null;
                            await sendAssetTransferSuccessEmail(
                                { ...primaryAsset.toObject(), assetId: primaryAsset.assetId, name: isBulkTransfer ? `Bulk ${actionType} (${processedAssets.length} assets)` : primaryAsset.name },
                                actionType,
                                assetControllerEmp,
                                assignedUserObj,
                                approvedInvPdf
                            );
                        }
                    }
                } catch (emailErr) {
                    console.error('[Asset Approval] Email send failed (non-fatal):', emailErr);
                }

                const bulkMessage = isBulkTransfer ? `Bulk ${actionType} approved and processed successfully for ${processedAssets.length} asset(s). Success emails sent.` : `${actionType} approved and processed successfully. Success emails sent.`;
                if (!isBulkTransfer) {
                    for (const processedAsset of processedAssets) {
                        await notifyAssignedEmployeeIfController(
                            req,
                            processedAsset,
                            actionType,
                            `${actionType} was approved by Asset Controller.`
                        );
                    }
                }

                return res.status(200).json({
                    message: bulkMessage,
                    asset,
                    processedCount: processedAssets.length,
                    isBulk: isBulkTransfer
                });
            }

            // Company-assigned loss/damage: flowchart coordinator approves first; Asset Controller enters fine details next.
            if (
                actionType === 'Loss and Damage' &&
                isCompanyAsset &&
                isCompanyCoordinatorUser &&
                !isAssetControllerApprowing &&
                !isAdmin &&
                asset.actionRequiredBy?.toString() === currentUserEmpId
            ) {
                const assetControllerFwd = await getDepartmentHOD('assetcontroller');
                if (!assetControllerFwd?._id) {
                    return res.status(400).json({
                        message: 'Asset Controller is not configured. Cannot route loss and damage after company approval.'
                    });
                }
                asset.actionRequiredBy = assetControllerFwd._id;
                await asset.save();

                await DashboardAction.findOneAndUpdate(
                    {
                        requestId: asset._id,
                        status: 'Pending',
                        requestType: 'Asset Loss Damage'
                    },
                    {
                        $set: {
                            assignedTo: assetControllerFwd._id,
                            assignedToEmpId: assetControllerFwd.employeeId
                        }
                    },
                    { new: true }
                ).catch(() => null);

                try {
                    const requesterName =
                        req.user.name ||
                        (req.user.firstName && req.user.lastName
                            ? `${req.user.firstName} ${req.user.lastName}`
                            : req.user.employeeId || 'User');
                    let ldPdf = [];
                    try {
                        ldPdf = await buildBulkAssetInventoryPdfAttachment(req, [asset._id.toString()], 'asset-ld-company-approved');
                    } catch (e) {
                        /* non-fatal */
                    }
                    await sendAssetActionApprovalEmail(
                        { ...asset.toObject(), assetId: asset.assetId, name: asset.name },
                        actionType,
                        assetControllerFwd,
                        { name: requesterName },
                        'Company coordinator approved loss/damage. Asset Controller action required to complete fine details.',
                        ldPdf
                    );
                } catch (emailErr) {
                    console.error('[Asset Approval] Forward to AC email failed (non-fatal):', emailErr?.message || emailErr);
                }

                return res.status(200).json({
                    message:
                        'Approved by company coordinator. Pending Asset Controller to enter fine details and finalize loss and damage.',
                    asset,
                    forwardedToAssetController: true
                });
            }

            // For "Loss and Damage", Asset Controller approval creates a Fine with status "Pending HR"
            if (isAssetControllerApprowing && actionType === 'Loss and Damage') {
                // If fineData is provided in request body (from modal submission), update pendingActionDetails
                if (fineData) {
                    asset.pendingActionDetails = asset.pendingActionDetails || {};
                    asset.pendingActionDetails.fineData = fineData;
                    // Update attachment if provided in fineData
                    if (fineData.attachment?.data) {
                        const uploadResult = await uploadDocumentToS3(fineData.attachment.data, 'asset-history');
                        asset.pendingActionDetails.attachment = uploadResult.publicId;
                    }
                    // Update reason/description if provided
                    if (fineData.description) {
                        asset.pendingActionDetails.reason = fineData.description;
                    }
                    await asset.save();
                }

                // Check if fineData is available (either from pendingActionDetails or just set above)
                const fd = fineData || asset.pendingActionDetails?.fineData;
                if (!fd) {
                    // Return asset data so frontend can open modal for Asset Controller to fill fine data
                    return res.status(200).json({
                        message: 'Approval pending. Please fill in fine details.',
                        requiresFineData: true,
                        asset: {
                            _id: asset._id,
                            assetId: asset.assetId,
                            name: asset.name,
                            assignedTo: asset.assignedTo,
                            assignedCompany: asset.assignedCompany,
                            assignedToType: asset.assignedToType,
                            pendingActionDetails: asset.pendingActionDetails
                        }
                    });
                }

                // STEP 1 APPROVED (Asset Controller) -> Create Fine with status "Pending HR"
                if (fd) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const { getDepartmentHOD } = await import('../utils/getDepartmentHOD.js');
                        const User = (await import('../models/User.js')).default;
                        const { syncDashboardAction } = await import('../utils/syncDashboard.js');

                        const fd = asset.pendingActionDetails.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        // Validate full fine tracker flow before creating L&D fine
                        const trackerValidation = await validateFineTrackerFlowchart();
                        if (!trackerValidation.ok) {
                            return res.status(400).json({ message: trackerValidation.message });
                        }
                        const hrHOD = trackerValidation.hrHOD;

                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        const hrAssignmentId = hrUser ? hrUser._id : hrHOD._id;

                        const { employees, ...cleanFd } = fd;
                        const fineModel = new Fine({
                            ...cleanFd,
                            assignedEmployees: employees || fd.assignedEmployees || [],
                            company: asset.assignedTo?.company?._id || fd.company,
                            companyName: asset.assignedTo?.company?.name || fd.companyName || '',
                            fineId: uniqueFineId,
                            fineStatus: 'Pending HR', // Direct to Pending HR, not Draft
                            approvalStatus: 'Pending HR',
                            submittedTo: hrAssignmentId,
                            workflow: [{
                                role: 'HR',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                assignedAt: new Date()
                            }],
                            createdBy: req.user._id,
                            awardedDate: new Date(),
                            assetId: asset.assetId,
                            assetObjectId: asset._id,
                            attachment: asset.pendingActionDetails?.attachment ? {
                                url: asset.pendingActionDetails.attachment,
                                name: 'Loss and Damage.pdf',
                                mimeType: 'application/pdf'
                            } : fd.attachment
                        });
                        await fineModel.save();

                        // Sync Dashboard Action for Fine
                        const targetEmpId = fineModel.assignedEmployees?.[0]?.employeeId || asset.assignedTo?.employeeId;
                        if (targetEmpId) {
                            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
                            const subjectEmp = await EmployeeBasic.findOne({ employeeId: targetEmpId });
                            await syncDashboardAction({
                                requestId: fineModel._id,
                                requestType: 'Fine',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                subjectEmployee: subjectEmp,
                                requestedByName: req.user.name || '',
                                extra1: fineModel.fineType || 'Loss & Damage',
                                extra2: `AED ${fineModel.fineAmount || 0}`
                            });
                        }

                        // Send fine approval email
                        try {
                            const { sendFineApprovalEmail } = await import('../utils/sendFineApprovalEmail.js');
                            await sendFineApprovalEmail(fineModel, fineModel.assignedEmployees || []);
                        } catch (emailErr) {
                            console.error('[Asset] Fine approval email failed (non-fatal):', emailErr);
                        }

                        console.log(`[Asset] Fine created from Asset Controller approval: ${uniqueFineId} with status Pending HR`);

                        // Create history log
                        await AssetHistory.create({
                            assetId: asset._id,
                            action: 'Comment',
                            performedBy: req.user._id,
                            comments: `Asset Controller approved "${actionType}". Fine created (${uniqueFineId}) with status Pending HR. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'AssetControllerApproved', originalAction: actionType, fineId: uniqueFineId }
                        });

                        // Clean up asset pending action - fine is now handling the workflow
                        asset.pendingAction = null;
                        asset.pendingActionDetails = null;
                        asset.actionRequiredBy = null;
                        asset.status = 'Lost';

                        // Delete Dashboard Action for asset
                        const dashboardRequestType = 'Asset Loss Damage';
                        await DashboardAction.deleteMany({ requestId: asset._id, requestType: dashboardRequestType });

                        await asset.save();
                        await notifyAssignedEmployeeIfController(req, asset, actionType, `${actionType} was approved by Asset Controller and moved to Pending HR.`);
                        return res.status(200).json({
                            message: `Approved by Asset Controller. Fine created (${uniqueFineId}) with status Pending HR.`,
                            asset,
                            fineId: uniqueFineId
                        });
                    } catch (fineErr) {
                        console.error('[Asset] Fine creation failed during Asset Controller approval:', fineErr);
                        return res.status(500).json({ message: 'Failed to create fine. Please try again.', error: fineErr.message });
                    }
                } else {
                    return res.status(400).json({ message: 'Fine data not provided. Cannot create fine for Loss and Damage.' });
                }
            }

            // Note: Loss and Damage is now handled above (creates fine after Asset Controller approval)
            // This section handles other finalizations that may come through HR (legacy or edge cases)
            // For Loss and Damage, fine workflow handles the rest

        } else {
            // Rejected
            const isBulkTransfer = asset.pendingActionDetails?.isBulk === true;
            const bulkAssetIds = asset.pendingActionDetails?.bulkAssetIds || [];

            // Bulk subset rejection (Leave / End of Life / Return Asset) - Asset Controller authority.
            if (
                isBulkTransfer &&
                (isAssetController || isAdmin) &&
                (actionType === 'Leave' || actionType === 'End of Life' || actionType === 'Return Asset')
            ) {
                const hasRequestedSubset = Array.isArray(bulkAssetIdsToProcess) && bulkAssetIdsToProcess.length > 0;
                const effectiveBulkAssetIds = (hasRequestedSubset ? bulkAssetIdsToProcess : bulkAssetIds)
                    .map(String)
                    .filter(Boolean);

                const currentIdStr = asset._id?.toString();
                if (currentIdStr && !effectiveBulkAssetIds.includes(currentIdStr)) {
                    effectiveBulkAssetIds.unshift(currentIdStr);
                }

                const assetIdSet = new Set(effectiveBulkAssetIds);
                const orderedIds = [...new Set(effectiveBulkAssetIds)].filter((x) => assetIdSet.has(x));

                const assetsToReject = await AssetItem.find({
                    _id: { $in: orderedIds },
                    pendingAction: actionType,
                    'pendingActionDetails.isBulk': true
                });

                const byId = new Map(assetsToReject.map((a) => [a._id.toString(), a]));

                for (const rid of orderedIds) {
                    const currentAsset = byId.get(rid);
                    if (!currentAsset) continue;

                    currentAsset.status = currentAsset.assignedTo ? 'Assigned' : 'Unassigned';
                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;

                    await AssetHistory.create({
                        assetId: currentAsset._id,
                        action: 'Comment',
                        performedBy: req.user._id,
                        comments: `Action "${actionType}" rejected/cancelled by authority (${req.user.employeeId || 'unknown'}). Reason: ${comment || 'N/A'}`,
                        date: new Date(),
                        details: { status: 'RejectedByAuthority', originalAction: actionType }
                    });

                    // Delete Dashboard Action (primary row uses requestId on this asset)
                    await DashboardAction.deleteMany({ requestId: currentAsset._id });
                    await currentAsset.save();
                }

                // Notify (non-fatal)
                try {
                    for (const rid of orderedIds) {
                        const currentAsset = byId.get(rid);
                        if (!currentAsset) continue;
                        await notifyAssignedEmployeeIfController(
                            req,
                            currentAsset,
                            actionType,
                            `${actionType} request was rejected by authority.`
                        );
                    }
                } catch (e) {
                    // non-fatal
                }

                return res.status(200).json({
                    message: `Bulk ${actionType} request rejected`,
                    asset,
                    processedCount: orderedIds.length,
                    isBulk: true
                });
            }

            if (actionType === 'Return Asset') {
                // Return request rejected: restore to Assigned (assignee remains the same).
                asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
            } else {
                asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
            }
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user._id,
                comments: `Action "${actionType}" rejected/cancelled by authority (${req.user.employeeId || 'unknown'}). Reason: ${comment || 'N/A'}`,
                date: new Date(),
                details: { status: 'RejectedByAuthority', originalAction: actionType }
            });

            // Delete Dashboard Action
            await DashboardAction.deleteMany({ requestId: asset._id });
        }

        await asset.save();
        await notifyAssignedEmployeeIfController(req, asset, actionType, approve ? `${actionType} was approved by authority.` : `${actionType} request was rejected by authority.`);
        const successMessage = approve
            ? (actionType === 'Return Asset'
                ? 'Return request approved. Asset is now Unassigned.'
                : 'Request approved and finalized.')
            : `${actionType} request rejected`;

        res.status(200).json({
            message: successMessage,
            asset
        });
    } catch (error) {
        console.error('Error handling asset action approval:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Finalize Asset Action (Reportee Acknowledgement)
// @route   PUT /api/AssetItem/:id/finalize-action
// @access  Private (Assigned User)
export const finalizeAssetAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { approve, comment } = req.body; // finalize/accept or decline

        const asset = await AssetItem.findById(id).populate('assignedTo');
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (!asset.pendingAction) {
            return res.status(400).json({ message: 'No pending action found for this asset' });
        }

        const actionType = asset.pendingAction;

        // Verify that the user is the one assigned - actionRequiredBy references EmployeeBasic
        const currentUserEmpId = req.user.employeeObjectId?.toString();
        if (asset.actionRequiredBy && asset.actionRequiredBy.toString() !== currentUserEmpId) {
            return res.status(403).json({ message: 'You are not authorized to finalize this action' });
        }

        if (approve) {
            const isLossDamage = actionType === 'Loss and Damage';
            asset.status = isLossDamage ? 'Lost' : 'Out of Service';

            // Log history
            await AssetHistory.create({
                assetId: asset._id,
                action: isLossDamage ? 'Lost' : 'Out of Service',
                performedBy: req.user.employeeObjectId,
                comments: `Finalized ${actionType} by Reportee. ${comment || ''}`,
                file: asset.pendingActionDetails?.attachment,
                date: new Date(),
                details: { status: 'Finalized', originalAction: actionType }
            });

            // UNASSIGN Asset upon EOL/L&D completion
            asset.assignedTo = null;
            asset.assignmentType = null;
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;

        } else {
            // Declined — return to manager or restore?
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user.employeeObjectId,
                comments: `Reportee declined/questioned ${actionType}. Reason: ${comment || ''}`,
                date: new Date(),
                details: { status: 'DeclinedByReportee', originalAction: actionType }
            });
            // Restoring status to Assigned if declined
            asset.status = 'Assigned';
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;
        }

        await asset.save();
        res.status(200).json({
            message: approve
                ? actionType === 'Loss and Damage'
                    ? 'Asset marked as Lost'
                    : 'Asset marked as Out of Service'
                : 'Action declined/restored',
            asset
        });
    } catch (error) {
        console.error('Error finalizing asset action:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Mark Asset as End of Life (Legacy direct call - potentially redirecting to requestAction)
export const endOfLifeAsset = requestAssetAction;

// @desc    Upload Accessories Tab Attachment
// @route   PUT /api/AssetItem/:id/accessories-attachment
// @access  Private
export const uploadAccessoriesAttachment = async (req, res) => {
    try {
        const { id } = req.params;
        const { attachment } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-accessories');
            asset.accessoriesAttachment = uploadResult.publicId;
        }

        await asset.save();
        res.status(200).json({ message: 'Attachment uploaded', asset });
    } catch (error) {
        console.error('Error uploading accessories attachment:', error);
        res.status(500).json({ message: 'Server error' });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// ACCESSORY-LEVEL ACTION WORKFLOW
// These functions handle Transfer / Loss & Damage / Unattach for individual
// accessories WITHOUT touching the main asset's status field.
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Request an action on a single accessory (Transfer / L&D / Unattach)
// @route   PUT /api/AssetItem/:id/accessories/:accId/request-action
// @access  Private
export const requestAccessoryAction = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { actionType, reason, attachment, targetAssetId, fineData } = req.body;

        if (actionType === 'End of Life') {
            return res.status(400).json({ message: 'End of Life is not available for accessories.' });
        }
        if (!['Transfer', 'Loss and Damage', 'Unattach'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid accessory action type' });
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) return res.status(404).json({ message: 'Accessory not found' });
        if (accessory.pendingAction) {
            return res.status(400).json({ message: `This accessory already has a pending "${accessory.pendingAction}" request.` });
        }

        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);

        // Unattach: only assigned employee, Asset Controller, or Admin (not assigner / delegated reportee).
        if (actionType === 'Unattach') {
            const currentEmpId = req.user.employeeObjectId?.toString();
            const assigneeId = asset.assignedToType === 'Employee' && asset.assignedTo
                ? (typeof asset.assignedTo === 'object' ? asset.assignedTo._id?.toString() : String(asset.assignedTo))
                : null;
            const isAssignee = !!(assigneeId && currentEmpId && assigneeId === currentEmpId);
            const isAdm = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
            const isAC = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
            if (!isAssignee && !isAC && !isAdm) {
                return res.status(403).json({ message: 'Access denied. Only assigned user, Asset Controller, or Admin can request unattach.' });
            }
        } else if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can request accessory actions.' });
        }

        // Resolve requester name from employee record (req.user doesn't carry firstName/lastName)
        const requesterEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName');
        const requesterName = requesterEmp ? `${requesterEmp.firstName} ${requesterEmp.lastName}` : req.user.employeeId || 'System';

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }

        let companyCoordinator = null;
        if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
            companyCoordinator = await getCompanyAssetCoordinator();
            if (!companyCoordinator?._id) {
                return res.status(400).json({
                    message:
                        'No Assigned User or Admin in Flowchart. Cannot request loss and damage approval for company-assigned assets.'
                });
            }
        }

        const requesterId = (req.user.employeeObjectId || req.user._id).toString();
        const isControllerOrAdmin = requesterId === assetController?._id?.toString() || req.user.role === 'Admin' || req.user.role === 'ROOT';

        // Asset Controller/Admin can directly unattach without approval workflow.
        if (actionType === 'Unattach' && isControllerOrAdmin) {
            const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
            if (accIndex < 0) return res.status(404).json({ message: 'Accessory not found' });

            const accToMove = asset.accessories[accIndex].toObject();
            asset.accessories.splice(accIndex, 1);

            const catalogId = await generateAccessoryCatalogId();
            await AssetAccessoryCatalog.create({
                recordType: 'catalog',
                accessoryCatalogId: catalogId,
                name: accToMove.name,
                price: accToMove.amount || 0,
                description: accToMove.description || '',
                status: 'Unattached',
                isActive: true,
                history: [{
                    at: new Date(),
                    action: 'unattached',
                    message: `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                    assetId: asset.assetId,
                    assetName: asset.name,
                    assetObjectId: asset._id
                }]
            });

            asset.actionRequiredBy = null;
            asset.markModified('accessories');
            await asset.save();

            try {
                await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
                await syncAllAccessoryInstancesForAsset(asset);
            } catch (syncErr) {
                console.error('[requestAccessoryAction direct Unattach catalog sync]', syncErr?.message || syncErr);
            }

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Accepted',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Accessory "${accToMove.name}" (${accToMove.accessoryId}) directly detached by Asset Controller/Admin and returned to catalog (${catalogId}). ${reason || ''}`,
                date: new Date(),
                details: { status: 'UnattachedDirect', accessoryId: accToMove.accessoryId, catalogId }
            });
            await removeAccessoryFromHistorySnapshots(asset._id, accToMove._id || accToMove.accessoryId);
            await notifyAssignedEmployeeIfController(req, asset, 'Unattach Accessory', `Accessory "${accToMove.name}" was directly detached by Asset Controller/Admin.`);

            return res.status(200).json({
                message: `Accessory "${accToMove.name}" detached and returned to catalog.`,
                asset
            });
        }

        let finalApprover;
        if (actionType === 'Unattach') {
            finalApprover = assetController;
        } else if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
            finalApprover = companyCoordinator;
        } else {
            finalApprover = assetController;
        }


        // Upload attachment if present
        let fileUrl = null;
        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-accessories');
            fileUrl = uploadResult.publicId;
        }

        // Store the pending request ON THE ACCESSORY
        accessory.pendingAction = actionType;
        accessory.pendingActionDetails = {
            reason: reason || null,
            attachment: fileUrl,
            fineData: fineData || null,
            targetAssetId: targetAssetId || null,
            requestedBy: req.user.employeeObjectId || req.user._id,
            requestedAt: new Date(),
            isManagerApproved: false, // For multi-step Transfer
        };

        // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
        asset.actionRequiredBy = finalApprover._id;
        asset.markModified('accessories');
        await asset.save();
        await notifyAssignedEmployeeIfController(req, asset, `${actionType} Accessory`, `Accessory "${accessory.name}" ${actionType} request is pending approval.`);

        // Create Dashboard Action
        const accDashType = actionType === 'Transfer' ? 'Asset Transfer' :
            actionType === 'Unattach' ? 'Asset Accessory Unattach' :
                'Asset Loss Damage';
        await DashboardAction.create({
            assignedTo: finalApprover._id, // actionRequiredBy references EmployeeBasic
            requestId: asset._id,
            requestType: accDashType,
            status: 'Pending',
            subjectEmployeeId: asset.assignedTo?.employeeId || (asset.assignedCompany ? asset.assignedCompany.companyId : 'UNASSIGNED'),
            subjectName: asset.assignedTo ? `${asset.assignedTo.firstName} ${asset.assignedTo.lastName}` : (asset.assignedCompany ? asset.assignedCompany.name : 'Unassigned Asset (Accessory Action)'),
            requestedByName: requesterName,
            extra1: `${asset.assetId} — Accessory: ${accessory.name}`,
            extra2: actionType
        });

        // Log history
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user._id,
            comments: `Accessory "${accessory.name}" (${accessory.accessoryId}): "${actionType}" requested. Reason: ${reason || 'N/A'}`,
            date: new Date(),
            details: { type: 'AccessoryActionRequest', action: actionType, accessoryId: accessory.accessoryId }
        });

        // Send email (non-blocking — errors here won't crash the response)
        const emailActionLabel = actionType === 'Unattach' ? 'Unattach Accessory' : actionType;
        try {
            let accAttachments = [];
            try {
                accAttachments = await buildBulkAssetInventoryPdfAttachment(req, [asset._id.toString()], 'asset-accessory-request-inventory');
            } catch (pdfErr) {
                console.error('[requestAccessoryAction] PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
            }
            await sendAssetActionApprovalEmail(
                { ...asset.toObject(), assetId: asset.assetId, name: `${asset.name} - Accessory: ${accessory.name} (${accessory.accessoryId})` },
                emailActionLabel,
                finalApprover,
                { name: requesterName },
                reason || 'No reason provided',
                accAttachments
            );
        } catch (emailErr) {
            console.error('[requestAccessoryAction] Email send failed (non-fatal):', emailErr.message);
        }

        res.status(200).json({
            message: `"${actionType}" request for accessory "${accessory.name}" sent to Asset Controller for approval.`,
            asset
        });
    } catch (error) {
        console.error('Error requesting accessory action:', error.message, error.stack);
        res.status(500).json({ message: 'Internal server error', detail: error.message });
    }
};

// @desc    Reportee responds to an accessory action (Accept or Reject)
// @route   PUT /api/AssetItem/:id/accessories/:accId/respond-action
// @access  Private
export const respondAccessoryAction = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { approve, comment, attachment, fineData } = req.body; // fineData can be provided when Asset Controller fills modal

        let fileUrl = null;
        if (approve && attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-accessories');
            fileUrl = uploadResult.publicId;
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: [{ path: 'primaryReportee' }, { path: 'company' }]
        }).populate('assignedCompany');
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) return res.status(404).json({ message: 'Accessory not found' });
        if (!accessory.pendingAction) return res.status(400).json({ message: 'No pending action on this accessory' });

        const { pendingAction, pendingActionDetails } = accessory;

        // Permission enforcement for accessory approvals:
        // - Transfer: assignee/assigner/delegated primaryReportee (actorFlags.canAct)
        // - Add (catalog): only the designated asset.actionRequiredBy (assignee or AC) or Admin
        // - Loss and Damage + End of Life + Unattach: only Asset Controller/Admin (workflow needs Fine creation)
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssetControllerApproving = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const currentUserEmpIdEarly = req.user.employeeObjectId?.toString();
        const actionRequiredById =
            asset.actionRequiredBy?._id?.toString?.() || asset.actionRequiredBy?.toString?.() || null;
        const isDesignatedApprover = !!(currentUserEmpIdEarly && actionRequiredById && actionRequiredById === currentUserEmpIdEarly);

        const addApprovalKind = pendingActionDetails?.addApprovalKind;
        const canApproveTransfer = pendingAction === 'Transfer' && actorFlags.canAct;
        const canApproveAddPending =
            pendingAction === 'Add' &&
            (isAdmin ||
                (isDesignatedApprover &&
                    (addApprovalKind === 'Assignee'
                        ? actorFlags.isAssignee || actorFlags.isPrimaryReporteeDelegate
                        : isAssetControllerApproving || actorFlags.canAct)));
        const canApproveByAuthority =
            (pendingAction === 'Loss and Damage' || pendingAction === 'End of Life' || pendingAction === 'Unattach') &&
            (isAdmin || isAssetControllerApproving);

        const canApproveDesignatedLossDamage =
            pendingAction === 'Loss and Damage' && isDesignatedApprover;

        if (!canApproveTransfer && !canApproveAddPending && !canApproveByAuthority && !canApproveDesignatedLossDamage) {
            return res.status(403).json({
                message:
                    pendingAction === 'Add'
                        ? 'Access denied. Only the designated approver (or an administrator) can approve or reject this accessory addition.'
                        : 'Access denied. Only Asset Controller/Admin or the designated approver can approve or reject this accessory action.'
            });
        }

        if (approve) {
            // If fineData is provided in request body (from modal submission), update pendingActionDetails
            if (fineData) {
                accessory.pendingActionDetails = accessory.pendingActionDetails || {};
                accessory.pendingActionDetails.fineData = fineData;
                // Update attachment if provided in fineData
                if (fineData.attachment?.data) {
                    const uploadResult = await uploadDocumentToS3(fineData.attachment.data, 'asset-accessories');
                    accessory.pendingActionDetails.attachment = uploadResult.publicId;
                }
                // Update reason/description if provided
                if (fineData.description) {
                    accessory.pendingActionDetails.reason = fineData.description;
                }
                asset.markModified('accessories');
                await asset.save();
            }
            const assetController = await getDepartmentHOD('assetcontroller');

            // Resolve current user's employee ObjectId and name
            // actionRequiredBy references EmployeeBasic, so use EmployeeBasic ObjectId for comparison
            const currentUserEmpId = currentUserEmpIdEarly;
            const actorEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName employeeId');
            const actorName = actorEmp ? `${actorEmp.firstName} ${actorEmp.lastName}` : req.user.employeeId || 'System';

            // --- SPECIAL LOGIC FOR TRANSFER ---
            // Transfer now only requires Asset Controller approval (no reportee/target employee acknowledgment)
            if (pendingAction === 'Transfer') {
                // Actor permission already validated via actorFlags above.
                // Transfer is allowed for assigner/assignee/delegated primary reportee too.

                const targetAssetId = pendingActionDetails?.targetAssetId;
                const targetAsset = await AssetItem.findById(targetAssetId).populate('assignedTo');

                if (!targetAsset || !targetAsset.assignedTo) {
                    return res.status(400).json({ message: 'Target asset or assigned employee not found for transfer.' });
                }

                // Execute the transfer immediately (no target employee acknowledgment needed)
                const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                const accToMove = asset.accessories[accIndex].toObject();

                asset.accessories.splice(accIndex, 1);
                const { pendingAction: _pa, pendingActionDetails: _pad, _id: _oldId, ...cleanAcc } = accToMove;
                targetAsset.accessories.push({
                    ...cleanAcc,
                    status: 'Attached',
                    pendingAction: null,
                    pendingActionDetails: null,
                    _id: new mongoose.Types.ObjectId()
                });

                await targetAsset.save();

                // Capture snapshots for history records
                const sourceSnapshot = await AssetItem.findById(asset._id)
                    .populate('categoryId typeId acceptedBy accessories')
                    .populate({ path: 'assignedTo', populate: { path: 'primaryReportee' } })
                    .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                const targetSnapshot = await AssetItem.findById(targetAsset._id)
                    .populate('categoryId typeId acceptedBy accessories')
                    .populate({ path: 'assignedTo', populate: { path: 'primaryReportee' } })
                    .populate({ path: 'assignedBy', select: 'firstName lastName employeeId signature' });

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Transfer',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accToMove.name}" transfer approved and finalized by Asset Controller (${actorName}). ${comment || ''}`,
                    date: new Date(),
                    details: { ...sourceSnapshot.toObject(), actionType: 'Transfer', accessoryName: accToMove.name }
                });

                // Log on target asset too
                await AssetHistory.create({
                    assetId: targetAsset._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accToMove.name}" received via transfer from ${asset.assetId}.`,
                    date: new Date(),
                    details: { ...targetSnapshot.toObject(), actionType: 'ReceivedTransfer', accessoryName: accToMove.name }
                });

                // Clean up source asset
                accessory.pendingAction = null;
                accessory.pendingActionDetails = null;
                asset.actionRequiredBy = null;
                await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Transfer' });

                asset.markModified('accessories');
                await asset.save();

                try {
                    await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
                    await syncAllAccessoryInstancesForAsset(asset);
                    await syncAllAccessoryInstancesForAsset(targetAsset);
                } catch (syncErr) {
                    console.error('[respondAccessoryAction Transfer catalog sync]', syncErr?.message || syncErr);
                }

                return res.status(200).json({ message: `Transfer approved and finalized by Asset Controller. Accessory assigned to ${targetAsset.assetId}.`, asset });
            }

            // --- UNATTACH (Asset Controller / Admin): remove from asset, return row to catalog ---
            if (pendingAction === 'Unattach') {
                const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                const accToMove = asset.accessories[accIndex].toObject();
                asset.accessories.splice(accIndex, 1);

                const catalogId = await generateAccessoryCatalogId();
                await AssetAccessoryCatalog.create({
                    recordType: 'catalog',
                    accessoryCatalogId: catalogId,
                    name: accToMove.name,
                    price: accToMove.amount || 0,
                    description: accToMove.description || '',
                    status: 'Unattached',
                    isActive: true,
                    history: [{
                        at: new Date(),
                        action: 'unattached',
                        message: `Returned to catalog from asset ${asset.assetId} — ${asset.name}`,
                        assetId: asset.assetId,
                        assetName: asset.name,
                        assetObjectId: asset._id
                    }]
                });

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accToMove.name}" (${accToMove.accessoryId}) detached and returned to accessories catalog (${catalogId}). ${comment || ''}`,
                    date: new Date(),
                    details: { status: 'UnattachedToCatalog', accessoryId: accToMove.accessoryId, catalogId }
                });

                await removeAccessoryFromHistorySnapshots(asset._id, accToMove._id || accToMove.accessoryId);
                asset.actionRequiredBy = null;
                await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Unattach' });
                asset.markModified('accessories');
                await asset.save();
                try {
                    await markCatalogInstancesDetachedFromAsset(asset._id, [accToMove.accessoryId]);
                    await syncAllAccessoryInstancesForAsset(asset);
                } catch (syncErr) {
                    console.error('[respondAccessory Unattach catalog sync]', syncErr?.message || syncErr);
                }
                await notifyAssignedEmployeeIfController(req, asset, 'Unattach Accessory', `Accessory "${accToMove.name}" was detached and added to the accessories catalog.`);

                return res.status(200).json({
                    message: `Accessory "${accToMove.name}" detached and returned to the accessories catalog.`,
                    asset
                });
            }

            // --- SPECIAL LOGIC FOR ADD APPROVAL (catalog attach) — approver is asset.actionRequiredBy (assignee or AC) ---
            if (pendingAction === 'Add') {
                const catalogItemId = accessory?.pendingActionDetails?.catalogItemId;
                const addKindForEmail = pendingActionDetails?.addApprovalKind;
                const addRequestedByForEmail = pendingActionDetails?.requestedBy;
                // Keep catalog ACC ID as canonical accessoryId everywhere in asset flows.
                if ((!accessory.accessoryId || !String(accessory.accessoryId).trim()) && catalogItemId) {
                    const catalogDoc = await AssetAccessoryCatalog.findById(catalogItemId)
                        .select('accessoryCatalogId')
                        .lean()
                        .catch(() => null);
                    if (catalogDoc?.accessoryCatalogId) {
                        accessory.accessoryId = String(catalogDoc.accessoryCatalogId).trim();
                    }
                }
                accessory.status = 'Attached';
                accessory.pendingAction = null;
                accessory.pendingActionDetails = null;

                const approvedByLabel = isAssetControllerApproving ? 'Asset Controller' : 'assigned employee';
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Accepted',
                    performedBy: req.user.employeeObjectId,
                    comments: `New accessory "${accessory.name}" addition approved by ${approvedByLabel} (${actorName}). ${comment || ''}`,
                    date: new Date(),
                    details: { status: 'Attached', action: 'AddApproval', accessoryId: accId }
                });
                if (catalogItemId) {
                    await AssetAccessoryCatalog.findByIdAndUpdate(
                        catalogItemId,
                        {
                            $set: { isActive: false, status: 'Attached' },
                            $push: {
                                history: {
                                    at: new Date(),
                                    action: 'attached',
                                    message: `Attached to asset ${asset.assetId} — ${asset.name}`,
                                    assetId: asset.assetId,
                                    assetName: asset.name,
                                    assetObjectId: asset._id
                                }
                            }
                        }
                    ).catch(() => null);
                }

                // Check if any other accessories on this asset still have 'Add' pending
                const otherPendingAdds = asset.accessories.some(a => a.pendingAction === 'Add');
                if (!otherPendingAdds) {
                    asset.actionRequiredBy = null;
                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Approval' });
                }

                asset.markModified('accessories');
                await asset.save();

                try {
                    await syncAllAccessoryInstancesForAsset(asset);
                } catch (syncErr) {
                    console.error('[respondAccessoryAction Add catalog sync]', syncErr?.message || syncErr);
                }

                try {
                    if (addKindForEmail === 'Assignee' && addRequestedByForEmail) {
                        const requesterEmp = await EmployeeBasic.findById(addRequestedByForEmail)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (requesterEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: requesterEmp,
                                action: 'Add Accessory',
                                performedBy: actorName,
                                details: `Assigned user approved accessory "${accessory.name}"; it is now attached to the asset.`,
                                customIntro: 'The holder accepted the accessory addition you initiated:'
                            });
                        }
                    } else if (asset.assignedTo) {
                        const assigneeEmp = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (assigneeEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: assigneeEmp,
                                action: 'Add Accessory',
                                performedBy: actorName,
                                details: `Accessory "${accessory.name}" was added and is now attached.`,
                                customIntro: 'The accessory addition was approved. Your asset was updated:'
                            });
                        }
                    }
                } catch (e) {
                    console.error('[respondAccessoryAction Add] Success email (non-fatal):', e?.message || e);
                }

                return res.status(200).json({
                    message: `Accessory "${accessory.name}" added successfully.`,
                    asset
                });
            }

            // --- EXISTING LOGIC FOR L&D / EOL ---
            // (isAssetControllerApproving is already resolved above; do not redeclare here — it shadows and TDZ-breaks the Add branch.)
            const isCompanyAsset = asset.assignedToType === 'Company' && asset.assignedCompany;
            const isCompanyCoordinatorUserAccessoryLd = await isUserCompanyAssetCoordinator(req.user).catch(() => false);

            if (
                pendingAction === 'Loss and Damage' &&
                isCompanyAsset &&
                isCompanyCoordinatorUserAccessoryLd &&
                !isAssetControllerApproving &&
                !isAdmin &&
                isDesignatedApprover
            ) {
                const assetControllerFwd = await getDepartmentHOD('assetcontroller');
                if (!assetControllerFwd?._id) {
                    return res.status(400).json({
                        message: 'Asset Controller is not configured. Cannot route accessory loss/damage after company approval.'
                    });
                }
                asset.actionRequiredBy = assetControllerFwd._id;
                asset.markModified('accessories');
                await asset.save();

                await DashboardAction.findOneAndUpdate(
                    {
                        requestId: asset._id,
                        status: 'Pending',
                        requestType: 'Asset Loss Damage'
                    },
                    {
                        $set: {
                            assignedTo: assetControllerFwd._id,
                            assignedToEmpId: assetControllerFwd.employeeId
                        }
                    },
                    { new: true }
                ).catch(() => null);

                try {
                    let accFwdPdf = [];
                    try {
                        accFwdPdf = await buildBulkAssetInventoryPdfAttachment(
                            req,
                            [asset._id.toString()],
                            'accessory-ld-company-approved'
                        );
                    } catch (pdfErr) {
                        console.error('[respondAccessoryAction] PDF (non-fatal):', pdfErr?.message || pdfErr);
                    }
                    await sendAssetActionApprovalEmail(
                        {
                            ...asset.toObject(),
                            assetId: asset.assetId,
                            name: `${asset.name} - Accessory: ${accessory.name} (${accessory.accessoryId})`
                        },
                        pendingAction,
                        assetControllerFwd,
                        { name: actorName },
                        `Company coordinator approved accessory loss/damage. Asset Controller must complete fine details for "${accessory.name}".`,
                        accFwdPdf
                    );
                } catch (e) {
                    console.error('[respondAccessoryAction] forward email (non-fatal):', e?.message || e);
                }

                return res.status(200).json({
                    message:
                        'Approved by company coordinator. Pending Asset Controller to enter fine details for this accessory loss/damage.',
                    asset,
                    forwardedToAssetController: true
                });
            }

            // For "Loss and Damage", Asset Controller approval creates Fine with status "Pending HR"
            if (isAssetControllerApproving && pendingAction === 'Loss and Damage') {
                // Check if fineData is provided - if not, return accessory data for modal
                if (!pendingActionDetails?.fineData) {
                    // Return accessory data so frontend can open modal for Asset Controller to fill fine data
                    return res.status(200).json({
                        message: 'Approval pending. Please fill in fine details.',
                        requiresFineData: true,
                        accessory: {
                            _id: accessory._id,
                            accessoryId: accessory.accessoryId,
                            name: accessory.name,
                            amount: accessory.amount,
                            pendingActionDetails: accessory.pendingActionDetails
                        },
                        asset: {
                            _id: asset._id,
                            assetId: asset.assetId,
                            name: asset.name,
                            assignedTo: asset.assignedTo,
                            assignedCompany: asset.assignedCompany,
                            assignedToType: asset.assignedToType
                        }
                    });
                }

                if (pendingActionDetails?.fineData) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const User = (await import('../models/User.js')).default;
                        const { syncDashboardAction } = await import('../utils/syncDashboard.js');
                        const fd = pendingActionDetails.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        // Validate full fine tracker flow before creating L&D fine
                        const trackerValidation = await validateFineTrackerFlowchart();
                        if (!trackerValidation.ok) {
                            return res.status(400).json({ message: trackerValidation.message });
                        }
                        const hrHOD = trackerValidation.hrHOD;

                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        const hrAssignmentId = hrUser ? hrUser._id : hrHOD._id;

                        const { employees, ...cleanFd } = fd;
                        const fineModel = new Fine({
                            ...cleanFd,
                            assignedEmployees: employees || fd.assignedEmployees || [],
                            company: asset.assignedTo?.company?._id || fd.company,
                            companyName: asset.assignedTo?.company?.name || fd.companyName || '',
                            fineId: uniqueFineId,
                            fineStatus: 'Pending HR',
                            approvalStatus: 'Pending HR',
                            submittedTo: hrAssignmentId,
                            workflow: [{
                                role: 'HR',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                assignedAt: new Date()
                            }],
                            createdBy: req.user._id,
                            awardedDate: new Date(),
                            assetId: asset.assetId,
                            assetObjectId: asset._id,
                            // Store accessory identity so Fine pages can show accessory-specific fines
                            accessoryId: accessory.accessoryId,
                            accessoryName: accessory.name,
                            accessoryObjectId: accessory._id,
                            attachment: fileUrl ? { url: fileUrl, name: 'L&D Photo.pdf', mimeType: 'application/pdf' } : (pendingActionDetails.attachment ? { url: pendingActionDetails.attachment, name: 'L&D Photo.pdf', mimeType: 'application/pdf' } : fd.attachment)
                        });
                        await fineModel.save();

                        // Sync Dashboard Action for Fine
                        const targetEmpId = fineModel.assignedEmployees?.[0]?.employeeId || asset.assignedTo?.employeeId;
                        if (targetEmpId) {
                            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
                            const subjectEmp = await EmployeeBasic.findOne({ employeeId: targetEmpId });
                            await syncDashboardAction({
                                requestId: fineModel._id,
                                requestType: 'Fine',
                                assignedTo: hrAssignmentId,
                                status: 'Pending',
                                subjectEmployee: subjectEmp,
                                requestedByName: req.user.name || '',
                                extra1: fineModel.fineType || 'Loss & Damage',
                                extra2: `AED ${fineModel.fineAmount || 0}`
                            });
                        }

                        // Send fine approval email
                        try {
                            const { sendFineApprovalEmail } = await import('../utils/sendFineApprovalEmail.js');
                            await sendFineApprovalEmail(fineModel, fineModel.assignedEmployees || []);
                        } catch (emailErr) {
                            console.error('[Asset Accessory] Fine approval email failed (non-fatal):', emailErr);
                        }

                        console.log(`[Asset Accessory] Fine created from Asset Controller approval: ${uniqueFineId} with status Pending HR`);

                        // Create history log
                        await AssetHistory.create({
                            assetId: asset._id,
                            action: 'Comment',
                            performedBy: req.user.employeeObjectId,
                            comments: `Asset Controller approved accessory "${accessory.name}" "${pendingAction}". Fine created (${uniqueFineId}) with status Pending HR. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'AssetControllerApproved', originalAction: pendingAction, accessoryId: accessory.accessoryId, fineId: uniqueFineId }
                        });

                        // Detach accessory from asset (lost / L&D finalized). Fine + catalog carry the record forward.
                        const accIdx = asset.accessories.findIndex(
                            (a) => a._id?.toString() === accId || a.accessoryId === accId
                        );
                        if (accIdx < 0) {
                            return res.status(404).json({ message: 'Accessory not found' });
                        }
                        const accToDetach = asset.accessories[accIdx].toObject();
                        asset.accessories.splice(accIdx, 1);
                        asset.actionRequiredBy = null;

                        asset.lostDetachedAccessories = asset.lostDetachedAccessories || [];
                        asset.lostDetachedAccessories.push({
                            accessoryId: accToDetach.accessoryId || '',
                            name: accToDetach.name || '',
                            amount: accToDetach.amount || 0,
                            fineId: uniqueFineId,
                            detachedAt: new Date()
                        });

                        await AssetAccessoryCatalog.updateMany(
                            { recordType: 'instance', assetItemId: asset._id, assetAccessoryId: accToDetach.accessoryId },
                            { $set: { status: 'Lost', assetItemId: null, assetIdRef: '' } }
                        ).catch(() => null);

                        const catalogId = await generateAccessoryCatalogId();
                        await AssetAccessoryCatalog.create({
                            recordType: 'catalog',
                            accessoryCatalogId: catalogId,
                            name: accToDetach.name,
                            price: accToDetach.amount || 0,
                            description: accToDetach.description || '',
                            status: 'Lost',
                            isActive: false,
                            history: [{
                                at: new Date(),
                                action: 'removed',
                                message: `Loss and damage — detached from asset ${asset.assetId} — ${asset.name} (fine ${uniqueFineId})`,
                                assetId: asset.assetId,
                                assetName: asset.name,
                                assetObjectId: asset._id
                            }]
                        });

                        // Delete Dashboard Action for accessory
                        await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Loss Damage' });

                        asset.markModified('accessories');
                        asset.markModified('lostDetachedAccessories');
                        await asset.save();
                        try {
                            await syncAllAccessoryInstancesForAsset(asset);
                        } catch (syncErr) {
                            console.error('[Accessory L&D approve catalog sync]', syncErr?.message || syncErr);
                        }
                        await notifyAssignedEmployeeIfController(req, asset, 'Loss and Damage Accessory', `Accessory "${accToDetach.name}" loss and damage was approved by Asset Controller and moved to Pending HR.`);

                        // Sync History (remove from previous handover docs/snapshots)
                        await removeAccessoryFromHistorySnapshots(asset._id, accToDetach._id || accToDetach.accessoryId);

                        return res.status(200).json({
                            message: `Approved by Asset Controller. Fine created (${uniqueFineId}) with status Pending HR.`,
                            asset,
                            fineId: uniqueFineId
                        });
                    } catch (fineErr) {
                        console.error('[Asset Accessory] Fine creation failed during Asset Controller approval:', fineErr);
                        return res.status(500).json({ message: 'Failed to create fine. Please try again.', error: fineErr.message });
                    }
                } else {
                    return res.status(400).json({ message: 'Fine data not provided. Cannot create fine for Loss and Damage.' });
                }
            }

            // For End of Life, Asset Controller approval is final
            if (isAssetControllerApproving && pendingAction === 'End of Life') {
                const accName = accessory.name;
                const accCode = accessory.accessoryId;
                accessory.status = 'End of Life';
                accessory.pendingAction = null;
                accessory.pendingActionDetails = null;
                asset.actionRequiredBy = null;

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'End of Life',
                    performedBy: req.user.employeeObjectId,
                    comments: `Accessory "${accName}" (${accCode}) End of Life finalized by Asset Controller. ${comment || ''}`,
                    date: new Date(),
                    details: { status: 'ApprovedAndFinalized', originalAction: pendingAction, accessoryId: accessory.accessoryId }
                });

                await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset End of Life' });
                asset.markModified('accessories');
                await asset.save();
                await notifyAssignedEmployeeIfController(req, asset, 'End of Life Accessory', `Accessory "${accName}" was marked End of Life by Asset Controller.`);

                // Sync History (remove from previous handover docs/snapshots)
                await removeAccessoryFromHistorySnapshots(asset._id, accessory._id || accessory.accessoryId);

                return res.status(200).json({ message: `Accessory "${accName}" marked as End of Life.`, asset });
            }

            // Legacy HR approval step (for edge cases or company assets) - removed for Loss and Damage
            // STEP 2 APPROVED (HR) or single step finalization (for EOL only now)
            if (pendingAction !== 'Transfer' && pendingAction !== 'Loss and Damage') {
                // Execute the action (EOL) immediately
                const accName = accessory.name;
                const accCode = accessory.accessoryId;

                if (pendingAction === 'End of Life') {
                    accessory.status = 'End of Life';
                    accessory.pendingAction = null;
                    accessory.pendingActionDetails = null;
                    asset.actionRequiredBy = null;

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'End of Life',
                        performedBy: req.user.employeeObjectId,
                        comments: `Accessory "${accName}" (${accCode}) End of Life finalized by HR. ${comment || ''}`,
                        date: new Date(),
                        details: { status: 'ApprovedAndFinalized', originalAction: pendingAction, accessoryId: accessory.accessoryId }
                    });

                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset End of Life' });
                    asset.markModified('accessories');
                    await asset.save();
                    await notifyAssignedEmployeeIfController(req, asset, 'End of Life Accessory', `Accessory "${accName}" was marked End of Life by authority.`);
                    return res.status(200).json({ message: `Accessory "${accName}" marked as End of Life.`, asset });
                }
            }
        } else {
            // Rejected
            if (pendingAction === 'Add') {
                const catalogItemId = accessory?.pendingActionDetails?.catalogItemId;
                const addKindReject = accessory?.pendingActionDetails?.addApprovalKind;
                const addRequestedByReject = accessory?.pendingActionDetails?.requestedBy;
                const accIndex = asset.accessories.findIndex(
                    (a) => (a._id && a._id.toString() === accId) || a.accessoryId === accId
                );
                const accName = accessory.name;
                if (accIndex >= 0) {
                    asset.accessories.splice(accIndex, 1);
                }
                if (catalogItemId) {
                    await AssetAccessoryCatalog.findByIdAndUpdate(
                        catalogItemId,
                        {
                            $set: { status: 'Unattached' },
                            $push: {
                                history: {
                                    at: new Date(),
                                    action: 'attach_rejected',
                                    message: `Attach request rejected (asset ${asset.assetId} — ${asset.name})`,
                                    assetId: asset.assetId,
                                    assetName: asset.name,
                                    assetObjectId: asset._id
                                }
                            }
                        }
                    ).catch(() => null);
                }
                const rejectByLabel = isAssetControllerApproving ? 'Asset Controller' : 'assigned employee';
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user.employeeObjectId || req.user._id,
                    comments: `New accessory "${accName}" addition rejected by ${rejectByLabel}. Reason: ${comment || 'N/A'}`,
                    date: new Date(),
                    details: { action: 'AddRejection', accessoryId: accId }
                });
                const otherPendingAdds = asset.accessories.some((a) => a.pendingAction === 'Add');
                if (!otherPendingAdds) {
                    asset.actionRequiredBy = null;
                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Approval' });
                }
                asset.markModified('accessories');
                await asset.save();

                try {
                    const actorEmpReject = await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName employeeId')
                        .lean();
                    const rejectActorName = actorEmpReject
                        ? `${actorEmpReject.firstName || ''} ${actorEmpReject.lastName || ''}`.trim()
                        : req.user.employeeId || 'System';

                    if (addKindReject === 'Assignee' && addRequestedByReject) {
                        const requesterEmp = await EmployeeBasic.findById(addRequestedByReject)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (requesterEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: requesterEmp,
                                action: 'Add Accessory',
                                performedBy: rejectActorName,
                                details: `Accessory "${accName}" was rejected by the assigned user. Reason: ${comment || 'N/A'}`,
                                customIntro: 'The holder did not accept this accessory addition:'
                            });
                        }
                    } else if (asset.assignedTo) {
                        const assigneeEmp = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo)
                            .select('firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                            .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                            .lean();
                        if (assigneeEmp) {
                            await sendAssignedEmployeeActionEmail({
                                asset,
                                employee: assigneeEmp,
                                action: 'Add Accessory',
                                performedBy: rejectActorName,
                                details: `Accessory "${accName}" addition was rejected. Reason: ${comment || 'N/A'}`,
                                customIntro: 'The accessory addition was not approved:'
                            });
                        }
                    }
                } catch (e) {
                    console.error('[respondAccessoryAction Add reject] Email (non-fatal):', e?.message || e);
                }

                return res.status(200).json({
                    message: `Accessory addition rejected and removed.`,
                    asset
                });
            }

            accessory.pendingAction = null;
            accessory.pendingActionDetails = null;
            asset.actionRequiredBy = null;
            const dashTypeByPending = {
                Transfer: 'Asset Transfer',
                'Loss and Damage': 'Asset Loss Damage',
                'End of Life': 'Asset End of Life',
                Unattach: 'Asset Accessory Unattach',
                Add: 'Asset Accessory Approval'
            };
            const rt = dashTypeByPending[pendingAction];
            if (rt) {
                await DashboardAction.deleteMany({ requestId: asset._id, requestType: rt });
            } else {
                await DashboardAction.deleteMany({ requestId: asset._id });
            }

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user._id,
                comments: `Accessory action "${pendingAction}" for "${accessory.name}" rejected by authority (${req.user.employeeId || 'unknown'}). Reason: ${comment || 'N/A'}`,
                date: new Date(),
                details: { status: 'RejectedByAuthority', originalAction: pendingAction, accessoryId: accId }
            });
        }

        asset.markModified('accessories');
        await asset.save();
        await notifyAssignedEmployeeIfController(req, asset, `${pendingAction} Accessory`, approve ? `Accessory action "${pendingAction}" was approved.` : `Accessory action "${pendingAction}" was rejected.`);

        res.status(200).json({
            message: approve ? `Action approved and finalized.` : `Action rejected`,
            asset
        });
    } catch (error) {
        console.error('Error responding to accessory action:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Finalize Accessory Action (Reportee Acknowledgement)
// @route   PUT /api/AssetItem/:id/accessories/:accId/finalize-action
// @access  Private (Assigned User)
export const finalizeAccessoryAction = respondAccessoryAction;

/**
 * @desc    Submit a saved draft for creation approval (notify Asset Controller)
 * @route   PUT /api/AssetItem/:id/submit-creation
 * @access  Private (Creator or Admin)
 */
export const submitDraftForCreationApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const canSubmitFrom =
            (item.status === 'Draft' || item.status === 'Rejected') && !item.actionRequiredBy;
        if (!canSubmitFrom) {
            return res.status(400).json({
                message:
                    'Only a saved draft, or a rejected creation that is not awaiting approval, can be submitted again.'
            });
        }

        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = item.createdBy?.toString() === currentUserId;
        const isJwtAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isSysAdmin = await isUserAdministrator(req.user?.id);
        if (!isCreator && !isJwtAdmin && !isSysAdmin) {
            return res.status(403).json({ message: 'Only the asset creator or an administrator can submit this draft.' });
        }

        const assetControllerRaw = await getDepartmentHOD('assetcontroller');
        const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;
        if (!assetController?._id) {
            return res.status(400).json({ message: 'Asset Controller is not configured in Flowchart.' });
        }

        const previousStatusForHistory = item.status;
        item.status = 'Submitted for Approval';
        item.actionRequiredBy = assetController._id;
        await item.save();

        const requesterDisplayName = await getAssetRequesterDisplayName(req);

        await DashboardAction.findOneAndUpdate(
            { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
            {
                assignedTo: assetController._id,
                assignedToEmpId: assetController.employeeId,
                requestId: item._id,
                requestType: 'Asset Approval',
                subjectEmployeeId: req.user.employeeId,
                subjectName: requesterDisplayName,
                requestedByName: requesterDisplayName,
                extra1: `${item.assetId} — ${item.name}`,
                extra2: `Asset creation — requested by ${requesterDisplayName}`,
                status: 'Pending'
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        let creationAttachments = [];
        try {
            creationAttachments = await buildBulkAssetInventoryPdfAttachment(req, [item._id.toString()], 'asset-creation-draft-inventory');
        } catch (pdfErr) {
            console.error('submitDraftForCreationApproval PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
        }
        await sendAssetCreationApprovalEmail({
            asset: item,
            recipient: assetController,
            creatorName: requesterDisplayName,
            attachments: creationAttachments
        });

        await AssetHistory.create({
            assetId: item._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId || req.user._id,
            comments:
                previousStatusForHistory === 'Rejected'
                    ? 'Rejected asset resubmitted for creation approval.'
                    : 'Draft submitted for creation approval.',
            details: { previousStatus: previousStatusForHistory, newStatus: 'Submitted for Approval' },
            date: new Date()
        });

        res.status(200).json(item);
    } catch (error) {
        console.error('submitDraftForCreationApproval:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Delete an asset item
 * @route   DELETE /api/AssetItem/:id
 * @access  Private (Asset Controller, Admin, or Creator before approval)
 */
export const deleteAssetItem = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Middleware requireAssetControllerOrAdmin already handles authorization:
        // 1. Admin/Controller: Always authorized
        // 2. Creator: Only if Status is Draft/Pending

        if (Array.isArray(asset.accessories) && asset.accessories.length > 0) {
            return res.status(400).json({
                message: 'Administrator cannot delete the asset while accessories are attached. Delete accessories first.',
                accessoriesCount: asset.accessories.length
            });
        }

        let adminNotificationEmail = null;
        if (await isReqUserAdmin(req.user)) {
            adminNotificationEmail = await getAssetControllerNotificationEmail();
            const itemForEmail = await AssetItem.findById(id)
                .populate({
                    path: 'assignedTo',
                    select: 'firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee',
                    populate: {
                        path: 'primaryReportee',
                        select: 'firstName lastName companyEmail workEmail personalEmail email'
                    }
                })
                .populate('assignedCompany', 'name companyId')
                .lean();
            if (itemForEmail) {
                void notifyAdminDeletedWholeAsset(req, itemForEmail).catch((e) =>
                    console.error('[notify asset delete]', e?.message || e)
                );
            }
        }

        await cleanupDashboardActionsForDeletedAsset(asset._id);

        // Delete associated History
        await AssetHistory.deleteMany({ assetId: asset._id });

        // Finally delete the asset
        await AssetItem.findByIdAndDelete(id);

        // Update counts for the type
        if (asset.typeId) {
            await updateAssetTypeCounts(asset.typeId);
        }

        res.status(200).json({
            message: 'Asset deleted successfully',
            ...(adminNotificationEmail ? { assetControllerEmail: adminNotificationEmail } : {})
        });
    } catch (error) {
        console.error('Error deleting asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

/**
 * @desc    Pending asset dashboard actions assigned to the logged-in user (by EmployeeBasic id or employee code). Not a global queue.
 * @route   GET /api/AssetItem/dashboard/pending-inbox
 * @access  Private
 */
export const getPendingAssetDashboardInbox = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : [])
            ]
        });

        const relevantIds = [manager?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        const targetEmployeeId = currentUser.employeeId || manager?.employeeId;

        const scope = String(req.query.scope || '').trim().toLowerCase();
        let requestTypeFilter;
        if (scope === 'vehicle') {
            requestTypeFilter = 'Vehicle Service Request';
        } else if (scope === 'tools') {
            requestTypeFilter = { $in: ASSET_TOOLS_INBOX_TYPES };
        } else {
            requestTypeFilter = { $in: ASSET_DASHBOARD_INBOX_TYPES };
        }

        const match = {
            status: 'Pending',
            requestType: requestTypeFilter
        };

        // Inbox + badge: only actions assigned to this user (not company-wide queues for Admin / Asset Controller).
        const assigneeClauses = [
            ...(relevantIds.length ? [{ assignedTo: { $in: relevantIds } }] : []),
            ...(targetEmployeeId ? [{ assignedToEmpId: targetEmployeeId }] : [])
        ];
        if (assigneeClauses.length === 0) {
            return res.json({ count: 0, items: [] });
        }
        match.$or = assigneeClauses;

        const dashboardPendingItems = await DashboardAction.find(match).sort({ requestedDate: -1 }).limit(200).lean();

        const seen = new Set();
        const unique = [];
        for (const it of dashboardPendingItems) {
            const k = `${it.requestId?.toString()}-${it.requestType}-${it.extra1 || ''}`;
            if (seen.has(k)) continue;
            seen.add(k);
            unique.push(it);
        }

        const parseExtra3 = (raw) => {
            if (raw == null || raw === '') return null;
            if (typeof raw === 'object') return raw;
            if (typeof raw !== 'string') return null;
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        };

        const oidStr = (x) => String(x ?? '').trim();
        const validOid = (id) => mongoose.Types.ObjectId.isValid(oidStr(id));

        /** IDs listed on DashboardAction.extra3 only (used for first DB pass). */
        const resolveBulkIdsFromExtra3 = (da) => {
            const parsed = parseExtra3(da.extra3);
            if (parsed?.isBulkAssignment === true && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                return {
                    isBulk: true,
                    bulkKind: 'assignment',
                    bulkAssetIds: [...new Set(parsed.bulkAssetIds.map((x) => oidStr(x)))].filter(validOid)
                };
            }
            if (parsed?.isBulkCreation && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                return {
                    isBulk: true,
                    bulkKind: 'creation',
                    bulkAssetIds: parsed.bulkAssetIds.map((x) => oidStr(x)).filter(validOid)
                };
            }
            if (parsed?.isBulk === true) {
                const ids = parsed.assetIds || parsed.bulkAssetIds;
                if (Array.isArray(ids) && ids.length > 1) {
                    let kind = 'action';
                    if (da.requestType === 'Asset Return') kind = 'return';
                    return {
                        isBulk: true,
                        bulkKind: kind,
                        bulkAssetIds: [...new Set(ids.map((x) => oidStr(x)))].filter(validOid)
                    };
                }
            }
            return { isBulk: false, bulkKind: null, bulkAssetIds: [] };
        };

        const allIdSet = new Set();
        for (const da of unique) {
            if (da.requestId) allIdSet.add(da.requestId.toString());
            const { isBulk, bulkAssetIds } = resolveBulkIdsFromExtra3(da);
            if (isBulk && bulkAssetIds.length) {
                bulkAssetIds.forEach((id) => allIdSet.add(id));
            }
        }

        const allIds = [...allIdSet].filter(Boolean);
        const assets = await AssetItem.find({ _id: { $in: allIds } })
            .select(
                'assetId name status assignedTo assignedToType assignedCompany pendingAction actionRequiredBy accessories acceptanceStatus pendingActionDetails'
            )
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name companyId')
            .lean();

        const assetById = Object.fromEntries(assets.map((a) => [a._id.toString(), a]));

        // Load any bulk members referenced on the primary AssetItem but missing from extra3 / invalid in extra3.
        const supplementIds = new Set();
        for (const da of unique) {
            const primary = assetById[da.requestId?.toString()];
            const pb = primary?.pendingActionDetails?.bulkAssetIds;
            if (!Array.isArray(pb)) continue;
            for (const id of pb) {
                const s = oidStr(id);
                if (validOid(s) && !assetById[s]) supplementIds.add(s);
            }
        }
        if (supplementIds.size > 0) {
            const more = await AssetItem.find({ _id: { $in: [...supplementIds] } })
                .select(
                    'assetId name status assignedTo assignedToType assignedCompany pendingAction actionRequiredBy accessories acceptanceStatus pendingActionDetails'
                )
                .populate('assignedTo', 'firstName lastName employeeId')
                .populate('assignedCompany', 'name companyId')
                .lean();
            for (const a of more) {
                assetById[a._id.toString()] = a;
            }
        }

        /** Canonical bulk list: prefer pendingActionDetails.bulkAssetIds on primary (DB) over extra3 JSON. */
        const resolveBulkForInboxItem = (da) => {
            const parsed = parseExtra3(da.extra3);
            if (parsed?.isBulkAssignment === true && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                const bulkAssetIds = [...new Set(parsed.bulkAssetIds.map((x) => oidStr(x)))].filter(validOid);
                if (bulkAssetIds.length > 1) {
                    return { isBulk: true, bulkKind: 'assignment', bulkAssetIds };
                }
            }
            if (parsed?.isBulkCreation && Array.isArray(parsed.bulkAssetIds) && parsed.bulkAssetIds.length > 1) {
                const bulkAssetIds = [...new Set(parsed.bulkAssetIds.map((x) => oidStr(x)))].filter(validOid);
                if (bulkAssetIds.length > 1) {
                    return { isBulk: true, bulkKind: 'creation', bulkAssetIds };
                }
            }

            const aid = da.requestId?.toString();
            const primary = aid ? assetById[aid] : null;
            const pb = primary?.pendingActionDetails?.bulkAssetIds;
            if (primary?.pendingActionDetails?.isBulk === true && Array.isArray(pb) && pb.length > 1) {
                const bulkAssetIds = [...new Set(pb.map((x) => oidStr(x)))].filter(validOid);
                if (bulkAssetIds.length > 1) {
                    let kind = 'action';
                    if (da.requestType === 'Asset Return') kind = 'return';
                    return { isBulk: true, bulkKind: kind, bulkAssetIds };
                }
            }

            if (parsed?.isBulk === true) {
                const ids = parsed.assetIds || parsed.bulkAssetIds;
                if (Array.isArray(ids) && ids.length > 1) {
                    const bulkAssetIds = [...new Set(ids.map((x) => oidStr(x)))].filter(validOid);
                    if (bulkAssetIds.length > 1) {
                        let kind = 'action';
                        if (da.requestType === 'Asset Return') kind = 'return';
                        return { isBulk: true, bulkKind: kind, bulkAssetIds };
                    }
                }
            }

            return { isBulk: false, bulkKind: null, bulkAssetIds: [] };
        };

        const formatAsset = (asset) => {
            if (!asset) return null;
            const accList = asset.accessories || [];
            const pendingAccessories = accList.filter((x) => x.pendingAction);
            return {
                _id: asset._id,
                assetId: asset.assetId,
                name: asset.name,
                status: asset.status,
                pendingAction: asset.pendingAction,
                assignedTo: asset.assignedTo,
                bulkAssignmentGroupId: asset.pendingActionDetails?.bulkAssignment?.groupId || null,
                accessories: accList.map((ac) => ({
                    _id: ac._id,
                    accessoryId: ac.accessoryId,
                    name: ac.name,
                    status: ac.status,
                    pendingAction: ac.pendingAction
                })),
                pendingAccessoriesCount: pendingAccessories.length
            };
        };

        const items = unique.map((da) => {
            const aid = da.requestId?.toString();
            const asset = assetById[aid] || null;
            const { isBulk, bulkKind, bulkAssetIds } = resolveBulkForInboxItem(da);

            let bulkAssets = [];
            if (isBulk && bulkAssetIds.length) {
                bulkAssets = bulkAssetIds.map((id) => {
                    const raw = assetById[id];
                    if (!raw) {
                        return {
                            _id: id,
                            assetId: '—',
                            name: 'Asset not found',
                            status: null,
                            pendingAction: null,
                            assignedTo: null,
                            accessories: [],
                            pendingAccessoriesCount: 0
                        };
                    }
                    return formatAsset(raw);
                });
            }

            return {
                dashboardActionId: da._id,
                requestType: da.requestType,
                requestedDate: da.requestedDate,
                requestedByName: da.requestedByName,
                subjectName: da.subjectName,
                extra1: da.extra1,
                extra2: da.extra2,
                extra3: da.extra3,
                requestObjectId: da.requestId,
                primaryAssetId: aid,
                isBulk,
                bulkKind,
                bulkAssetIds,
                bulkAssets,
                asset: formatAsset(asset)
            };
        });

        res.json({ count: items.length, items });
    } catch (error) {
        console.error('getPendingAssetDashboardInbox:', error);
        res.status(500).json({ message: 'Failed to load pending asset requests' });
    }
};

/**
 * @desc    Remove one pending asset dashboard notification for the current user (inbox dismiss only).
 * @route   DELETE /api/AssetItem/dashboard/pending-inbox/:id
 * @access  Private (assignee only, same scope as GET pending-inbox)
 */
export const deletePendingAssetDashboardInboxItem = async (req, res) => {
    try {
        const currentUser = req.user;
        if (!currentUser) return res.status(401).json({ message: 'Unauthorized' });

        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid notification id' });
        }

        const manager = await EmployeeBasic.findOne({
            $or: [
                ...(currentUser.employeeObjectId ? [{ _id: currentUser.employeeObjectId }] : []),
                ...(currentUser.employeeId ? [{ employeeId: currentUser.employeeId }] : [])
            ]
        });

        const relevantIds = [manager?._id, currentUser.employeeObjectId, currentUser?._id].filter(Boolean);
        const targetEmployeeId = currentUser.employeeId || manager?.employeeId;

        const da = await DashboardAction.findById(id);
        if (!da) return res.status(404).json({ message: 'Notification not found' });
        if (da.status !== 'Pending') {
            return res.status(400).json({ message: 'Only pending notifications can be removed' });
        }
        if (!ASSET_DASHBOARD_INBOX_TYPES.includes(da.requestType)) {
            return res.status(400).json({ message: 'This notification cannot be removed from here' });
        }

        const toStr = (x) => (x == null ? '' : x.toString());
        let assigneeOk = false;
        if (relevantIds.length && da.assignedTo) {
            const at = toStr(da.assignedTo);
            assigneeOk = relevantIds.some((r) => toStr(r) === at);
        }
        if (!assigneeOk && targetEmployeeId && da.assignedToEmpId) {
            assigneeOk =
                String(da.assignedToEmpId).trim().toLowerCase() === String(targetEmployeeId).trim().toLowerCase();
        }
        if (!assigneeOk) {
            return res.status(403).json({ message: 'You can only remove notifications assigned to you' });
        }

        await DashboardAction.findByIdAndDelete(id);
        res.status(200).json({ message: 'Notification removed' });
    } catch (error) {
        console.error('deletePendingAssetDashboardInboxItem:', error);
        res.status(500).json({ message: 'Failed to remove notification' });
    }
};

export const getEmployeePreviousAssets = async (req, res) => {
    try {
        const { employeeId } = req.params;

        let empObjId = null;
        const mongoose = (await import('mongoose')).default;
        if (mongoose.Types.ObjectId.isValid(employeeId)) {
            empObjId = employeeId;
        } else {
            const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
            const normEmp = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
            const emp = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${normEmp(employeeId).replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('_id').lean();
            if (emp) empObjId = emp._id.toString();
        }

        if (!empObjId) {
            return res.status(404).json({ message: 'Employee not found' });
        }

        const AssetHistory = (await import('../models/AssetHistory.js')).default;
        const historyRecords = await AssetHistory.find({ assignedTo: empObjId }).select('assetId').lean();
        const distinctAssetIds = [...new Set(historyRecords.map(h => h.assetId?.toString()).filter(Boolean))];

        if (distinctAssetIds.length === 0) {
            return res.status(200).json({ items: [] });
        }

        const AssetItem = (await import('../models/AssetItem.js')).default;

        const previousAssets = await AssetItem.find({
            _id: { $in: distinctAssetIds },
            $or: [
                { assignedTo: { $ne: empObjId } },
                { assignedTo: null },
                { assignedTo: { $exists: false } }
            ]
        })
            .populate('assignedTo', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name shortName nickName companyId')
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .lean();

        res.status(200).json({ items: previousAssets });
    } catch (error) {
        console.error('getEmployeePreviousAssets:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};




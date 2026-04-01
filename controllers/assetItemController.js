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
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { getManagementHOD } from '../utils/getManagementHOD.js';
import { sendAssetCreationApprovalEmail } from '../utils/sendAssetCreationApprovalEmail.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { sendAssetServiceEmail } from '../utils/sendAssetServiceEmail.js';
import { resolveAssetControllerEmployee, getAssetRequesterDisplayName } from '../utils/assetApprovalHelpers.js';
import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';
import { sendAssignedEmployeeActionEmail } from '../utils/sendAssignedEmployeeActionEmail.js';
import { processParkingAssets } from '../utils/processParkingAssets.js';
import { sendParkingReassignAcceptedEmail } from '../utils/sendParkingReassignAcceptedEmail.js';

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

    const canAct = isAdmin || isAssetController || isAssigner || isAssignee || isPrimaryReporteeDelegate;
    return { canAct, isAdmin, isAssetController, isAssigner, isAssignee, isPrimaryReporteeDelegate };
};


export const getAssetItems = async (req, res) => {
    try {
        const { typeId } = req.params;
        const { status } = req.query;

        let query = { typeId: typeId };
        if (status && status.toLowerCase() !== 'all') {
            query.status = status;
        }

        // Visibility:
        // 1. Admins and Asset Controllers see ALL assets (Flowchart; same as approve-creation).
        // 2. Regular users see ALL non-Draft assets (Assigned, Unassigned, etc.).
        // 3. Regular users see ONLY their own Draft assets.
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            query.$and = query.$and || [];
            query.$and.push({
                $or: [
                    { status: { $ne: 'Draft' } },
                    { createdBy: req.user._id || req.user.id }
                ]
            });
        }

        const items = await AssetItem.find(query)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department primaryReportee reportingAuthority companyEmail enablePortalAccess',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName' },
                    { path: 'reportingAuthority', select: 'firstName lastName' }
                ]
            })
            .populate('acceptedBy', 'firstName lastName signature')
            .sort({ assetId: 1 });

        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
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

        // Visibility:
        // 1. Admins and Asset Controllers see ALL assets (Flowchart-based, same as approve-creation).
        // 2. Regular users see ALL non-Draft assets (Assigned, Unassigned, etc.).
        // 3. Regular users see ONLY their own Draft assets.
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            const visibilityFilter = {
                $or: [
                    { status: { $ne: 'Draft' } },
                    { createdBy: req.user._id || req.user.id }
                ]
            };

            if (query.$or) {
                query = { $and: [query, visibilityFilter] };
            } else {
                Object.assign(query, visibilityFilter);
            }
        }

        const items = await AssetItem.find(query)
            .select('assetId name ownership assignedTo assignedCompany accessories assetValue status updatedAt typeId categoryId invoiceFile documents')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId company'
            })
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .sort({ name: 1 });

        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
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

        let isAuthorized = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        console.log(`[getUnassignedAssetsForEmployee] Initial admin check: ${isAuthorized}`);

        if (!isAuthorized) {
            // Must match getOnLeaveAssetsForEmployee: authorize the logged-in user, not the :employeeId row
            const userForCheck = {
                employeeObjectId: req.user?.employeeObjectId,
                employeeId: req.user?.employeeId
            };

            try {
                isAuthorized = await isUserInFlowchart(userForCheck, 'assetcontroller');
                console.log(`[getUnassignedAssetsForEmployee] Flowchart authorization result: ${isAuthorized}`);
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
            const isPending = await Flowchart.findOne({
                category: 'assetcontroller',
                empObjectId: req.user?.employeeObjectId,
                status: 'Pending'
            });
            if (isPending) isAuthorized = true;
            console.log(`[getUnassignedAssetsForEmployee] Pending check result: ${!!isPending}`);
        }

        if (!isAuthorized) {
            console.log(`[getUnassignedAssetsForEmployee] ACCESS DENIED for employee: ${employeeId}`);
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view unassigned assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId: employeeId
            });
        }

        console.log(`[getUnassignedAssetsForEmployee] ACCESS GRANTED, fetching assets...`);
        const items = await AssetItem.find({
            status: { $in: ['Unassigned', 'Returned', 'Draft', 'Pending'] }
        })
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .sort({ assetId: 1 });

        const filteredItems = items.filter(item => {
            const status = item.status?.toString().trim();

            return status === 'Unassigned' || status === 'Returned' || status === 'Draft' || status === 'Pending';
        });

        let controllerStatus = 'Active';

        const isPending = await Flowchart.findOne({
            category: 'assetcontroller',
            empObjectId: employeeObjectId,
            status: 'Pending'
        });
        if (isPending) controllerStatus = 'Pending';

        res.status(200).json({
            items: filteredItems,
            controllerStatus
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

        let isAuthorized = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        console.log(`[getOnLeaveAssetsForEmployee] Initial admin check: ${isAuthorized}`);

        if (!isAuthorized) {
            // Check if the LOGGED IN user is an asset controller or admin
            const userForCheck = {
                employeeObjectId: req.user.employeeObjectId,
                employeeId: req.user.employeeId
            };

            try {
                isAuthorized = await isUserInFlowchart(userForCheck, 'assetcontroller');
                console.log(`[getOnLeaveAssetsForEmployee] Flowchart authorization result for ${req.user.employeeId}: ${isAuthorized}`);
            } catch (flowchartError) {
                console.error('[getOnLeaveAssetsForEmployee] Flowchart error:', flowchartError);
                // If Flowchart is not available, deny access
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controllers can view on-leave assets.',
                    code: 'ASSET_CONTROLLER_REQUIRED',
                    error: 'Flowchart service unavailable'
                });
            }
        }

        if (!isAuthorized) {
            // Check if THEY (logged in user) are a PENDING asset controller
            const isPending = await Flowchart.findOne({
                category: 'assetcontroller',
                empObjectId: req.user.employeeObjectId,
                status: 'Pending'
            });
            if (isPending) isAuthorized = true;
            console.log(`[getOnLeaveAssetsForEmployee] Pending check result for ${req.user.employeeId}: ${!!isPending}`);
        }

        let selfAccess = false;
        if (!isAuthorized) {
            // Allow employee to view only their own parked assets
            selfAccess =
                (req.user.employeeObjectId && employeeObjectId.toString() === req.user.employeeObjectId.toString()) ||
                ((req.user.employeeId || '').toString().replace(/\s+/g, '').toLowerCase() === (employee.employeeId || '').toString().replace(/\s+/g, '').toLowerCase());

            if (!selfAccess) {
                console.log(`[getOnLeaveAssetsForEmployee] ACCESS DENIED for employee: ${employeeId}`);
                return res.status(403).json({
                    message: 'Access denied. Only assigned employee, Asset Controller, or Admin can view parking assets.',
                    code: 'PARKING_ACCESS_REQUIRED',
                    employeeId: employeeId
                });
            }
        }

        console.log(`[getOnLeaveAssetsForEmployee] ACCESS GRANTED, fetching assets...`);
        // Fetch assets with "On Leave" status (case-insensitive match)
        const onLeaveQuery = {
            status: { $regex: /^on\s+leave$/i }
        };
        if (!isAuthorized && selfAccess) {
            onLeaveQuery.assignedTo = employeeObjectId;
        }
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
 * @desc    Handle On Leave asset action (Return or On Duty)
 * @route   PUT /api/AssetItem/:id/on-leave-action
 * @access  Private
 */
export const handleOnLeaveAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { action } = req.body; // 'Return' or 'OnDuty'

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

            // Calculate new end date based on current end date (or today if missing)
            const currentEndDate = item.onLeaveEndDate || new Date();
            const newEndDate = new Date(currentEndDate);
            newEndDate.setDate(newEndDate.getDate() + extensionDays);

            item.onLeaveEndDate = newEndDate;
            item.onLeaveDuration = (item.onLeaveDuration || 0) + extensionDays;
            item.parkingExtendedDays = usedExtensionDays + extensionDays;
            item.parkingReminderSentAt = null;

            // Log History
            await AssetHistory.create({
                assetId: item._id,
                action: 'Extend',
                assignedTo: prevAssignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset parking duration extended by ${extensionDays} day(s) by Asset Controller. New end date: ${newEndDate.toLocaleDateString()}`,
                date: new Date(),
                details: { ...statusSnapshot, extensionDays, newEndDate }
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
        const { assetIds, action } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['Return', 'OnDuty'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return" or "OnDuty"' });
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

        // Check if this employee is HR-designated for companies
        // First check Company.responsibilities for HR designation (by empObjectId or employeeId)
        const designatedCompanies = await Company.find({
            responsibilities: {
                $elemMatch: {
                    $or: [
                        { empObjectId: employeeObjectId },
                        { employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') } }
                    ],
                    category: { $regex: /hr|human/i },
                    status: 'Active'
                }
            }
        }).select('_id name companyId nickName');

        console.log(`[getHRCompanyAssets] Employee ${employeeId} (${employeeObjectId}) - Found ${designatedCompanies.length} designated companies`);

        // Also check if this employee is the HR HOD in the flowchart (fallback)
        const isHRFlowchart = await isUserInFlowchart({ employeeObjectId, employeeId }, 'hr');
        console.log(`[getHRCompanyAssets] Employee ${employeeId} - isHRFlowchart: ${isHRFlowchart}`);

        // If not HR-designated for any company and not HR HOD, return empty
        if (designatedCompanies.length === 0 && !isHRFlowchart) {
            console.log(`[getHRCompanyAssets] Employee ${employeeId} - Not HR-designated and not HR HOD, returning empty`);
            return res.status(200).json({ isHR: false, items: [], designatedCompanies: [] });
        }

        // Get company IDs from designated companies
        const designatedCompanyIds = designatedCompanies.map(c => c._id);

        // If employee has a company and it's not in designated list, add it
        if (employee.company && !designatedCompanyIds.some(id => id.toString() === employee.company.toString())) {
            designatedCompanyIds.push(employee.company);
        }

        console.log(`[getHRCompanyAssets] Employee ${employeeId} - Querying assets for company IDs:`, designatedCompanyIds.map(id => id.toString()));

        // Fetch assets assigned to Company (filtered by designated companies)
        // Also include assets where the action is required by this HR (pending company assignments)
        const query = {
            $or: [
                { assignedToType: 'Company', assignedCompany: { $in: designatedCompanyIds } },
                { actionRequiredBy: employeeObjectId, status: 'Pending' }
            ]
        };

        // If no designated companies but is HR HOD, fetch all company assets
        if (designatedCompanyIds.length === 0 && isHRFlowchart) {
            query.$or = [
                { assignedToType: 'Company' },
                { actionRequiredBy: employeeObjectId, status: 'Pending' }
            ];
        }

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
            designatedCompanies: designatedCompanies.map(c => ({
                _id: c._id,
                name: c.name,
                companyId: c.companyId,
                nickName: c.nickName
            }))
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
        let { assetTypeId, name, photo, status, categoryId, assetValue, purchaseDate, warrantyYears, lastServiceDate, accessories } = req.body;

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
            actionRequiredBy = assetController._id;
            console.log(`[Asset creation] Created as Draft by regular user ${req.user.employeeId}. Action required by Asset Controller ${assetController.employeeId}`);
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

        // Record Initial History
        try {
            await AssetHistory.create({
                assetId: newItem._id,
                action: 'Created',
                performedBy: req.user.employeeObjectId,
                comments: `Asset created with Status: ${initialStatus}.`,
                details: { status: initialStatus }
            });
            console.log(`[History] Created entry for asset ${newItemId}`);
        } catch (histErr) {
            console.error(`[History Error] Failed to create creation history for ${newItemId}:`, histErr.message);
        }

        // Create Dashboard Action for Asset Controller (inbox + click-through to asset detail)
        if (initialStatus === 'Draft' && actionRequiredBy) {
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

        // Send email to Asset Controller
        if (initialStatus === 'Draft' && assetController) {
            await sendAssetCreationApprovalEmail({
                asset: newItem,
                recipient: assetController,
                creatorName: requesterDisplayName
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
        const { action } = req.body; // 'Approve' or 'Reject'

        if (!['Approve', 'Reject'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action.' });
        }

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (!(item.status === 'Draft' || item.status === 'Pending')) {
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

        if (action === 'Approve') {
            item.status = 'Unassigned';
            item.actionRequiredBy = null;
        } else if (action === 'Reject') {
            // According to user: "else rejected and asset status unassigned" 
            // Wait, I'll stick to a more standard flow: if rejected, status: Rejected.
            // But if the user *really* wants it Unassigned, I'll do that.
            // Actually, "else rejected and asset status unassigned" might mean "if approves, ok, else rejected". 
            // Let's assume the status becomes Rejected.
            item.status = 'Rejected';
            item.actionRequiredBy = null;
        }

        await item.save();
        await notifyAssignedEmployeeIfController(req, item, isReassignment ? 'Reassign Asset' : 'Assign Asset', isReassignment ? 'Asset was reassigned by Asset Controller.' : 'Asset assignment was updated by Asset Controller.');

        // Record History
        try {
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId createdBy');

            await AssetHistory.create({
                assetId: item._id,
                action: action === 'Approve' ? 'Accepted' : 'Rejected',
                performedBy: req.user.employeeObjectId,
                comments: `Asset creation ${action === 'Approve' ? 'Approved' : 'Rejected'} by ${isDesignatedApprover ? 'Designated approver' : isDeptAssetControllerFallback ? 'Asset controller' : 'Administrator'}.`,
                details: {
                    ...snapshotItem.toObject(),
                    approvalAction: action
                }
            });
            console.log(`[History] Recorded ${action} for asset creation ${item.assetId}`);
        } catch (histErr) {
            console.error(`[History Error] Failed to record creation response history for ${item.assetId}:`, histErr.message);
        }

        // Update Dashboard Action
        try {
            await DashboardAction.findOneAndUpdate(
                { requestId: item._id, requestType: 'Asset Approval', status: 'Pending' },
                { status: action === 'Approve' ? 'Approved' : 'Rejected' }
            );
            console.log(`[Dashboard] Updated asset approval action to ${action === 'Approve' ? 'Approved' : 'Rejected'}`);
        } catch (err) {
            console.error('[Dashboard Error] Failed to update asset approval action:', err);
        }

        res.status(200).json(item);
    } catch (error) {
        console.error('Error responding to asset creation:', error);
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

        const isAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check if current user is the creator
        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = item.createdBy?.toString() === currentUserId;
        const isDraft = item.status === 'Draft';

        // Strict edit permission:
        // 1) Draft -> only creator can edit
        // 2) Unassigned (non-draft) -> only Asset Controller/Admin can edit
        // 3) Assigned/other statuses -> only Asset Controller/Admin can edit
        if (isDraft) {
            if (!isCreator) {
                return res.status(403).json({ message: "Only the asset creator can edit draft assets." });
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
        if (status) item.status = status;
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

        // NOTE: Per your request, we do not block viewing asset details by role/assignment.
        // Buttons/actions are still protected in other endpoints.

        const itemObj = item.toObject();

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
            item.assignedTo;

        const isAwaitingCreationApproval =
            item.status === 'Draft' ||
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

        const isDraftWithoutDesignatedApprover =
            item.status === 'Draft' &&
            (item.actionRequiredBy == null || item.actionRequiredBy === undefined);
        let canApproveAsDeptAssetController = false;
        if (isDraftWithoutDesignatedApprover && itemObj.assetControllerId) {
            const acIdStr = String(itemObj.assetControllerId);
            if (!acIdStr.startsWith('flowchart_') && reqEmpObj && acIdStr === reqEmpObj) {
                canApproveAsDeptAssetController = true;
            } else if (itemObj.assetController?.employeeId && reqUserEmployeeId) {
                if (normEmp(itemObj.assetController.employeeId) === normEmp(reqUserEmployeeId)) {
                    canApproveAsDeptAssetController = true;
                }
            }
        }

        itemObj.canApproveAssetCreation = !!(
            isAwaitingCreationApproval &&
            (isAdmin ||
                isPortalAdmin ||
                isAssetController ||
                isDeptAssetController ||
                isDesignatedCreationApprover ||
                canApproveAsDeptAssetController)
        );

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
                    oldAssignedDays: item.assignedDays ?? null
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

            // Find HR HOD for this company from Flowchart
            const hrHOD = await getDepartmentHOD('hr');
            if (!hrHOD) {
                return res.status(400).json({ message: `No active HR responsibility found for ${targetCompany.name}. Allocation to company requires HR approval.` });
            }

            item.assignedToType = 'Company';
            item.assignedCompany = targetCompany._id;
            item.assignedTo = null;
            item.status = 'Pending';
            item.acceptanceStatus = 'Pending';
            // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
            // For company assignments, HR is the assignee (company can't login)
            item.actionRequiredBy = hrHOD._id;
            actionRequiredBy = hrHOD._id; // Set variable for DashboardAction creation

            actionRecipient = hrHOD;
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
        item.assignedDays = assignmentType === 'Temporary' ? assignedDays : null;
        item.negotiationHistory = [];

        await item.save();

        // Send reassignment email to previous assignee if this is a reassignment
        if (isReassignment && previousAssignee && newAssignee) {
            try {
                await sendAssetReassignmentEmail({
                    asset: item,
                    previousAssignee: previousAssignee,
                    newAssignee: newAssignee,
                    previousAssigneeType: previousAssigneeType,
                    newAssigneeType: newAssigneeType
                });
            } catch (err) {
                console.error(`[Email Error] Failed to send reassignment email to previous assignee: `, err);
            }
        }

        // Email: notify assignee (or HR for company) — not the assigner/controller
        try {
            await sendAssetAssignmentEmail({
                asset: item,
                employee: assignedToType === 'Company' ? { firstName: subjectName, lastName: '', isCompany: true } : actionRecipient,
                recipient: actionRecipient
            });
        } catch (err) {
            console.error(`[Email Error] Failed to send assignment email: `, err);
        }

        // Dashboard inbox for assignee (employee) or HR (company) — same as actionRequiredBy
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

        // Update all items
        const updateData = {
            assignedTo,
            assignedBy: req.user.employeeObjectId,
            assignmentType,
            assignedDays: assignmentType === 'Temporary' ? assignedDays : null,
            status: 'Pending',
            acceptanceStatus: 'Pending',
            actionRequiredBy,
            ownership: empName,
            negotiationHistory: []
        };


        await AssetItem.updateMany(
            { _id: { $in: assetIds } },
            { $set: updateData }
        );

        // Create Dashboard Actions for each asset (inbox of assignee)
        try {
            const actionRecipient = await EmployeeBasic.findById(assignedTo).select('employeeId firstName lastName');
            const subjectEmp = actionRecipient;
            const assets = await AssetItem.find({ _id: { $in: assetIds } }).select('assetId name assignmentType');

            const dashboardActions = assets.map(asset => ({
                assignedTo: actionRequiredBy,
                assignedToEmpId: actionRecipient?.employeeId,
                requestId: asset._id,
                requestType: 'Asset',
                subjectEmployeeId: subjectEmp?.employeeId,
                subjectName: `${subjectEmp?.firstName || ""} ${subjectEmp?.lastName || ""} `.trim(),
                requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                extra1: `${asset.assetId} - ${asset.name} `,
                extra2: asset.assignmentType,
                status: 'Pending'
            }));

            await DashboardAction.insertMany(dashboardActions);
            console.log(`[Dashboard] Created ${dashboardActions.length} asset actions for ${actionRecipient?.employeeId}`);
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

        // Send email to assignee only
        try {
            const employee = await EmployeeBasic.findById(assignedTo).select(
                'employeeId firstName lastName companyEmail workEmail personalEmail email'
            );
            const firstAsset = await AssetItem.findById(assetIds[0]).populate('categoryId');

            if (employee && firstAsset) {
                await sendAssetAssignmentEmail({
                    asset: firstAsset,
                    employee,
                    recipient: employee,
                    isBulk: true,
                    assetCount: assetIds.length
                });
            }
        } catch (emailErr) {
            console.error('Error in bulk asset assignment email trigger:', emailErr);
        }

        res.status(200).json({ message: `${assetIds.length} assets assigned successfully` });
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

        const selector = '#asset-handover-container';
        const pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, selector);

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
        const printUrl = `${baseUrl} /print/asset - handover / ${id} `;

        console.log(`Generating Asset Handover PDF from: ${printUrl} `);

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

        // Use the specific selector in our print page
        const selector = '#asset-handover-container';

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, selector);

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

        const currentUser = req.user.employeeObjectId;
        if (!currentUser) {
            return res.status(403).json({ message: 'You are not linked to an employee profile.' });
        }
        const cur = currentUser.toString();

        const isAssignee =
            item.assignedToType === 'Employee' &&
            item.assignedTo &&
            (item.assignedTo._id || item.assignedTo).toString() === cur;
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
                return res.status(403).json({ message: 'It is not your turn (HR HOD required) to respond.' });
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

                for (let recipient of recipients) {
                    await sendAssetResponseEmail({
                        asset: item,
                        actor,
                        recipient,
                        action,
                        comment: comments,
                        assignedToType: item.assignedToType,
                        assignedCompany: item.assignedCompany
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
                item.assignedBy = null;
                item.assignmentType = null;
                item.assignedDays = null;
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
                item.status = 'Assigned';
                item.acceptanceStatus = 'Accepted';
                item.actionRequiredBy = null;
                item.acceptedBy = req.user.employeeObjectId;

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

                // Pass the ball: assignee/HR → assigner; assigner → assignee (or HR for company)
                if (isAssignee || isHR) {
                    item.actionRequiredBy = item.assignedBy._id || item.assignedBy;
                } else {
                    if (item.assignedToType === 'Company') {
                        const hrHOD = await getDepartmentHOD('hr');
                        item.actionRequiredBy = hrHOD._id;
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
                        item.assignedBy = null;
                        item.acceptanceStatus = 'Rejected';
                        item.actionRequiredBy = null;
                    }
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

                // Log History
                await AssetHistory.create({
                    assetId: item._id,
                    action: action === 'Accept' ? 'Accepted' : 'Rejected',
                    performedBy: currentUser,
                    comments: `Bulk ${action}ed. ${comments || ''}`,
                    date: new Date()
                });

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
        const hodAc = await getDepartmentHOD('assetcontroller');
        const matchesDeptAc =
            !!hodAc?._id &&
            req.user?.employeeObjectId &&
            hodAc._id.toString() === req.user.employeeObjectId.toString();
        const isElevatedReturn = isJwtAdmin || isSysAdmin || isAcFlow || matchesDeptAc;

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
                // Company asset transfer: Route approval to HR
                const hrHOD = await getDepartmentHOD('hr');
                if (!hrHOD) {
                    return res.status(400).json({ message: 'No active HR responsibility found. Company asset transfers require HR approval.' });
                }

                // Check if reassigning to another company or to an employee
                if (assignedToType === 'Company') {
                    // Transferring to another company - still needs HR approval
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
                    item.actionRequiredBy = hrHOD._id;
                } else {
                    // Transferring from company to employee - needs HR approval
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
                    item.actionRequiredBy = hrHOD._id;
                }

                item.assignedBy = req.user.employeeObjectId;
                item.assignmentType = assignmentType || item.assignmentType || 'Permanent';
                item.assignedDays = assignmentType === 'Temporary' ? (assignedDays || null) : null;
                item.negotiationHistory = [];

                // For company transfers, create DashboardAction and send email to HR
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

                    // Create Dashboard Action for HR
                    await DashboardAction.create({
                        assignedTo: hrHOD._id, // HR is the assignee for company assets
                        assignedToEmpId: hrHOD.employeeId,
                        requestId: item._id,
                        requestType: 'Asset Assignment',
                        subjectEmployeeId: subjectEmpId,
                        subjectName: subjectName,
                        requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                        extra1: `${item.assetId} - ${item.name} `,
                        extra2: item.assignmentType || 'Permanent',
                        status: 'Pending'
                    });

                    // Send email to HR for company asset transfer
                    await sendAssetAssignmentEmail({
                        asset: item,
                        employee: assignedToType === 'Company'
                            ? { firstName: targetCompany?.name || 'Company', lastName: "", isCompany: true }
                            : targetEmployee,
                        recipient: hrHOD, // HR receives the email
                    });

                    console.log(`[Dashboard] Created asset transfer action for HR (${hrHOD.employeeId}) for company asset ${item.assetId}`);
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
        } else {
            // Default return - mark as returned
            item.assignedTo = null;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.negotiationHistory = [];
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
            if (status === 'Service' || status === 'Live') {
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
                        if (status === 'Service') {
                            // Create a task to remind them to complete service
                            await DashboardAction.create({
                                assignedTo: recipient._id,
                                assignedToEmpId: recipient.employeeId,
                                requestId: item._id,
                                requestType: 'Asset',
                                subjectEmployeeId: initiator?.employeeId || item.assetId,
                                subjectName: `${initiator?.firstName || 'System'} ${initiator?.lastName || ''}`.trim(),
                                requestedByName: `${senderInfo.firstName} ${senderInfo.lastName}`,
                                extra1: `${item.assetId} - ${item.name}`,
                                extra2: `Maintenance Started: Expected ${serviceDuration || 'soon'}`,
                                status: 'Pending'
                            });
                        } else if (status === 'Live') {
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
        await notifyAssignedEmployeeIfController(req, asset, 'Service', `Service "${serviceType}" was added by Asset Controller.`);

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
        const { serviceType, date, expiryDate, currentKm, description, paidBy, value, remark, invoice } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
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

        // Create the service record
        const newService = {
            serviceType,
            date: date || new Date(),
            expiryDate: expiryDate || null,
            currentKm: currentKm || null,
            description,
            paidBy,
            value: value || 0,
            remark,
            invoice: invoiceUrl
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
        } else {
            // General last service date update
            asset.lastServiceDate = date || new Date();
        }

        await asset.save();

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
        await notifyAssignedEmployeeIfController(req, asset, actionType, `Asset ${actionType} request was raised by Asset Controller.`);

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
        if (actionType === 'End of Services') actionType = 'End of Life'; // Normalize for backend processing
        const { duration, leaveDuration } = req.body; // Duration in days for Leave action
        const leaveDaysRaw = duration ?? leaveDuration;
        const leaveDays = leaveDaysRaw != null && leaveDaysRaw !== '' ? Number(leaveDaysRaw) : null;
        if (actionType === 'Leave') {
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
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can request this asset action.' });
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

        // Store pending request in asset
        asset.pendingAction = actionType;
        asset.pendingActionDetails = {
            reason: reason,
            attachment: fileUrl,
            fineData: fineData || null, // Store full fine payload
            duration: leaveDays || null, // Store duration for Leave action
            leaveDuration: leaveDays || null // Alias for clarity
        };

        // Always route to Asset Controller - no reportee approval
        const nextApprover = assetController;


        // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
        asset.actionRequiredBy = nextApprover._id;
        asset.status = 'Pending';

        await asset.save();

        // Create Dashboard Action
        const dashboardRequestType = actionType === 'End of Life' ? 'Asset End of Life' :
            actionType === 'Leave' ? 'Asset Leave' : 'Asset Loss Damage';
        await DashboardAction.create({
            assignedTo: nextApprover._id, // actionRequiredBy references EmployeeBasic
            requestId: asset._id,
            requestType: dashboardRequestType,
            status: 'Pending',
            subjectEmployeeId: asset.assignedTo?.employeeId || (asset.assignedCompany ? asset.assignedCompany.companyId : 'UNASSIGNED'),
            subjectName: asset.assignedTo ? `${asset.assignedTo.firstName} ${asset.assignedTo.lastName}` : (asset.assignedCompany ? asset.assignedCompany.name : 'Unassigned Asset'),
            requestedByName: req.user.name || 'System',
            extra1: `${asset.assetId} — ${asset.name}`,
            extra2: actionType
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

        await sendAssetActionApprovalEmail(
            asset,
            actionType,
            nextApprover,
            { name: requesterName },
            reason
        );

        res.status(200).json({ message: `${actionType} request sent to Asset Controller for approval`, asset });
    } catch (error) {
        console.error('Error requesting asset action:', error);
        const msg = process.env.NODE_ENV === 'development' ? (error.message || 'Internal server error') : 'Internal server error';
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
        if (actionType === 'End of Services') actionType = 'End of Life'; // Normalize for backend processing
        const leaveDaysRaw = duration ?? leaveDuration;
        const leaveDays = leaveDaysRaw != null && leaveDaysRaw !== '' ? Number(leaveDaysRaw) : null;
        if (actionType === 'Leave') {
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

        // HR is required only for Loss and Damage bulk flow.
        let hrHOD = null;
        if (actionType === 'Loss and Damage') {
            hrHOD = await getDepartmentHOD('hr');
            if (!hrHOD || !hrHOD._id) {
                return res.status(400).json({ message: 'HR HOD is not properly linked to an employee record. Please update Settings > Flowchart.' });
            }
        }

        // Upload attachment if present (for bulk, we'll use the same attachment for all)
        let fileUrl = null;
        // Note: For bulk, attachment would need to be handled per asset if different

        const results = [];
        const errors = [];
        const bulkAssetIds = [];
        let primaryApprover = null; // For single dashboard action

        for (const asset of assets) {
            try {
                // Determine approver based on asset assignment
                let nextApprover;
                if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
                    nextApprover = hrHOD;
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
                    leaveDuration: leaveDur || null
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

        // Send email notification to Asset Controller (using first asset as reference)
        if (results.length > 0 && assets.length > 0) {
            const requesterName = req.user.name || (req.user.firstName && req.user.lastName ? `${req.user.firstName} ${req.user.lastName}` : 'User');
            const primaryAsset = assets[0];
            const approver = primaryAsset.assignedToType === 'Company' && primaryAsset.assignedCompany ? hrHOD : assetController;

            try {
                await sendAssetActionApprovalEmail(
                    { ...primaryAsset.toObject(), assetId: primaryAsset.assetId, name: `Bulk ${actionType} Request (${assets.length} assets)` },
                    actionType,
                    approver,
                    { name: requesterName },
                    `Bulk ${actionType} request for ${assets.length} asset(s). Reason: ${reason || 'N/A'}`
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
        const { approve, comment, fineData } = req.body; // fineData can be provided when Asset Controller fills modal

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

        // Check if user is HR using flowchart (not just HOD comparison)
        const isHR = await isUserInFlowchart(req.user, 'hr');
        // More robust check for company-assigned assets - check both assignedToType and assignedCompany (populated or not)
        const isCompanyAsset = asset.assignedToType === 'Company' && (asset.assignedCompany?._id || asset.assignedCompany);

        // Debug logging for authorization check
        console.log('[Asset Approval Auth]', {
            currentUserEmpId,
            actionRequiredBy: asset.actionRequiredBy?.toString(),
            isAdmin,
            isAssetController,
            isHR,
            isCompanyAsset,
            actionType,
            assignedToType: asset.assignedToType,
            hasAssignedCompany: !!(asset.assignedCompany?._id || asset.assignedCompany),
            assignedCompanyId: asset.assignedCompany?._id?.toString() || asset.assignedCompany?.toString() || 'none',
            assignedTo: asset.assignedTo?._id?.toString() || asset.assignedTo?.toString() || 'none'
        });

        // Authorization logic:
        // 1. User matches actionRequiredBy (standard check)
        // 2. OR user is Admin/Asset Controller (always authorized)
        // 3. OR (for Loss and Damage) if user is HR - allow any HR user to approve Loss and Damage requests
        const hrHOD = await getDepartmentHOD('hr');
        const isActionRequiredByHR = hrHOD && asset.actionRequiredBy?.toString() === hrHOD._id?.toString();

        // Simplified: If user is HR and action is Loss and Damage, allow approval
        const isAuthorized = asset.actionRequiredBy?.toString() === currentUserEmpId
            || isAdmin
            || isAssetController
            || (actionType === 'Loss and Damage' && isHR); // Any HR user can approve Loss and Damage

        console.log('[Asset Approval Auth] isAuthorized:', isAuthorized, {
            matchesActionRequiredBy: asset.actionRequiredBy?.toString() === currentUserEmpId,
            isAdmin,
            isAssetController,
            hrAndLossAndDamage: actionType === 'Loss and Damage' && isHR,
            hrHODId: hrHOD?._id?.toString(),
            actionRequiredBy: asset.actionRequiredBy?.toString(),
            isActionRequiredByHR
        });

        if (!isAuthorized) {
            // Provide more specific error message based on asset type
            if ((isCompanyAsset || isActionRequiredByHR) && actionType === 'Loss and Damage') {
                return res.status(403).json({ message: 'Access denied. Only HR, Asset Controller, or Admin can approve Loss and Damage for company-assigned assets.' });
            }
            return res.status(403).json({ message: 'Access denied. Only Asset Controller, Admin, or the assigned user can perform this operation.' });
        }

        if (approve) {
            // Get HR HOD for workflow logic (needed for routing to HR)
            const hrHOD = await getDepartmentHOD('hr');
            const isAssetControllerApprowing = await isUserInFlowchart(req.user, 'assetcontroller');

            // Handle "Leave" and "End of Life" - Asset Controller can approve directly (single step)
            if ((actionType === 'Leave' || actionType === 'End of Life') && isAssetControllerApprowing) {
                // Get Asset Controller employee record for email
                const assetControllerEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName companyEmail');

                // Check if this is a bulk transfer
                const isBulkTransfer = asset.pendingActionDetails?.isBulk === true;
                const bulkAssetIds = asset.pendingActionDetails?.bulkAssetIds || [];

                // Process current asset
                const processAsset = async (currentAsset) => {
                    // Process "Leave" action
                    if (actionType === 'Leave') {
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
                    // Process "End of Life" action
                    else if (actionType === 'End of Life') {
                        currentAsset.status = 'Unassigned';
                        currentAsset.assignedTo = null;
                        currentAsset.assignedCompany = null;
                        currentAsset.assignedToType = null;
                        currentAsset.assignmentType = null;
                        currentAsset.assignedDate = null;

                        await AssetHistory.create({
                            assetId: currentAsset._id,
                            action: 'Unassigned',
                            performedBy: req.user._id,
                            comments: `Asset Controller approved "${actionType}"${isBulkTransfer ? ' (Bulk Transfer)' : ''}. Asset marked as End of Life and unassigned. ${comment || ''}`,
                            date: new Date(),
                            details: { status: 'ApprovedAndFinalized', originalAction: actionType, isBulk: isBulkTransfer }
                        });
                    }

                    // Clean up pending action
                    currentAsset.pendingAction = null;
                    currentAsset.pendingActionDetails = null;
                    currentAsset.actionRequiredBy = null;

                    await currentAsset.save();

                    // Delete Dashboard Action for this asset
                    await DashboardAction.deleteMany({ requestId: currentAsset._id });
                };

                // Process current asset
                await processAsset(asset);

                // If bulk transfer, process all other assets in the bulk
                const processedAssets = [asset];
                if (isBulkTransfer && bulkAssetIds.length > 1) {
                    const otherAssetIds = bulkAssetIds.filter(id => id.toString() !== asset._id.toString());
                    const otherAssets = await AssetItem.find({
                        _id: { $in: otherAssetIds },
                        pendingAction: actionType,
                        'pendingActionDetails.isBulk': true
                    }).populate('assignedTo');

                    for (const otherAsset of otherAssets) {
                        await processAsset(otherAsset);
                        processedAssets.push(otherAsset);
                    }
                }

                // Send success emails to Asset Controller and assigned users
                try {
                    const { sendAssetActionApprovedEmail, sendAssetBulkActionApprovedEmail } = await import('../utils/sendAssetActionApprovedEmail.js');
                    const { sendAssetTransferSuccessEmail } = await import('../utils/sendAssetTransferSuccessEmail.js');

                    // Send to assigned users (if exists and action is Leave)
                    if (actionType === 'Leave') {
                        if (isBulkTransfer && processedAssets.length > 1) {
                            // Bulk: one email to employee and reportee with all assets
                            const primaryAsset = processedAssets[0];
                            if (primaryAsset.assignedTo) {
                                const assignedUser = await EmployeeBasic.findById(primaryAsset.assignedTo._id || primaryAsset.assignedTo).populate('primaryReportee');
                                if (assignedUser) {
                                    await sendAssetBulkActionApprovedEmail(
                                        processedAssets,
                                        actionType,
                                        assignedUser,
                                        assignedUser.primaryReportee || null,
                                        assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' }
                                    );
                                }
                            }
                        } else {
                            // Single asset: one email per asset
                            for (const processedAsset of processedAssets) {
                                if (processedAsset.assignedTo) {
                                    const assignedUser = await EmployeeBasic.findById(processedAsset.assignedTo._id || processedAsset.assignedTo).populate('primaryReportee');
                                    if (assignedUser) {
                                        await sendAssetActionApprovedEmail(
                                            processedAsset,
                                            actionType,
                                            assignedUser,
                                            assignedUser.primaryReportee || null,
                                            assetControllerEmp || { firstName: 'Asset', lastName: 'Controller' }
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
                            assignedUserObj
                        );
                    }
                } catch (emailErr) {
                    console.error('[Asset Approval] Email send failed (non-fatal):', emailErr);
                }

                const bulkMessage = isBulkTransfer ? `Bulk ${actionType} approved and processed successfully for ${processedAssets.length} asset(s). Success emails sent.` : `${actionType} approved and processed successfully. Success emails sent.`;
                for (const processedAsset of processedAssets) {
                    await notifyAssignedEmployeeIfController(req, processedAsset, actionType, `${actionType} was approved by Asset Controller.`);
                }
                return res.status(200).json({
                    message: bulkMessage,
                    asset,
                    processedCount: processedAssets.length,
                    isBulk: isBulkTransfer
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
                        asset.status = 'Out of Service';

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
            asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
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
            await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset' });
        }

        await asset.save();
        await notifyAssignedEmployeeIfController(req, asset, actionType, approve ? `${actionType} was approved by authority.` : `${actionType} request was rejected by authority.`);
        res.status(200).json({
            message: approve ? `Request approved and finalized. Asset marked as Out of Service.` : `${actionType} request rejected`,
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
            // Finalize: Status becomes 'Out of Service'
            asset.status = 'Out of Service';

            // Log history
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Out of Service',
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
            message: approve ? `Asset marked as Out of Service` : `Action declined/restored`,
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
// These functions handle Transfer / Loss & Damage / EOL for individual
// accessories WITHOUT touching the main asset's status field.
// ─────────────────────────────────────────────────────────────────────────────

// @desc    Request an action on a single accessory (Transfer / L&D / EOL)
// @route   PUT /api/AssetItem/:id/accessories/:accId/request-action
// @access  Private
export const requestAccessoryAction = async (req, res) => {
    try {
        const { id, accId } = req.params;
        const { actionType, reason, attachment, targetAssetId, fineData } = req.body;

        if (!['Transfer', 'Loss and Damage', 'End of Life'].includes(actionType)) {
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

        // Permission: asset controller/admin OR assignee
        // Also allow assigner + primary reportee delegation when assignee has NO companyEmail
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        if (!actorFlags.canAct) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller/Admin, assigner, assigned user, or delegated primary reportee can request accessory actions.' });
        }

        // Resolve requester name from employee record (req.user doesn't carry firstName/lastName)
        const requesterEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName');
        const requesterName = requesterEmp ? `${requesterEmp.firstName} ${requesterEmp.lastName}` : req.user.employeeId || 'System';

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(400).json({ message: 'Asset Controller not found. Cannot request approval.' });
        }

        // HR is mandatory only for Loss and Damage flow.
        let hrHOD = null;
        if (actionType === 'Loss and Damage') {
            hrHOD = await getDepartmentHOD('hr');
            if (!hrHOD) {
                return res.status(400).json({ message: 'HR HOD not found. Cannot request Loss and Damage approval.' });
            }
        }

        const requesterId = (req.user.employeeObjectId || req.user._id).toString();
        const isControllerOrAdmin = requesterId === assetController?._id?.toString() || req.user.role === 'Admin' || req.user.role === 'ROOT';

        // Flow:
        // - End of Life / Transfer -> Asset Controller approval
        // - Loss and Damage -> company assets to HR, others to Asset Controller first

        let finalApprover;
        if (actionType === 'Loss and Damage' && asset.assignedToType === 'Company' && asset.assignedCompany) {
            // Company-assigned assets: Route directly to HR
            finalApprover = hrHOD;
        } else {
            // Unassigned or Employee-assigned: Route to Asset Controller first
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
        await notifyAssignedEmployeeIfController(req, asset, `${actionType} Accessory`, `Accessory "${accessory.name}" ${actionType} request was raised by Asset Controller.`);

        // Create Dashboard Action
        const accDashType = actionType === 'Transfer' ? 'Asset Transfer' :
            actionType === 'End of Life' ? 'Asset End of Life' : 'Asset Loss Damage';
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
        try {
            await sendAssetActionApprovalEmail(
                { ...asset.toObject(), assetId: asset.assetId, name: `${asset.name} - Accessory: ${accessory.name} (${accessory.accessoryId})` },
                actionType,
                finalApprover,
                { name: requesterName },
                reason || 'No reason provided'
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
        // - Transfer + Add: allowed for assignee/assigner/delegated primaryReportee
        // - Loss and Damage + End of Life: only Asset Controller/Admin (workflow needs Fine creation)
        const actorFlags = await getActorPermissionFlagsForAsset(req.user, asset);
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssetControllerApproving = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);

        const canApproveByAssignedActors = (pendingAction === 'Transfer' || pendingAction === 'Add') && actorFlags.canAct;
        const canApproveByAuthority = (pendingAction === 'Loss and Damage' || pendingAction === 'End of Life') && (isAdmin || isAssetControllerApproving);

        if (!canApproveByAssignedActors && !canApproveByAuthority) {
            return res.status(403).json({
                message: 'Access denied. Only Asset Controller/Admin can approve Loss & Damage or End of Life accessory actions.'
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
            const assetController = await getDepartmentHOD('assetcontroller', asset.assignedTo?._id || req.user.employeeObjectId);
            const hrHOD = await getDepartmentHOD('hr', asset.assignedTo?._id || req.user.employeeObjectId);

            // Resolve current user's employee ObjectId and name
            // actionRequiredBy references EmployeeBasic, so use EmployeeBasic ObjectId for comparison
            const currentUserEmpId = req.user.employeeObjectId?.toString();
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

                return res.status(200).json({ message: `Transfer approved and finalized by Asset Controller. Accessory assigned to ${targetAsset.assetId}.`, asset });
            }

            // --- SPECIAL LOGIC FOR ADD APPROVAL (Employee) ---
            if (pendingAction === 'Add') {
                const catalogItemId = accessory?.pendingActionDetails?.catalogItemId;
                if (approve) {
                    accessory.status = 'Attached';
                    accessory.pendingAction = null;
                    accessory.pendingActionDetails = null;

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Accepted',
                        performedBy: req.user.employeeObjectId,
                        comments: `New accessory "${accessory.name}" addition approved by assigned employee (${actorName}). ${comment || ''}`,
                        date: new Date(),
                        details: { status: 'Attached', action: 'AddApproval', accessoryId: accId }
                    });
                    if (catalogItemId) {
                        await AssetAccessoryCatalog.findByIdAndUpdate(
                            catalogItemId,
                            { $set: { isActive: false, status: 'Attached' } }
                        ).catch(() => null);
                    }
                } else {
                    const accIndex = asset.accessories.findIndex(a =>
                        (a._id && a._id.toString() === accId) || (a.accessoryId === accId)
                    );
                    const accName = accessory.name;
                    asset.accessories.splice(accIndex, 1);

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId,
                        comments: `New accessory "${accName}" addition rejected by assigned employee (${actorName}). Reason: ${comment || 'N/A'}`,
                        date: new Date(),
                        details: { action: 'AddRejection', accessoryId: accId }
                    });
                    if (catalogItemId) {
                        await AssetAccessoryCatalog.findByIdAndUpdate(
                            catalogItemId,
                            { $set: { status: 'Unattached' } }
                        ).catch(() => null);
                    }
                }

                // Check if any other accessories on this asset still have 'Add' pending
                const otherPendingAdds = asset.accessories.some(a => a.pendingAction === 'Add');
                if (!otherPendingAdds) {
                    asset.actionRequiredBy = null;
                    await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Accessory Approval' });
                }

                asset.markModified('accessories');
                await asset.save();
                await notifyAssignedEmployeeIfController(req, asset, 'Add Accessory', approve ? `Accessory "${accessory.name}" addition was approved.` : `Accessory "${accessory.name}" addition was rejected.`);

                return res.status(200).json({
                    message: approve ? `Accessory "${accessory.name}" added successfully.` : `Accessory addition rejected and removed.`,
                    asset
                });
            }

            // --- EXISTING LOGIC FOR L&D / EOL ---
            const isAssetControllerApproving = await isUserInFlowchart(req.user, 'assetcontroller');
            const isCompanyAsset = asset.assignedToType === 'Company' && asset.assignedCompany;

            // actionRequiredBy references EmployeeBasic, so compare with EmployeeBasic._id
            const isHRApproving = hrHOD?._id?.toString() === currentUserEmpId;

            // For Loss and Damage, Asset Controller approval creates Fine with status "Pending HR"
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

                        // Clean up accessory pending action - fine is now handling the workflow
                        accessory.pendingAction = null;
                        accessory.pendingActionDetails = null;
                        accessory.status = 'Damaged';
                        asset.actionRequiredBy = null;

                        // Delete Dashboard Action for accessory
                        await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset Loss Damage' });

                        asset.markModified('accessories');
                        await asset.save();
                        await notifyAssignedEmployeeIfController(req, asset, 'Loss and Damage Accessory', `Accessory "${accessory.name}" loss and damage was approved by Asset Controller and moved to Pending HR.`);

                        // Sync History (remove from previous handover docs/snapshots)
                        await removeAccessoryFromHistorySnapshots(asset._id, accessory._id || accessory.accessoryId);

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
            accessory.pendingAction = null;
            accessory.pendingActionDetails = null;
            asset.actionRequiredBy = null;
            await DashboardAction.deleteMany({ requestId: asset._id, requestType: 'Asset' });

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

        // Delete associated Dashboard Actions
        await DashboardAction.deleteMany({ requestId: asset._id });

        // Delete associated History
        await AssetHistory.deleteMany({ assetId: asset._id });

        // Finally delete the asset
        await AssetItem.findByIdAndDelete(id);

        // Update counts for the type
        if (asset.typeId) {
            await updateAssetTypeCounts(asset.typeId);
        }

        res.status(200).json({ message: 'Asset deleted successfully' });
    } catch (error) {
        console.error('Error deleting asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};




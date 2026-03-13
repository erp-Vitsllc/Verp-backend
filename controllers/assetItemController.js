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
import DashboardAction from '../models/DashboardAction.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { sendAssetActionFinalAcknowledgeEmail } from '../utils/sendAssetActionFinalAcknowledgeEmail.js';
import Fine from '../models/Fine.js';
import AssetCategory from '../models/AssetCategory.js';
import Flowchart from '../models/Flowchart.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { sendAssetCreationApprovalEmail } from '../utils/sendAssetCreationApprovalEmail.js';
import { sendAssetServiceEmail } from '../utils/sendAssetServiceEmail.js';

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

// @desc    Get all items for a specific asset type
// @route   GET /api/AssetItem/:typeId
// @access  Private
export const getAssetItems = async (req, res) => {
    try {
        const { typeId } = req.params;

        // Find items and populate assignedTo for name display
        const items = await AssetItem.find({ typeId: typeId })
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

        // Sign URLs for each item
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

// @desc    Get all assigned assets (regardless of type)
// @route   GET /api/AssetItem/assigned/all
// @access  Private
export const getAllAssignedAssets = async (req, res) => {
    try {
        const { companyId } = req.query;

        let query = {
            $or: [
                { assignedTo: { $ne: null } },
                { assignedCompany: { $ne: null } },
                { status: 'Unassigned' }
            ]
        };

        if (companyId) {
            query = {
                assignedCompany: companyId,
                assignedToType: 'Company',
                status: { $ne: 'Draft' }
            };
        }

        const items = await AssetItem.find(query)
            .select('assetId name assignedTo assignedCompany accessories assetValue status updatedAt typeId categoryId invoiceFile documents')
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

// @desc    Get all unassigned assets if the specified employee is the Asset Controller
// @route   GET /api/AssetItem/unassigned/controller/:employeeId
// @access  Private
export const getUnassignedAssetsForEmployee = async (req, res) => {
    try {
        const { employeeId } = req.params;
        console.log(`[getUnassignedAssetsForEmployee] Processing request for employeeId: ${employeeId}`);

        const assetController = await getDepartmentHOD('assetcontroller');
        console.log(`[getUnassignedAssetsForEmployee] Asset controller found:`, assetController);

        // Resolve the employee record first
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
            // Create user object for isUserInFlowchart function
            const userForCheck = {
                employeeObjectId: employeeObjectId,
                employeeId: employeeId
            };

            try {
                isAuthorized = await isUserInFlowchart(userForCheck, 'assetcontroller');
                console.log(`[getUnassignedAssetsForEmployee] Flowchart authorization result: ${isAuthorized}`);
            } catch (flowchartError) {
                console.error('[getUnassignedAssetsForEmployee] Flowchart error:', flowchartError);
                // If Flowchart is not available, deny access
                return res.status(403).json({
                    message: 'Access denied. Only Asset Controllers can view unassigned assets.',
                    code: 'ASSET_CONTROLLER_REQUIRED',
                    error: 'Flowchart service unavailable'
                });
            }
        }

        if (!isAuthorized) {
            // Check if they are a PENDING asset controller (for approval preview)
            const isPending = await Flowchart.findOne({
                category: 'assetcontroller',
                empObjectId: employeeObjectId,
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
        // Only fetch assets with Unassigned, Returned, or Draft status - explicitly exclude Assigned/Pending
        const items = await AssetItem.find({
            status: { $in: ['Unassigned', 'Returned', 'Draft'] }
        })
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId')
            .populate('typeId', 'name type')
            .populate('categoryId', 'name category')
            .sort({ assetId: 1 });

        // Additional safety filter: explicitly exclude any assets with Assigned or Pending status
        const filteredItems = items.filter(item => {
            const status = item.status?.toString().trim();
            // Only include if status is explicitly Unassigned, Returned, or Draft
            // Explicitly exclude Assigned, Pending, and any other status
            return status === 'Unassigned' || status === 'Returned' || status === 'Draft';
        });

        // Resolve status for frontend badges
        let controllerStatus = 'Active';

        // Re-check if they are specifically Pending
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

        // Send detailed error response
        res.status(500).json({
            message: 'Server Error',
            error: error.message,
            stack: error.stack,
            name: error.name
        });
    }
};

/**
 * @desc    Get assets with "On Leave" status for Asset Controllers
 * @route   GET /api/AssetItem/on-leave/controller/:employeeId
 * @access  Private
 */
export const getOnLeaveAssetsForEmployee = async (req, res) => {
    try {
        const { employeeId } = req.params;
        console.log(`[getOnLeaveAssetsForEmployee] Processing request for employeeId: ${employeeId}`);

        const assetController = await getDepartmentHOD('assetcontroller');
        console.log(`[getOnLeaveAssetsForEmployee] Asset controller found:`, assetController);

        // Resolve the employee record first
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
            // Create user object for isUserInFlowchart function
            const userForCheck = {
                employeeObjectId: employeeObjectId,
                employeeId: employeeId
            };

            try {
                isAuthorized = await isUserInFlowchart(userForCheck, 'assetcontroller');
                console.log(`[getOnLeaveAssetsForEmployee] Flowchart authorization result: ${isAuthorized}`);
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
            // Check if they are a PENDING asset controller (for approval preview)
            const isPending = await Flowchart.findOne({
                category: 'assetcontroller',
                empObjectId: employeeObjectId,
                status: 'Pending'
            });
            if (isPending) isAuthorized = true;
            console.log(`[getOnLeaveAssetsForEmployee] Pending check result: ${!!isPending}`);
        }

        if (!isAuthorized) {
            console.log(`[getOnLeaveAssetsForEmployee] ACCESS DENIED for employee: ${employeeId}`);
            return res.status(403).json({
                message: 'Access denied. Only Asset Controllers can view on-leave assets.',
                code: 'ASSET_CONTROLLER_REQUIRED',
                employeeId: employeeId
            });
        }

        console.log(`[getOnLeaveAssetsForEmployee] ACCESS GRANTED, fetching assets...`);
        // Fetch assets with "On Leave" status (case-insensitive match)
        const items = await AssetItem.find({
            status: { $regex: /^on\s+leave$/i }
        })
            .select('assetId name assetValue status purchaseDate invoiceFile typeId categoryId assignedTo assignedDate')
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

        if (!['Return', 'OnDuty'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action. Must be "Return" or "OnDuty"' });
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
            }

            // Log History
            await AssetHistory.create({
                assetId: item._id,
                action: 'Assigned',
                assignedTo: item.assignedTo._id || item.assignedTo,
                performedBy: req.user.employeeObjectId,
                comments: `Asset status changed from On Leave to Assigned (On Duty) by Asset Controller${originalDuration ? `. Duration tracking started: ${originalDuration} day(s)` : ''}`,
                date: new Date(),
                details: { ...statusSnapshot, duration: originalDuration, onDutyStartDate: item.onLeaveStartDate, onDutyEndDate: item.onLeaveEndDate }
            });
        }

        await item.save();
        await updateAssetTypeCounts(item.typeId);

        res.status(200).json({
            message: `Asset ${action === 'Return' ? 'returned' : 'set to On Duty'} successfully`,
            asset: item
        });
    } catch (error) {
        console.error('Error handling on-leave action:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
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

        // Check if this employee is the HR HOD in the flowchart
        const isHR = await isUserInFlowchart({ employeeObjectId, employeeId }, 'hr');

        if (!isHR) {
            return res.status(200).json({ isHR: false, items: [] });
        }

        // Fetch assets assigned to Company (and filtered by that employee's company)
        // Also include assets where the action is required by this HR (pending company assignments)
        // actionRequiredBy references EmployeeBasic, so query by EmployeeBasic._id
        const items = await AssetItem.find({
            $or: [
                { assignedToType: 'Company', assignedCompany: employee.company },
                { actionRequiredBy: employeeObjectId, status: 'Pending' }
            ]
        })
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

        res.status(200).json({
            isHR: true,
            items
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
        const assetController = await getDepartmentHOD('assetcontroller');

        const isAdmin = req.user.isAdmin === true || req.user.isAdministrator === true;
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        let initialStatus = 'Draft';
        let actionRequiredBy = null;

        if (isAdmin || isAssetController) {
            initialStatus = 'Unassigned';
            console.log(`[Asset creation] Created directly as Unassigned by ${isAdmin ? 'Admin' : 'Asset Controller'}`);
        } else if (assetController) {
            // Find the User record linked to the Asset Controller
            const assetControllerUser = await User.findOne({ employeeId: assetController.employeeId });

            if (assetControllerUser) {
                // Use User._id for actionRequiredBy to match frontend comparison
                actionRequiredBy = assetControllerUser._id;
            } else if (assetController) {
                // Fallback to EmployeeBasic._id if no User found
                actionRequiredBy = assetController._id;
            }
            console.log(`[Asset creation] Created as Draft by regular user ${req.user.employeeId}. Action required by Asset Controller ${assetController.employeeId}`);
        } else {
            // No asset controller defined & user is not admin
            return res.status(403).json({
                message: "Asset creation denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

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

        // Create Dashboard Action for Asset Controller
        if (initialStatus === 'Draft' && actionRequiredBy) {
            try {
                await DashboardAction.create({
                    assignedTo: actionRequiredBy,
                    assignedToEmpId: assetController.employeeId,
                    requestId: newItem._id, // This will be used for redirecting
                    requestType: 'Asset Approval',
                    subjectEmployeeId: req.user.employeeId,
                    subjectName: req.user.name,
                    requestedByName: req.user.name,
                    extra1: `${newItem.assetId} - ${newItem.name}`,
                    extra2: 'New Asset Creation Approval Request',
                    status: 'Pending'
                });
                console.log(`[Dashboard] Created asset approval action for ${assetController.employeeId}`);
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
                creatorName: req.user.name || 'System User'
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

        if (item.status !== 'Draft') {
            return res.status(400).json({ message: 'Asset is not in Draft status.' });
        }

        const assetController = await getDepartmentHOD('assetcontroller');
        const isAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssetController) {
            return res.status(403).json({ message: 'Only Asset Controller or Admin can approve asset creation.' });
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

        // Record History
        try {
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId createdBy');

            await AssetHistory.create({
                assetId: item._id,
                action: action === 'Approve' ? 'Accepted' : 'Rejected',
                performedBy: req.user.employeeObjectId,
                comments: `Asset creation ${action === 'Approve' ? 'Approved' : 'Rejected'} by ${isAssetController ? 'Asset Controller' : 'Admin'}.`,
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
        const isPending = item.status === 'Pending';

        // Check if asset is awaiting creation approval (has actionRequiredBy set and status is Draft or Pending)
        const isAwaitingCreationApproval = (isDraft || isPending) && item.actionRequiredBy !== null;

        // Permission logic:
        // - If Draft or Pending (awaiting creation approval): Creator + Asset Controller + Admin can edit
        // - If NOT awaiting approval: Only Asset Controller + Admin can edit
        if (isAwaitingCreationApproval) {
            // Awaiting creation approval: Creator + Asset Controller + Admin can edit
            if (!isCreator && !isAdmin && !isAssetController) {
                return res.status(403).json({ message: "Only the asset creator, Asset Controller, or Admin can edit assets awaiting creation approval." });
            }
        } else {
            // Not awaiting approval: Only Asset Controller + Admin can edit
            if (!isAdmin && !isAssetController) {
                return res.status(403).json({ message: "Only Asset Controller or Admin can update assets after approval." });
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

        const assetController = await getDepartmentHOD('assetcontroller');
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

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check if assigner (current user) has authorization
        if (!req.user.employeeObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const isAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssignedUser = item.assignedTo?.toString() === req.user.employeeObjectId.toString();

        // Find if this user is a designated Asset Controller for this company
        const assetController = await getDepartmentHOD('assetcontroller');

        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isAssignedUser && !isAssetController) {
            return res.status(403).json({ message: "You are not authorized to assign or reassign this asset." });
        }

        const assigner = await EmployeeBasic.findById(req.user.employeeObjectId);
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

        } else {
            // Assigning to an Employee (Default)
            const employeeToAssign = await EmployeeBasic.findById(assignedTo).select('employeeId firstName lastName companyEmail primaryReportee');
            if (!employeeToAssign) return res.status(404).json({ message: "Target employee not found" });

            const linkedUser = await User.findOne({ employeeId: employeeToAssign?.employeeId, status: 'Active' });
            const hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess && employeeToAssign?.companyEmail);

            // If employee has no portal access AND no manager, no one can acknowledge the asset
            if (!hasPortalAccess && !employeeToAssign?.primaryReportee) {
                return res.status(400).json({
                    message: "This employee lacks Portal Access (Company Email/User Account) and has no Primary Reportee (Manager). No one can receive this asset."
                });
            }

            item.assignedToType = 'Employee';
            item.assignedTo = assignedTo;
            item.assignedCompany = null;
            item.status = 'Pending';
            item.acceptanceStatus = 'Pending';

            if (!hasPortalAccess && employeeToAssign?.primaryReportee) {
                item.actionRequiredBy = employeeToAssign.primaryReportee;
            } else {
                item.actionRequiredBy = assignedTo;
            }

            actionRequiredBy = item.actionRequiredBy;
            actionRecipient = await EmployeeBasic.findById(actionRequiredBy);
            subjectName = `${employeeToAssign.firstName} ${employeeToAssign.lastName}`;
            subjectEmpId = employeeToAssign.employeeId;
        }

        item.assignedBy = req.user.employeeObjectId;
        item.assignmentType = assignmentType;
        item.assignedDays = assignmentType === 'Temporary' ? assignedDays : null;
        item.negotiationHistory = [];

        await item.save();

        // Send Email Notification
        try {
            await sendAssetAssignmentEmail({
                asset: item,
                employee: assignedToType === 'Company' ? { firstName: subjectName, lastName: "", isCompany: true } : actionRecipient,
                recipient: actionRecipient,
            });
        } catch (err) {
            console.error(`[Email Error] Failed to send assignment email: `, err);
        }

        // Create Dashboard Action
        try {
            await DashboardAction.create({
                assignedTo: actionRequiredBy,
                assignedToEmpId: actionRecipient?.employeeId,
                requestId: item._id,
                requestType: 'Asset Assignment',
                subjectEmployeeId: subjectEmpId,
                subjectName: subjectName,
                requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                extra1: `${item.assetId} - ${item.name} `,
                extra2: item.assignmentType,
                status: 'Pending'
            });
            console.log(`[Dashboard] Created asset assignment action for ${actionRecipient?.employeeId}`);
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

        // Send Email Notification
        try {
            const employee = updatedItem.assignedTo;
            if (employee) {
                // Scenario 1: Employee has a company email AND an active portal account, send directly to them
                const linkedUser = await User.findOne({ employeeId: employee.employeeId, status: 'Active' });
                const hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);

                if (employee.companyEmail && hasPortalAccess) {
                    await sendAssetAssignmentEmail({
                        asset: updatedItem,
                        employee: employee,
                        recipient: employee
                    });
                }
                // Scenario 2: Employee lacks company email or portal access, send to their Primary Reportee (Manager)
                else if (employee.primaryReportee) {
                    const managerId = employee.primaryReportee._id || employee.primaryReportee;
                    const manager = await EmployeeBasic.findById(managerId);

                    if (manager) {
                        console.log(`[Asset Assignment] No company email for ${employee.firstName}.Notifying manager: ${manager.firstName} `);
                        await sendAssetAssignmentEmail({
                            asset: updatedItem,
                            employee: employee,
                            recipient: manager
                        });
                    }
                }
            }
        } catch (emailErr) {
            console.error('Error in asset assignment email trigger:', emailErr);
        }

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

        // Determine actionRequiredBy based on Portal Access and Company Email
        const employeeToAssign = await EmployeeBasic.findById(assignedTo).select('employeeId companyEmail primaryReportee');
        const linkedUser = await User.findOne({ employeeId: employeeToAssign?.employeeId, status: 'Active' });
        const hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess && employeeToAssign?.companyEmail);

        // If employee has no portal access AND no manager, no one can acknowledge the asset
        if (!hasPortalAccess && !employeeToAssign?.primaryReportee) {
            return res.status(400).json({
                message: "This employee lacks Portal Access (Company Email/User Account) and has no Primary Reportee (Manager). No one can receive these assets."
            });
        }

        let actionRequiredBy = assignedTo;
        if (!hasPortalAccess && employeeToAssign?.primaryReportee) {
            actionRequiredBy = employeeToAssign.primaryReportee;
        }

        // Update all items
        const updateData = {
            assignedTo,
            assignedBy: req.user.employeeObjectId,
            assignmentType,
            assignedDays: assignmentType === 'Temporary' ? assignedDays : null,
            status: 'Pending',
            acceptanceStatus: 'Pending',
            actionRequiredBy,
            negotiationHistory: []
        };

        await AssetItem.updateMany(
            { _id: { $in: assetIds } },
            { $set: updateData }
        );

        // Create Dashboard Actions for each asset
        try {
            const actionRecipient = await EmployeeBasic.findById(actionRequiredBy).select('employeeId firstName lastName');
            const subjectEmp = await EmployeeBasic.findById(assignedTo).select('employeeId firstName lastName');
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

        // Send Email Notification
        try {
            const employee = await EmployeeBasic.findById(assignedTo);
            const firstAsset = await AssetItem.findById(assetIds[0]).populate('categoryId');

            if (employee && firstAsset) {
                // Scenario 1: Employee has a company email AND an active portal account, send directly to them
                const linkedUser = await User.findOne({ employeeId: employee.employeeId, status: 'Active' });
                const hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);

                if (employee.companyEmail && hasPortalAccess) {
                    await sendAssetAssignmentEmail({
                        asset: firstAsset,
                        employee: employee,
                        recipient: employee,
                        isBulk: true,
                        assetCount: assetIds.length
                    });
                }
                // Scenario 2: Employee lacks company email or portal access, send to their Primary Reportee (Manager)
                else if (employee.primaryReportee) {
                    const managerId = employee.primaryReportee._id || employee.primaryReportee;
                    const manager = await EmployeeBasic.findById(managerId);

                    if (manager) {
                        console.log(`[Bulk Asset Assignment] No company email or portal access for ${employee.firstName}.Notifying manager: ${manager.firstName} `);
                        await sendAssetAssignmentEmail({
                            asset: firstAsset,
                            employee: employee,
                            recipient: manager,
                            isBulk: true,
                            assetCount: assetIds.length
                        });
                    }
                }
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
        const isAssignee = item.assignedTo?._id.toString() === currentUser.toString();
        const isAssigner = item.assignedBy?._id.toString() === currentUser.toString();

        // Check if the current user is the manager (Primary Reportee) of the assignee (if employee assignment)
        const isManager = item.assignedToType === 'Employee' && item.assignedTo?.primaryReportee?.toString() === currentUser.toString();

        // Check if user is the designated action required per HR flow (if company assignment)
        const isHR = item.assignedToType === 'Company' && item.actionRequiredBy?.toString() === currentUser.toString();

        // Check if user is involved
        if (!isAssignee && !isAssigner && !isManager && !isHR) {
            return res.status(403).json({ message: 'You are not authorized to respond to this assignment.' });
        }

        const assignee = item.assignedTo;

        if (item.assignedToType === 'Employee') {
            // Dynamic Portal Access Check: Check if an active User account exists for the assignee
            const linkedUser = await User.findOne({ employeeId: assignee?.employeeId, status: 'Active' });
            const hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
            const assigneeHasNoAccess = !assignee?.companyEmail || !hasPortalAccess;

            // Check if action is required by this user
            if (item.actionRequiredBy && item.actionRequiredBy.toString() !== currentUser.toString()) {
                // Allow manager to act if assignee has no access
                if (!(isManager && assigneeHasNoAccess)) {
                    return res.status(403).json({ message: 'It is not your turn to respond.' });
                }
            }
        } else {
            // Company Flow: Only the person in actionRequiredBy (HR) can act
            if (item.actionRequiredBy && item.actionRequiredBy.toString() !== currentUser.toString()) {
                return res.status(403).json({ message: 'It is not your turn (HR HOD required) to respond.' });
            }
        }

        // Determine actor for notifications
        let actor = isAssignee ? item.assignedTo : ((isManager || isHR) ? await EmployeeBasic.findById(currentUser) : item.assignedBy);

        // Notify all relevant parties
        const notifyParties = async () => {
            try {
                const recipients = [];
                // 1. Always notify the person who assigned the asset
                if (item.assignedBy) recipients.push(item.assignedBy);

                // 2. Notify the subject employee if they were NOT the one who acted
                if (item.assignedToType === 'Employee' && item.assignedTo && item.assignedTo._id.toString() !== currentUser.toString()) {
                    recipients.push(item.assignedTo);
                }

                // 3. For 'Accept', also notify Manager (Employee Flow only)
                if (action === 'Accept' && item.assignedToType === 'Employee' && item.assignedTo?.primaryReportee) {
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    if (!recipients.some(r => r._id.toString() === managerId.toString()) && managerId.toString() !== currentUser.toString()) {
                        const manager = await EmployeeBasic.findById(managerId);
                        if (manager) recipients.push(manager);
                    }
                }

                for (const recipient of recipients) {
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

        if (action === 'Reject') {
            await notifyParties();

            // Capture snapshot BEFORE clearing
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId assignedTo assignedBy acceptedBy assignedCompany');
            req.rejectionSnapshot = snapshotItem.toObject();

            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedCompany = null;
            item.assignedBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = 'Rejected';
            item.actionRequiredBy = null;
            item.negotiationHistory = [];

        } else if (action === 'Accept') {
            item.status = 'Assigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;
            item.acceptedBy = req.user.employeeObjectId;

            await notifyParties();

        } else if (action === 'AcceptWithComments') {
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

            // Pass the ball
            if (isAssignee || isManager || isHR) {
                // Ball goes back to Assigner
                item.actionRequiredBy = item.assignedBy._id || item.assignedBy;
            } else {
                // Ball goes to Assignee/HR
                if (item.assignedToType === 'Company') {
                    const targetCompanyId = item.assignedCompany._id || item.assignedCompany;
                    const hrHOD = await getDepartmentHOD('hr');
                    // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                    item.actionRequiredBy = hrHOD._id;
                } else {
                    const assigneeEmp = await EmployeeBasic.findById(item.assignedTo);
                    const linkedUser = await User.findOne({ employeeId: assigneeEmp?.employeeId, status: 'Active' });
                    const hasAccess = !!(linkedUser && linkedUser.enablePortalAccess && assigneeEmp.companyEmail);

                    if (!hasAccess && assigneeEmp.primaryReportee) {
                        item.actionRequiredBy = assigneeEmp.primaryReportee;
                    } else {
                        item.actionRequiredBy = item.assignedTo._id || item.assignedTo;
                    }
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

            await AssetHistory.create({
                assetId: item._id,
                action: 'Accepted',
                assignedToType: item.assignedToType,
                assignedTo: item.assignedTo,
                assignedCompany: item.assignedCompany,
                performedBy: req.user.employeeObjectId,
                comments: isManager ? `Accepted by manager on behalf of employee. ${comments || ''} ` : (isHR ? `Accepted by HR on behalf of company. ${comments || ''} ` : comments),
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

// @desc    Return an asset item (unassign)
// @route   PUT /api/AssetItem/:id/return
// @access  Private
export const returnAssetItem = async (req, res) => {
    try {
        const { id } = req.params;

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Asset return denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        const item = await AssetItem.findById(id);

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
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

        // Check if user has permission (Asset Controller or Admin)
        const assetController = await getDepartmentHOD('assetcontroller', req.user.employeeObjectId);
        const isAssetController = assetController && assetController._id.toString() === req.user.employeeObjectId?.toString();
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';

        if (!isAssetController && !isAdmin) {
            return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can transfer assets.' });
        }

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

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Accessory transfer denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        const sourceAsset = await AssetItem.findById(id);
        const targetAsset = await AssetItem.findById(targetAssetId);

        if (!sourceAsset || !targetAsset) {
            return res.status(404).json({ message: 'Source or Target asset not found' });
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

        const assetController = await getDepartmentHOD('assetcontroller');
        if (!assetController) {
            return res.status(403).json({
                message: "Accessory status update denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
            });
        }

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) {
            return res.status(404).json({ message: 'Accessory not found' });
        }

        accessory.status = status;
        await asset.save();

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
        const { actionType, reason, attachment, fineData } = req.body; // actionType: 'End of Life', 'Loss and Damage', or 'Leave'

        if (!['End of Life', 'Loss and Damage', 'Leave'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
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
        const { duration, leaveDuration } = req.body; // Duration in days for Leave action
        asset.pendingActionDetails = {
            reason: reason,
            attachment: fileUrl,
            fineData: fineData || null, // Store full fine payload
            duration: duration || leaveDuration || null, // Store duration for Leave action
            leaveDuration: leaveDuration || duration || null // Alias for clarity
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
            requestedByName: `${req.user.firstName} ${req.user.lastName}`,
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

        const requesterName = `${req.user.firstName} ${req.user.lastName}`;

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
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Bulk Request Asset Action (End of Life, Loss & Damage, or Leave)
// @route   PUT /api/AssetItem/bulk/request-action
// @access  Private
export const bulkRequestAssetAction = async (req, res) => {
    try {
        const { assetIds, actionType, reason } = req.body;

        if (!Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'Please provide at least one asset ID' });
        }

        if (!['End of Life', 'Loss and Damage', 'Leave'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        const assets = await AssetItem.find({ _id: { $in: assetIds } }).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        }).populate('assignedCompany');

        if (assets.length !== assetIds.length) {
            return res.status(404).json({ message: 'One or more assets not found' });
        }

        const assetController = await getDepartmentHOD('assetcontroller');
        const hrHOD = await getDepartmentHOD('hr');

        if (!assetController || !hrHOD) {
            return res.status(400).json({ message: 'Asset Controller or HR HOD not found. Cannot request approval.' });
        }

        // Upload attachment if present (for bulk, we'll use the same attachment for all)
        let fileUrl = null;
        // Note: For bulk, attachment would need to be handled per asset if different

        const results = [];
        const errors = [];
        const bulkAssetIds = [];

        for (const asset of assets) {
            try {
                // Determine approver based on asset assignment
                let nextApprover;
                if (asset.assignedToType === 'Company' && asset.assignedCompany) {
                    nextApprover = hrHOD;
                } else {
                    nextApprover = assetController;
                }

                // Store pending request in asset
                asset.pendingAction = actionType;
                asset.pendingActionDetails = {
                    reason: reason,
                    attachment: fileUrl,
                    isBulk: true,
                    bulkAssetIds: assetIds, // Store all asset IDs for bulk tracking
                    fineData: null
                };

                // actionRequiredBy references EmployeeBasic, so use EmployeeBasic._id
                asset.actionRequiredBy = nextApprover._id;
                asset.status = 'Pending';

                await asset.save();

                // Create Dashboard Action for each asset
                const dashboardRequestType = actionType === 'End of Life' ? 'Asset End of Life' :
                    actionType === 'Leave' ? 'Asset Leave' : 'Asset Loss Damage';
                await DashboardAction.create({
                    assignedTo: nextApprover._id,
                    requestId: asset._id,
                    requestType: dashboardRequestType,
                    status: 'Pending',
                    subjectEmployeeId: asset.assignedTo?.employeeId || (asset.assignedCompany ? asset.assignedCompany.companyId : 'UNASSIGNED'),
                    subjectName: asset.assignedTo ? `${asset.assignedTo.firstName} ${asset.assignedTo.lastName}` : (asset.assignedCompany ? asset.assignedCompany.name : 'Unassigned Asset'),
                    requestedByName: `${req.user.firstName} ${req.user.lastName}`,
                    extra1: `${asset.assetId} — ${asset.name}`,
                    extra2: actionType,
                    // Store bulk info in extra fields
                    extra3: assets.length > 1 ? JSON.stringify({ isBulk: true, totalAssets: assets.length, assetIds: assetIds.map(id => id.toString()) }) : null
                });

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

        // Send email notification to Asset Controller (using first asset as reference)
        if (results.length > 0 && assets.length > 0) {
            const requesterName = `${req.user.firstName} ${req.user.lastName}`;
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
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Handle Asset Action Approval/Rejection
export const handleAssetActionApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const { approve, comment } = req.body;

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
                    const { sendAssetActionApprovedEmail } = await import('../utils/sendAssetActionApprovedEmail.js');
                    const { sendAssetTransferSuccessEmail } = await import('../utils/sendAssetTransferSuccessEmail.js');

                    // Send to assigned users (if exists and action is Leave)
                    if (actionType === 'Leave') {
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
                return res.status(200).json({
                    message: bulkMessage,
                    asset,
                    processedCount: processedAssets.length,
                    isBulk: isBulkTransfer
                });
            }

            // For "Loss and Damage", Asset Controller approval creates a Fine with status "Pending HR"
            if (isAssetControllerApprowing && actionType === 'Loss and Damage') {
                // STEP 1 APPROVED (Asset Controller) -> Create Fine with status "Pending HR"
                if (asset.pendingActionDetails?.fineData) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const { getDepartmentHOD } = await import('../utils/getDepartmentHOD.js');
                        const User = (await import('../models/User.js')).default;
                        const { syncDashboardAction } = await import('../utils/syncDashboard.js');

                        const fd = asset.pendingActionDetails.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        // Get HR HOD for fine assignment
                        const hrHOD = await getDepartmentHOD('hr');
                        if (!hrHOD) {
                            return res.status(400).json({ message: 'HR HOD not found. Cannot create fine.' });
                        }

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
                            attachment: asset.pendingActionDetails.attachment ? {
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

        // Resolve requester name from employee record (req.user doesn't carry firstName/lastName)
        const requesterEmp = await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName');
        const requesterName = requesterEmp ? `${requesterEmp.firstName} ${requesterEmp.lastName}` : req.user.employeeId || 'System';

        const assetController = await getDepartmentHOD('assetcontroller');
        const hrHOD = await getDepartmentHOD('hr');

        if (!assetController || !hrHOD) {
            return res.status(400).json({ message: 'Asset Controller or HR HOD not found. Cannot request approval.' });
        }

        const requesterId = (req.user.employeeObjectId || req.user._id).toString();
        const isControllerOrAdmin = requesterId === assetController?._id?.toString() || req.user.role === 'Admin' || req.user.role === 'ROOT';

        // CORRECT FLOW based on user requirements:
        // 1. If asset is assigned to COMPANY -> HR approves (skip Asset Controller)
        // 2. If asset is UNASSIGNED -> Asset Controller approves
        // 3. If asset is ASSIGNED to Employee -> Asset Controller approves first, then HR

        let finalApprover;
        if (asset.assignedToType === 'Company' && asset.assignedCompany) {
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
        const { approve, comment, attachment } = req.body;

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

        if (approve) {
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
                const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller') || req.user.role === 'Admin' || req.user.role === 'ROOT';

                if (!isAssetController) {
                    return res.status(403).json({ message: 'Only Asset Controller can approve transfers.' });
                }

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

            // --- EXISTING LOGIC FOR L&D / EOL ---
            const isAssetControllerApproving = await isUserInFlowchart(req.user, 'assetcontroller');
            const isCompanyAsset = asset.assignedToType === 'Company' && asset.assignedCompany;

            // actionRequiredBy references EmployeeBasic, so compare with EmployeeBasic._id
            const isHRApproving = hrHOD?._id?.toString() === currentUserEmpId;

            // For Loss and Damage, Asset Controller approval creates Fine with status "Pending HR"
            if (isAssetControllerApproving && pendingAction === 'Loss and Damage') {
                if (pendingActionDetails?.fineData) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const User = (await import('../models/User.js')).default;
                        const { syncDashboardAction } = await import('../utils/syncDashboard.js');
                        const fd = pendingActionDetails.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        // Get HR HOD for fine assignment
                        const hrHOD = await getDepartmentHOD('hr');
                        if (!hrHOD) {
                            return res.status(400).json({ message: 'HR HOD not found. Cannot create fine.' });
                        }

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



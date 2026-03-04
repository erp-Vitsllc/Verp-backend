import AssetItem from '../models/AssetItem.js';
import mongoose from 'mongoose';
import AssetType from '../models/AssetType.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import { getSignedFileUrl, uploadDocumentToS3 } from '../utils/s3Upload.js';
import { generatePdf } from '../utils/generatePdf.js';
import User from '../models/User.js';
import { sendAssetAssignmentEmail } from '../utils/sendAssetAssignmentEmail.js';
import { sendAssetResponseEmail } from '../utils/sendAssetResponseEmail.js';
import DashboardAction from '../models/DashboardAction.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { sendAssetActionFinalAcknowledgeEmail } from '../utils/sendAssetActionFinalAcknowledgeEmail.js';
import Fine from '../models/Fine.js';
import AssetCategory from '../models/AssetCategory.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

// Helper to generate unique fine IDs (copied from fineController/addFine)
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
        return `VEGA - FINE - ${nextNum.toString().padStart(4, '0')} `;
    } catch (error) {
        console.error('Error generating internal fine ID:', error);
        return `fine${Date.now().toString().slice(-4)} `;
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
        const items = await AssetItem.find({
            status: { $in: ['Assigned', 'Active', 'Returned'] },
            assignedTo: { $ne: null }
        })
            .select('assetId name assignedTo accessories assetValue status updatedAt typeId categoryId invoiceFile')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId'
            })
            .populate('typeId', 'name')
            .populate('categoryId', 'name')
            .sort({ name: 1 });

        res.status(200).json(items);
    } catch (error) {
        console.error('Error fetching assigned assets:', error);
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
            status: status || 'Unassigned',
            lastServiceDate: lastServiceDate || null,
            accessories: formattedAccessories
        });

        // Update counts on AssetType
        await updateAssetTypeCounts(assetTypeId);

        res.status(201).json(newItem);
    } catch (error) {
        console.error('Error creating asset item:', error);
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

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
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
        const { assignedTo, assignmentType, assignedDays } = req.body;

        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Employee and assignment type are required' });
        }

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
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
                message: "This employee lacks Portal Access (Company Email/User Account) and has no Primary Reportee (Manager). No one can receive this asset."
            });
        }

        item.assignedTo = assignedTo;
        item.assignedBy = req.user.employeeObjectId;
        item.assignmentType = assignmentType;
        item.assignedDays = assignmentType === 'Temporary' ? assignedDays : null;
        item.status = 'Pending';
        item.acceptanceStatus = 'Pending';

        // If employee has no portal access or no company email, action is required by their manager
        if (!hasPortalAccess && employeeToAssign?.primaryReportee) {
            item.actionRequiredBy = employeeToAssign.primaryReportee;
        } else {
            item.actionRequiredBy = assignedTo;
        }

        item.negotiationHistory = [];

        await item.save();

        // Create Dashboard Action for the person who needs to act
        try {
            const actionRecipient = await EmployeeBasic.findById(item.actionRequiredBy).select('employeeId firstName lastName');
            const subjectEmp = await EmployeeBasic.findById(item.assignedTo).select('employeeId firstName lastName');

            await DashboardAction.create({
                assignedTo: item.actionRequiredBy,
                assignedToEmpId: actionRecipient?.employeeId,
                requestId: item._id,
                requestType: 'Asset',
                subjectEmployeeId: subjectEmp?.employeeId,
                subjectName: `${subjectEmp?.firstName || ""} ${subjectEmp?.lastName || ""} `.trim(),
                requestedByName: `${assigner?.firstName || "System"} ${assigner?.lastName || ""} `.trim(),
                extra1: `${item.assetId} - ${item.name} `,
                extra2: item.assignmentType,
                status: 'Pending'
            });
            console.log(`[Dashboard] Created asset action for ${actionRecipient?.employeeId}`);
        } catch (err) {
            console.error(`[Dashboard Error] Failed to create action for asset ${item.assetId}: `, err);
        }

        // Log to Asset History with Snapshot
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');

        await AssetHistory.create({
            assetId: item._id,
            action: 'Assigned',
            assignedTo: assignedTo,
            performedBy: req.user.employeeObjectId,
            details: snapshotItem.toObject()
        });

        // Update counts on AssetType
        await updateAssetTypeCounts(item.typeId);

        const updatedItem = await AssetItem.findById(id)
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
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');

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

        const item = await AssetItem.findById(id).populate('assignedTo assignedBy');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const currentUser = req.user.employeeObjectId;
        const isAssignee = item.assignedTo?._id.toString() === currentUser.toString();
        const isAssigner = item.assignedBy?._id.toString() === currentUser.toString();

        // Check if the current user is the manager (Primary Reportee) of the assignee
        const isManager = item.assignedTo?.primaryReportee?.toString() === currentUser.toString();

        // Check if user is involved
        if (!isAssignee && !isAssigner && !isManager) {
            return res.status(403).json({ message: 'You are not authorized to respond to this assignment.' });
        }

        const assignee = item.assignedTo;

        // Dynamic Portal Access Check: Check if an active User account exists for the assignee
        const linkedUser = await User.findOne({ employeeId: assignee?.employeeId, status: 'Active' });
        const hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);

        const assigneeHasNoAccess = !assignee?.companyEmail || !hasPortalAccess;

        // Check if action is required by this user
        // If actionRequiredBy is set, only that user can act.
        if (item.actionRequiredBy && item.actionRequiredBy.toString() !== currentUser.toString()) {
            // Allow manager to act if assignee has no access
            if (!(isManager && assigneeHasNoAccess)) {
                return res.status(403).json({ message: 'It is not your turn to respond.' });
            }
        }

        // Determine actor for notifications
        let actor = isAssignee ? item.assignedTo : (isManager ? await EmployeeBasic.findById(currentUser) : item.assignedBy);

        // Notify all relevant parties
        const notifyParties = async () => {
            try {
                const recipients = [];
                // 1. Always notify the person who assigned the asset
                if (item.assignedBy) recipients.push(item.assignedBy);

                // 2. Notify the subject employee if they were NOT the one who acted (e.g. manager acted for them)
                if (item.assignedTo && item.assignedTo._id.toString() !== currentUser.toString()) {
                    recipients.push(item.assignedTo);
                }

                // 3. For 'Accept', also notify Manager if they haven't been notified yet and weren't the actor
                if (action === 'Accept' && item.assignedTo?.primaryReportee) {
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    if (!recipients.some(r => (r._id || r).toString() === managerId.toString()) && managerId.toString() !== currentUser.toString()) {
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
                        comment: comments
                    });
                }
            } catch (err) {
                console.error("[Email Error] Failed to notify parties after asset response:", err);
            }
        };

        if (action === 'Reject') {
            // Rejection resets the assignment completely
            await notifyParties();

            // Capture snapshot BEFORE clearing
            const snapshotItem = await AssetItem.findById(item._id)
                .populate('categoryId typeId assignedTo assignedBy acceptedBy');
            req.rejectionSnapshot = snapshotItem.toObject();

            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = 'Rejected';
            item.actionRequiredBy = null;
            item.negotiationHistory = [];

        } else if (action === 'Accept') {
            // Final Acceptance
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
                    fileUrl = uploadResult.publicId; // Store Key/PublicId
                } catch (err) {
                    console.error('File upload failed during negotiation:', err);
                }
            }

            // Negotiation Loop
            item.negotiationHistory.push({
                sender: currentUser,
                message: comments,
                action: 'AcceptWithComments',
                file: fileUrl,
                date: new Date()
            });

            // Pass the ball
            if (isAssignee || isManager) {
                // Ball goes back to Assigner
                item.actionRequiredBy = item.assignedBy._id || item.assignedBy;
            } else {
                // Ball goes to Assignee (or fallback to Manager)
                const assigneeEmp = await EmployeeBasic.findById(item.assignedTo);
                const linkedUser = await User.findOne({ employeeId: assigneeEmp?.employeeId, status: 'Active' });
                const hasAccess = !!(linkedUser && linkedUser.enablePortalAccess && assigneeEmp.companyEmail);

                if (!hasAccess && assigneeEmp.primaryReportee) {
                    item.actionRequiredBy = assigneeEmp.primaryReportee;
                } else {
                    item.actionRequiredBy = item.assignedTo._id || item.assignedTo;
                }
            }

            await notifyParties();

            // Log negotiation
            await AssetHistory.create({
                assetId: item._id,
                action: 'Comment',
                assignedTo: item.assignedTo, // Current assignee
                performedBy: req.user.employeeObjectId,
                comments: comments,
                file: fileUrl
            });
        }

        await item.save();

        // Update Dashboard Actions
        try {
            // Find the action that was pending for this user and this asset
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
                console.log(`[Dashboard] Updated existing action for ${item.assetId} to ${existingAction.status} `);
            }

            // If it's a negotiation (AcceptWithComments), create a new action for the next person in line
            if (action === 'AcceptWithComments') {
                const nextActorId = item.actionRequiredBy;
                const nextActor = await EmployeeBasic.findById(nextActorId).select('employeeId firstName lastName');
                const subjectEmp = await EmployeeBasic.findById(item.assignedTo).select('employeeId firstName lastName');
                const senderEmp = await EmployeeBasic.findById(currentUser).select('firstName lastName');

                await DashboardAction.create({
                    assignedTo: nextActorId,
                    assignedToEmpId: nextActor?.employeeId,
                    requestId: item._id,
                    requestType: 'Asset',
                    subjectEmployeeId: subjectEmp?.employeeId,
                    subjectName: `${subjectEmp?.firstName || ""} ${subjectEmp?.lastName || ""} `.trim(),
                    requestedByName: `${senderEmp?.firstName || ""} ${senderEmp?.lastName || ""} `.trim(),
                    extra1: `${item.assetId} - ${item.name} `,
                    extra2: `Update Required: ${comments} `,
                    status: 'Pending'
                });
                console.log(`[Dashboard] Created negotiation action for ${nextActor?.employeeId}`);
            }
        } catch (err) {
            console.error(`[Dashboard Error] Failed to update action for asset ${item.assetId}: `, err);
        }

        // Log final actions with Snapshot
        if (action === 'Reject') {
            await AssetHistory.create({
                assetId: item._id,
                action: 'Rejected',
                assignedTo: null,
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
                .populate('categoryId typeId assignedTo assignedBy acceptedBy');

            await AssetHistory.create({
                assetId: item._id,
                action: 'Accepted',
                assignedTo: item.assignedTo,
                performedBy: req.user.employeeObjectId,
                comments: isManager ? `Accepted by manager on behalf of employee.${comments || ''} ` : comments,
                details: {
                    ...snapshotItem.toObject(),
                    isAcceptedByManager: isManager
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
        const item = await AssetItem.findById(id);

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Store current details for history
        const prevAssignedTo = item.assignedTo;
        const originalAssigner = item.assignedBy;

        const { reassignTo, assignmentType, assignedDays } = req.body;

        // Capture snapshot BEFORE mutation
        const snapshotItem = await AssetItem.findById(item._id)
            .populate('categoryId typeId assignedTo assignedBy acceptedBy');
        const returnSnapshot = snapshotItem.toObject();

        if (reassignTo) {
            // ... (mutation logic here) ...
            const newAssignee = await EmployeeBasic.findById(reassignTo);
            if (!newAssignee) {
                return res.status(404).json({ message: "Target employee for reassignment not found" });
            }

            item.assignedTo = newAssignee._id;
            item.assignedBy = req.user.employeeObjectId;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;

            // Set assignment details if provided
            item.assignmentType = assignmentType || 'Permanent';
            item.assignedDays = assignedDays || null;
            item.negotiationHistory = [];
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
            performedBy: req.user.employeeObjectId || req.user._id,
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

            // Build service record
            serviceRecord = {
                date: new Date(),
                serviceDuration: serviceDuration || null,
                description: description || note || null,
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

        // Log history
        await AssetHistory.create({
            assetId: item._id,
            action: status === 'Unassigned' ? 'Unassigned' : status === 'Service' ? 'Service' : 'Live',
            performedBy: req.user.employeeObjectId,
            comments: description || note || serviceReport || null,
            file: (status === 'Service' ? (serviceRecord?.invoice || serviceRecord?.attachment) : completionRecord?.attachment) || null,
            details: {
                ...statusSnapshot,
                serviceDuration: serviceDuration || null,
                amount: amount || 0,
                serviceReport: serviceReport || null
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
            .sort({ date: -1 });

        // Sign URLs for attachments
        const historyWithUrls = await Promise.all(history.map(async (record) => {
            const recordObj = record.toObject();
            if (recordObj.file) {
                recordObj.file = await getSignedFileUrl(recordObj.file);
            }
            if (recordObj.details && recordObj.details.invoice) {
                recordObj.details.invoice = await getSignedFileUrl(recordObj.details.invoice);
            }
            return recordObj;
        }));

        res.status(200).json(historyWithUrls);
    } catch (error) {
        console.error('Error fetching asset history:', error);
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

        asset.documents.pull({ _id: docId });
        await asset.save();

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

        accessory.status = status;
        await asset.save();

        // Log History
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId,
            comments: `Accessory "${accessory.name}" marked as ${status}.Note: ${comments || 'No comments'} `
        });

        res.status(200).json({ message: `Accessory marked as ${status} `, asset });
    } catch (error) {
        console.error('Error updating accessory status:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Request Asset Action (End of Life or Loss & Damage)
// @route   PUT /api/AssetItem/:id/request-action
// @access  Private
export const requestAssetAction = async (req, res) => {
    try {
        const { id } = req.params;
        const { actionType, reason, attachment, fineData } = req.body; // actionType: 'End of Life' or 'Loss and Damage'

        if (!['End of Life', 'Loss and Damage'].includes(actionType)) {
            return res.status(400).json({ message: 'Invalid action type' });
        }

        const asset = await AssetItem.findById(id).populate({
            path: 'assignedTo',
            populate: { path: 'primaryReportee' }
        });

        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        if (!asset.assignedTo) {
            return res.status(400).json({ message: 'No user assigned to this asset. Cannot request action.' });
        }

        // Upload attachment if present
        let fileUrl = null;
        if (attachment && attachment.startsWith('data:')) {
            const uploadResult = await uploadDocumentToS3(attachment, 'asset-history');
            fileUrl = uploadResult.publicId;
        }

        // Store pending request in asset
        asset.pendingAction = actionType;
        asset.pendingActionDetails = {
            reason: reason,
            attachment: fileUrl,
            fineData: fineData || null // Store full fine payload
        };

        // Determine who gets the request
        const requesterId = req.user._id.toString();
        const managerId = asset.assignedTo.primaryReportee?._id?.toString();
        const isManagerRequester = requesterId === managerId;

        if (isManagerRequester && actionType === 'End of Life') {
            // Manager initiated EOL -> Instantly Mark Out of Service
            asset.status = 'Out of Service';

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Out of Service',
                performedBy: req.user._id,
                comments: `Manager initiated and finalized End of Life. Reason: ${reason}`,
                file: fileUrl,
                date: new Date(),
                details: { type: 'ActionRequest', action: actionType }
            });

            asset.assignedTo = null;
            asset.assignmentType = null;
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;

            await asset.save();
            return res.status(200).json({
                message: `${actionType} reported and finalized by manager. Asset marked Out of Service.`,
                asset
            });
        }

        // DEFAULT: Goes to Manager for approval
        if (!asset.assignedTo.primaryReportee) {
            return res.status(400).json({ message: 'Reporting manager not found for assigned user. Cannot request approval.' });
        }

        asset.actionRequiredBy = asset.assignedTo.primaryReportee._id;
        asset.status = 'Pending';

        await asset.save();

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
            asset.assignedTo.primaryReportee,
            { name: requesterName },
            reason
        );

        res.status(200).json({ message: `${actionType} request sent to manager for approval`, asset });
    } catch (error) {
        console.error('Error requesting asset action:', error);
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
        });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!asset.pendingAction) return res.status(400).json({ message: 'No pending action' });

        const actionType = asset.pendingAction;

        // AUTH CHECK
        const currentUserId = req.user.employeeObjectId?.toString() || req.user._id?.toString();
        if (asset.actionRequiredBy?.toString() !== currentUserId) {
            return res.status(403).json({ message: 'You are not authorized to approve this action.' });
        }

        if (approve) {
            if (actionType === 'Loss and Damage') {
                // Manager approved, create the fine record directly
                if (asset.pendingActionDetails?.fineData) {
                    try {
                        const Fine = (await import('../models/Fine.js')).default;
                        const { generateFineIdInternal } = await import('./fine/addFine.js');
                        const fd = asset.pendingActionDetails.fineData;
                        const uniqueFineId = await generateFineIdInternal();

                        const { employees, ...cleanFd } = fd;
                        const fineModel = new Fine({
                            ...cleanFd,
                            assignedEmployees: employees || fd.assignedEmployees || [],
                            company: asset.assignedTo?.company?._id || fd.company,
                            companyName: asset.assignedTo?.company?.name || fd.companyName || '',
                            fineId: uniqueFineId,
                            fineStatus: 'Draft',
                            hrApprovedBy: req.user._id,
                            createdBy: req.user._id,
                            awardedDate: new Date(),
                            assetObjectId: asset._id,
                            attachment: asset.pendingActionDetails.attachment ? {
                                url: asset.pendingActionDetails.attachment,
                                name: 'Loss and Damage.pdf',
                                mimeType: 'application/pdf'
                            } : fd.attachment
                        });
                        await fineModel.save();
                        console.log(`[Asset] Fine created from manager approval: ${uniqueFineId}`);
                    } catch (fineErr) {
                        console.error('[Asset] Fine creation failed during manager approval:', fineErr);
                    }
                }
            }

            // FINALIZATION: Mark Out of Service & Unassign immediately upon manager approval
            asset.status = 'Out of Service';

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Out of Service',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: `Approved "${actionType}" and finalized by Manager. ${comment || ''}`,
                date: new Date(),
                details: { status: 'ApprovedAndFinalized', originalAction: actionType }
            });

            // UNASSIGN Asset directly, removing the need for employee acknowledgement
            asset.assignedTo = null;
            asset.assignmentType = null;
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;

        } else {
            // Rejected
            asset.status = 'Assigned';
            asset.pendingAction = null;
            asset.pendingActionDetails = null;
            asset.actionRequiredBy = null;

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user.employeeObjectId,
                comments: `Action "${actionType}" rejected/cancelled by authority. Reason: ${comment || 'N/A'}`,
                date: new Date(),
                details: { status: 'RejectedByAuthority', originalAction: actionType }
            });
        }

        await asset.save();
        res.status(200).json({
            message: approve ? `Request approved. Asset marked as Out of Service.` : `${actionType} request rejected`,
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

        // Verify that the user is the one assigned
        if (asset.actionRequiredBy && asset.actionRequiredBy.toString() !== req.user._id.toString()) {
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
        });

        if (!asset) return res.status(404).json({ message: 'Asset not found' });
        if (!asset.assignedTo) return res.status(400).json({ message: 'Asset has no assigned user.' });

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) return res.status(404).json({ message: 'Accessory not found' });
        if (accessory.pendingAction) {
            return res.status(400).json({ message: `This accessory already has a pending "${accessory.pendingAction}" request.` });
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
            requestedAt: new Date()
        };

        // Determine who gets the request
        const requesterId = (req.user.employeeObjectId || req.user._id).toString();
        const managerId = asset.assignedTo.primaryReportee?._id?.toString();
        const isManagerRequester = requesterId === managerId;

        if (isManagerRequester && ['End of Life'].includes(actionType)) {
            // Manager reported EOL -> goes to Employee for acknowledgment
            asset.actionRequiredBy = asset.assignedTo._id;
        } else {
            // Others (including L&D from non-manager) -> goes to Manager for approval
            asset.actionRequiredBy = asset.assignedTo.primaryReportee?._id;
        }

        asset.markModified('accessories');
        await asset.save();

        // Log history
        await AssetHistory.create({
            assetId: asset._id,
            action: 'Comment',
            performedBy: req.user.employeeObjectId || req.user._id,
            comments: `Accessory "${accessory.name}" (${accessory.accessoryId}): "${actionType}" requested. Reason: ${reason || 'N/A'}`,
            date: new Date(),
            details: { type: 'AccessoryActionRequest', action: actionType, accessoryId: accessory.accessoryId }
        });

        // Send email notification to the reportee/manager using the existing email utility
        try {
            const reporter = asset.assignedTo.primaryReportee;
            if (reporter) {
                // Look up requester name from EmployeeBasic since req.user doesn't carry firstName/lastName
                const requesterEmp = req.user.employeeObjectId
                    ? await EmployeeBasic.findById(req.user.employeeObjectId).select('firstName lastName').lean()
                    : null;
                const requesterName = requesterEmp
                    ? `${requesterEmp.firstName} ${requesterEmp.lastName}`
                    : req.user.email || 'Employee';

                // Reuse the existing approval email utility (it handles SMTP config internally)
                await sendAssetActionApprovalEmail(
                    { ...asset.toObject(), assetId: asset.assetId, name: `${asset.name} - Accessory: ${accessory.name} (${accessory.accessoryId})` },
                    actionType,
                    reporter,
                    { name: requesterName },
                    reason || 'No reason provided'
                );
            }
        } catch (emailErr) {
            console.error('[AccessoryAction] Email send failed (non-fatal):', emailErr);
        }

        res.status(200).json({
            message: `"${actionType}" request submitted for accessory "${accessory.name}". Pending reportee approval.`,
            asset
        });
    } catch (error) {
        console.error('Error requesting accessory action:', error);
        res.status(500).json({ message: 'Internal server error' });
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
        });
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const accessory = asset.accessories.find(a => a._id.toString() === accId || a.accessoryId === accId);
        if (!accessory) return res.status(404).json({ message: 'Accessory not found' });
        if (!accessory.pendingAction) return res.status(400).json({ message: 'No pending action on this accessory' });

        const { pendingAction, pendingActionDetails } = accessory;

        if (approve) {
            // If the responder is a manager or authority, finalize the action for accessories immediately
            const requesterId = (req.user.employeeObjectId || req.user._id).toString();
            const managerId = asset.assignedTo.primaryReportee?._id?.toString() || asset.assignedTo.primaryReportee?.toString();
            const isManager = requesterId === managerId;

            if (isManager) {
                // Execute the action (Transfer / L&D / EOL) immediately
                if (pendingAction === 'Transfer') {
                    const targetAssetId = pendingActionDetails?.targetAssetId;
                    if (!targetAssetId) return res.status(400).json({ message: 'Transfer target asset not set' });

                    const targetAsset = await AssetItem.findById(targetAssetId);
                    if (!targetAsset) return res.status(404).json({ message: 'Target asset not found' });

                    const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                    const accToMove = asset.accessories[accIndex].toObject();

                    asset.accessories.splice(accIndex, 1);
                    const { pendingAction: _pa, pendingActionDetails: _pad, _id: _oldId, ...cleanAcc } = accToMove;
                    targetAsset.accessories.push({ ...cleanAcc, status: 'Attached', pendingAction: null, _id: new mongoose.Types.ObjectId() });

                    await targetAsset.save();

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `Accessory "${accToMove.name}" transfer finalized by manager to ${targetAsset.assetId}. ${comment || ''}`,
                        file: fileUrl,
                        date: new Date()
                    });
                } else if (pendingAction === 'Loss and Damage') {
                    accessory.status = 'Damaged';
                    accessory.pendingAction = null;

                    // Create fine now
                    if (pendingActionDetails?.fineData) {
                        try {
                            const Fine = (await import('../models/Fine.js')).default;
                            const { generateFineIdInternal } = await import('./fine/addFine.js');
                            const uniqueFineId = await generateFineIdInternal();
                            const fd = pendingActionDetails.fineData;

                            const { employees, ...cleanFd } = fd;
                            const fineModel = new Fine({
                                ...cleanFd,
                                assignedEmployees: employees || fd.assignedEmployees || [],
                                company: asset.assignedTo?.company?._id || fd.company,
                                companyName: asset.assignedTo?.company?.name || fd.companyName || '',
                                fineId: uniqueFineId,
                                fineStatus: 'Draft',
                                createdBy: req.user._id, // Must be User ID for ref
                                awardedDate: new Date(),
                                assetObjectId: asset._id,
                                attachment: fileUrl ? { url: fileUrl, name: 'L&D Manager Photo.pdf', mimeType: 'application/pdf' } : (pendingActionDetails.attachment ? { url: pendingActionDetails.attachment, name: 'L&D Reporter Photo.pdf', mimeType: 'application/pdf' } : fd.attachment)
                            });
                            await fineModel.save();
                        } catch (err) { console.error('Fine Generation Error:', err); }
                    }

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `Accessory "${accessory.name}" Loss & Damage finalized by manager. ${comment || ''}`,
                        file: fileUrl,
                        date: new Date()
                    });
                } else if (pendingAction === 'End of Life') {
                    const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                    const { name: accName, accessoryId: accCode } = asset.accessories[accIndex];
                    asset.accessories.splice(accIndex, 1);

                    await AssetHistory.create({
                        assetId: asset._id,
                        action: 'Comment',
                        performedBy: req.user.employeeObjectId || req.user._id,
                        comments: `Accessory "${accName}" (${accCode}) End of Life finalized by manager. ${comment || ''}`,
                        file: fileUrl,
                        date: new Date()
                    });
                }

                asset.actionRequiredBy = null;
                asset.markModified('accessories');
                await asset.save();

                return res.status(200).json({ message: "Action approved and finalized by manager.", asset });
            }

            // DEFAULT: If it's not the manager responding (maybe the employee acknowledging a manager's request)
            const employeeId = asset.assignedTo._id.toString();

            if (requesterId !== employeeId) {
                // ... Authority check (HR) ...
                if (pendingAction === 'Loss and Damage') {
                    const hrHod = await getDepartmentHOD('hr', asset.assignedTo._id);
                    const isHR = hrHod && hrHod._id.toString() === req.user._id.toString();

                    if (!isHR) {
                        // Manager approved, route to HR
                        asset.actionRequiredBy = hrHod?._id || null;
                        if (!asset.actionRequiredBy) return res.status(400).json({ message: 'HR HOD not found. Approval stalled.' });

                        await AssetHistory.create({
                            assetId: asset._id,
                            action: 'Comment',
                            performedBy: req.user._id,
                            comments: `Manager approved "${pendingAction}" for accessory "${accessory.name}". Pending HR Review.`,
                            date: new Date(),
                            details: { type: 'AccessoryApprovedByManager', accessoryId: accessory.accessoryId }
                        });

                        await asset.save();
                        return res.status(200).json({ message: "Approved by manager. Sent to HR HOD for review.", asset });
                    }

                    // HR approved (Authority) -> Create fine
                    if (pendingActionDetails?.fineData) {
                        try {
                            const Fine = (await import('../models/Fine.js')).default;
                            const { generateFineIdInternal } = await import('./fine/addFine.js');
                            const uniqueFineId = await generateFineIdInternal();
                            const fd = pendingActionDetails.fineData;

                            const { employees, ...cleanFd } = fd;
                            const fineModel = new Fine({
                                ...cleanFd,
                                assignedEmployees: employees || fd.assignedEmployees || [],
                                company: asset.assignedTo?.company?._id || fd.company,
                                companyName: asset.assignedTo?.company?.name || fd.companyName || '',
                                fineId: uniqueFineId,
                                fineStatus: 'Draft',
                                createdBy: req.user._id, // Must be User ID for ref
                                awardedDate: new Date(),
                                assetObjectId: asset._id,
                                attachment: pendingActionDetails.attachment ? { url: pendingActionDetails.attachment, name: 'L&D Photo.pdf', mimeType: 'application/pdf' } : fd.attachment
                            });
                            await fineModel.save();
                        } catch (err) { console.error('Authority Fine Error:', err); }
                    }
                }

                // Now send to Employee for acknowledgment
                asset.actionRequiredBy = asset.assignedTo._id;

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Authority approved "${pendingAction}" for accessory "${accessory.name}". Pending reportee acknowledgment.`,
                    date: new Date(),
                    details: { type: 'AccessoryActionAuthorityApproved', accessoryId: accessory.accessoryId }
                });

                await asset.save();
                return res.status(200).json({ message: "Action approved by authority. Sent to reportee for acknowledgment.", asset });
            }

            // IF it reaches here, it means the responder IS the employee (Final step)
            if (pendingAction === 'Transfer') {
                const targetAssetId = pendingActionDetails?.targetAssetId;
                if (!targetAssetId) return res.status(400).json({ message: 'Transfer target asset not set' });

                const targetAsset = await AssetItem.findById(targetAssetId);
                if (!targetAsset) return res.status(404).json({ message: 'Target asset not found' });

                const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                const accToMove = asset.accessories[accIndex].toObject();

                asset.accessories.splice(accIndex, 1);
                const { pendingAction: _pa, pendingActionDetails: _pad, _id: _oldId, ...cleanAcc } = accToMove;
                targetAsset.accessories.push({ ...cleanAcc, status: 'Attached', pendingAction: null, _id: new mongoose.Types.ObjectId() });

                await asset.save();
                await targetAsset.save();

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Accessory "${accToMove.name}" transfered to ${targetAsset.assetId}. ${comment || ''}`,
                    date: new Date()
                });
            } else if (pendingAction === 'Loss and Damage') {
                accessory.status = 'Damaged';
                accessory.pendingAction = null;
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Accessory "${accessory.name}" Loss & Damage finalized by reportee. ${comment || ''}`,
                    date: new Date()
                });
            } else if (pendingAction === 'End of Life') {
                const accIndex = asset.accessories.findIndex(a => a._id.toString() === accId || a.accessoryId === accId);
                const { name: accName, accessoryId: accCode } = asset.accessories[accIndex];
                asset.accessories.splice(accIndex, 1);
                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Comment',
                    performedBy: req.user._id,
                    comments: `Accessory "${accName}" (${accCode}) End of Life finalized by reportee. ${comment || ''}`,
                    date: new Date()
                });
            }

            asset.actionRequiredBy = null;
            asset.markModified('accessories');
            await asset.save();

        } else {
            // Reject
            accessory.pendingAction = null;
            accessory.pendingActionDetails = null;
            asset.actionRequiredBy = null;
            await asset.save();

            await AssetHistory.create({
                assetId: asset._id,
                action: 'Comment',
                performedBy: req.user._id,
                comments: `Accessory "${accessory.name}" ${pendingAction} request rejected. ${comment || ''}`,
                date: new Date()
            });
        }

        res.status(200).json({
            message: approve ? `Accessory action processed.` : `Accessory action rejected.`,
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


import AssetType from '../models/AssetType.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { isUserAdministrator } from '../services/permissionService.js';
import mongoose from 'mongoose';
import { uploadDocumentToS3, getSignedFileUrl } from '../utils/s3Upload.js';
import { sendAssetCreationApprovalEmail } from '../utils/sendAssetCreationApprovalEmail.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { resolveAssetControllerEmployee, getAssetRequesterDisplayName } from '../utils/assetApprovalHelpers.js';

// @desc    Create a new asset type
// @route   POST /api/AssetType
// @access  Private

// Helper to generate next Asset ID (Generic)
const generateGenericId = async (model, prefix, fieldName) => {
    try {
        const regex = new RegExp(`^${prefix}\\d+$`);
        const item = await model.findOne({
            [fieldName]: { $regex: regex }
        }).sort({ [fieldName]: -1 });

        if (!item || !item[fieldName]) return `${prefix}001`;

        const idStr = item[fieldName];
        const numberStr = idStr.substring(prefix.length);
        const numericPart = parseInt(numberStr, 10);
        const nextNum = isNaN(numericPart) ? 1 : numericPart + 1;
        return `${prefix}${String(nextNum).padStart(3, '0')}`;
    } catch (error) {
        console.error(`Error generating ID for ${fieldName}:`, error);
        return `${prefix}001`;
    }
};

const UAE_PLATE_REGEX = /^([A-Z]{1,3})?\s?(\d{1,6})$/;

const normalizePlate = (val) => {
    if (!val) return val;
    const trimmed = val.trim().toUpperCase();
    const match = trimmed.match(UAE_PLATE_REGEX);
    if (!match) return trimmed;
    const letters = match[1];
    const numbers = match[2];
    return letters ? `${letters} ${numbers}` : numbers;
};

// Helper to generate accessory suffix (A, B, C...)
const generateAccessoryId = (assetId, index) => {
    const charCode = 65 + (index % 26);
    const suffix = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
    return `${assetId}${String.fromCharCode(charCode)}${suffix}`;
};

export const createAssetType = async (req, res) => {
    try {
        console.log('DEBUG: createAssetType body:', req.body);
        let {
            mode, category, type, name, assetValue, purchaseDate, quantity, warranty, warrantyYears, warrantyAttachment, invoiceNumber, imagePreview, description, invoiceFile, accessories,
            vehicleCode, plateNumber, modelYear, currentKilometer, registrationExpiryDate,
            insuranceExpiryDate, oilChangeDate, gearOilDueDate, lastServiceDate, nextServiceDate
        } = req.body;

        // UAE Plate Validation if provided (usually for vehicles)
        if (plateNumber) {
            if (!UAE_PLATE_REGEX.test(plateNumber.trim().toUpperCase())) {
                return res.status(400).json({ message: 'Enter a valid UAE vehicle plate number' });
            }
            plateNumber = normalizePlate(plateNumber);
        }

        if (mode === 'category') {
            if (!category) return res.status(400).json({ message: 'Category name is required' });
            if (!type) return res.status(400).json({ message: 'Parent Type is required for categories' });

            const parentType = await AssetType.findOne({ name: type });
            if (!parentType) return res.status(404).json({ message: 'Selected Type not found' });

            // Handle Image Upload
            let imageS3Key = imagePreview;
            if (imagePreview && imagePreview.startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(imagePreview, 'asset-photos');
                    imageS3Key = uploadResult.publicId;
                } catch (error) {
                    console.error('Error uploading category image to S3:', error);
                }
            }

            const categoryId = await generateGenericId(AssetCategory, 'asset-cat-', 'categoryId');
            const newCategory = await AssetCategory.create({
                categoryId,
                name: category,
                typeId: parentType._id,
                imagePreview: imageS3Key
            });
            return res.status(201).json(newCategory);

        } else if (mode === 'type') {
            if (!type) return res.status(400).json({ message: 'Type name is required' });

            // Handle Image Upload
            let imageS3Key = imagePreview;
            if (imagePreview && imagePreview.startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(imagePreview, 'asset-photos');
                    imageS3Key = uploadResult.publicId;
                } catch (error) {
                    console.error('Error uploading type image to S3:', error);
                }
            }

            const typeId = await generateGenericId(AssetType, 'asset-type-', 'typeId');
            const newType = await AssetType.create({
                typeId,
                name: type,
                imagePreview: imageS3Key,
                description
            });

            return res.status(201).json(newType);

        } else {
            // Asset Mode
            if (!type || !name) {
                return res.status(400).json({ message: 'Name and Type are required' });
            }

            // Find type or auto-create if missing
            let t = await AssetType.findOne({ name: type });
            if (!t) {
                // Auto-create type if not found (e.g. for Car/Van/Pickup)
                const typeId = await generateGenericId(AssetType, 'asset-type-', 'typeId');
                t = await AssetType.create({
                    typeId,
                    name: type,
                    description: `Auto-created type: ${type}`
                });
            }

            // Find category provided in request
            let catId = null;
            if (category) {
                const cat = await AssetCategory.findOne({ name: category });
                if (cat) catId = cat._id;
            }

            if (!catId) {
                return res.status(400).json({ message: 'Valid Category is required for individual assets.' });
            }

            // Approval Logic: Check if creator is Asset Controller or Admin
            const assetController = await getDepartmentHOD('assetcontroller', req.user.employeeObjectId);

            if (!assetController) {
                return res.status(403).json({
                    message: "Asset creation denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
                });
            }

            const isJwtAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
            const isSysAdmin = await isUserAdministrator(req.user?.id);
            const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

            let initialStatus = 'Draft';
            let actionRequiredBy = null;

            if (isJwtAdmin || isSysAdmin || isAssetController) {
                initialStatus = 'Unassigned';
                console.log(`[Asset creation (Bulk/Type)] Created directly as Unassigned by ${isJwtAdmin || isSysAdmin ? 'Admin' : 'Asset Controller'}`);
            } else if (assetController) {
                // Regular creator: keep editable Draft until they explicitly submit for approval
                actionRequiredBy = null;
                console.log(`[Asset creation (Bulk/Type)] Created as editable Draft by regular user ${req.user.employeeId}. Awaiting submit request.`);
            } else {
                // No asset controller defined & user is not admin
                return res.status(403).json({
                    message: "Asset creation denied: No Asset Controller has been assigned in the organization flow. Please assign an Asset Controller in Settings > Flowchart before performing this operation."
                });
            }

            const qty = Math.max(1, Number(quantity) || 1);
            const createdAssets = [];

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

            // Handle Image Upload
            let imageS3Key = imagePreview;
            if (imagePreview && imagePreview.startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(imagePreview, 'asset-photos');
                    imageS3Key = uploadResult.publicId;
                } catch (error) {
                    console.error('Error uploading asset image to S3:', error);
                }
            }

            for (let i = 0; i < qty; i++) {
                const currentAssetId = `${prefix}${String(startingNum + i).padStart(3, '0')}`;

                // Format accessories unique to this assetId
                const formattedAccessories = (accessories || []).map((acc, accIdx) => ({
                    ...acc,
                    accessoryId: generateAccessoryId(currentAssetId, accIdx)
                }));

                const assetData = {
                    assetId: currentAssetId,
                    typeId: t._id,
                    categoryId: catId,
                    name,
                    assetValue: Number(assetValue),
                    purchaseDate: purchaseDate || null,
                    quantity: 1, // Individual records always have quantity 1
                    warranty,
                    warrantyYears: Number(warrantyYears) || 0,
                    warrantyAttachment,
                    invoiceNumber,
                    imagePreview: imageS3Key,
                    photo: imageS3Key,
                    invoiceFile,
                    accessories: formattedAccessories,
                    status: initialStatus,
                    actionRequiredBy: actionRequiredBy,
                    createdBy: req.user._id,
                    vehicleCode,
                    plateNumber,
                    modelYear,
                    currentKilometer,
                    registrationExpiryDate,
                    insuranceExpiryDate,
                    oilChangeDate,
                    gearOilDueDate,
                    lastServiceDate,
                    nextServiceDate
                };

                const newAsset = await AssetItem.create(assetData);
                createdAssets.push(newAsset.toObject());

                // Create asset creation history entry
                await AssetHistory.create({
                    assetId: newAsset._id,
                    action: 'Created',
                    performedBy: req.user.employeeObjectId,
                    details: {
                        purchaseDate: purchaseDate || null,
                        invoiceNumber: invoiceNumber || null,
                        invoiceFile: invoiceFile || null,
                        invoiceStatus: invoiceFile ? 'Received' : 'Pending',
                        assetName: name,
                        assetValue: Number(assetValue),
                        createdBy: req.user.name || 'System User',
                        creationStatus: initialStatus
                    },
                    date: new Date()
                });
            }

            // Do not notify on create for regular users.
            // They must explicitly submit the draft for approval.

            // Prepare first asset for response
            const assetObj = createdAssets[0];
            if (assetObj.imagePreview) assetObj.imagePreview = await getSignedFileUrl(assetObj.imagePreview);
            if (assetObj.invoiceFile) assetObj.invoiceFile = await getSignedFileUrl(assetObj.invoiceFile);
            if (assetObj.warrantyAttachment) assetObj.warrantyAttachment = await getSignedFileUrl(assetObj.warrantyAttachment);

            if (assetObj.accessories && Array.isArray(assetObj.accessories)) {
                assetObj.accessories = await Promise.all(assetObj.accessories.map(async (acc) => ({
                    ...acc,
                    attachment: acc.attachment ? await getSignedFileUrl(acc.attachment) : null
                })));
            }

            return res.status(201).json(assetObj);
        }

    } catch (error) {
        console.error('CRITICAL: createAssetType Failed:', error);
        res.status(500).json({
            message: `Server Error: ${error.message}`,
            error: error.message
        });
    }
};

// @desc    Get all asset types
// @route   GET /api/AssetType
// @access  Private
export const getAssetTypes = async (req, res) => {
    try {
        // Fix: Drop the index causing 500 errors if it was created accidentally
        try { await AssetType.collection.dropIndex('assetId_1'); } catch (e) { /* ignore */ }

        // We aggregate all 3 collections into a unified list for the frontend
        const categories = await AssetCategory.find({ isActive: true }).populate('typeId');
        const types = await AssetType.find({ isActive: true });

        // Visibility: Admin sees all; Asset Controller sees all (Flowchart, same as approve-creation); others only their own
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        const assetQuery = {};
        if (!isAdmin && !isAssetController && req.user?.id) {
            assetQuery.createdBy = new mongoose.Types.ObjectId(req.user.id);
        }

        const assets = await AssetItem.find(assetQuery)
            .populate('typeId')
            .populate('categoryId')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department primaryReportee reportingAuthority',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName' },
                    { path: 'reportingAuthority', select: 'firstName lastName' }
                ]
            });

        const flowAc = await getDepartmentHOD('assetcontroller');
        let designatedAssetController = null;
        if (flowAc) {
            const fn = flowAc.firstName ?? flowAc.employeeName?.split(/\s+/)[0];
            const ln = flowAc.lastName ?? flowAc.employeeName?.split(/\s+/).slice(1).join(' ');
            if (fn || ln || flowAc.employeeId) {
                designatedAssetController = {
                    firstName: fn || 'Unknown',
                    lastName: ln || '',
                    employeeId: flowAc.employeeId
                };
            }
        }

        // Aggregate category counts per type
        const typeCategoryCounts = {};
        categories.forEach(c => {
            if (c.typeId) {
                const typeIdStr = c.typeId._id.toString();
                typeCategoryCounts[typeIdStr] = (typeCategoryCounts[typeIdStr] || 0) + 1;
            }
        });

        // Transform into the flat structure the frontend expects
        const unifiedList = [
            ...await Promise.all(categories.map(async (c) => ({
                _id: c._id,
                assetId: c.categoryId,
                category: c.name,
                imagePreview: await getSignedFileUrl(c.imagePreview),
                type: c.typeId?.name || null
            }))),
            ...await Promise.all(types.map(async (t) => ({
                _id: t._id,
                assetId: t.typeId,
                type: t.name,
                category: null,
                categoryCount: typeCategoryCounts[t._id.toString()] || 0,
                imagePreview: await getSignedFileUrl(t.imagePreview),
                description: t.description
            }))),
            ...await Promise.all(assets.map(async (a) => ({
                _id: a._id,
                assetId: a.assetId,
                name: a.name,
                type: a.typeId?.name || '-',
                category: a.categoryId?.name || '-',
                assetValue: a.assetValue,
                purchaseDate: a.purchaseDate,
                quantity: a.quantity || 1,
                warranty: a.warranty,
                warrantyYears: a.warrantyYears,
                warrantyAttachment: await getSignedFileUrl(a.warrantyAttachment),
                invoiceNumber: a.invoiceNumber,
                imagePreview: await getSignedFileUrl(a.imagePreview),
                photo: await getSignedFileUrl(a.photo),
                status: a.status,
                assigned: a.status === 'Assigned' ? 1 : 0,
                unassigned: a.status === 'Unassigned' ? 1 : 0,
                invoiceFile: await getSignedFileUrl(a.invoiceFile),
                actionRequiredBy: a.actionRequiredBy,
                designatedAssetController,
                pendingAction: a.pendingAction,
                accessories: await Promise.all((a.accessories || []).map(async (acc) => {
                    const accObj = acc.toObject ? acc.toObject() : acc;
                    return {
                        ...accObj,
                        attachment: accObj.attachment ? await getSignedFileUrl(accObj.attachment) : null
                    };
                })),
                assignedTo: a.assignedTo,
                vehicleCode: a.vehicleCode,
                plateNumber: a.plateNumber,
                modelYear: a.modelYear,
                currentKilometer: a.currentKilometer,
                registrationExpiryDate: a.registrationExpiryDate,
                insuranceExpiryDate: a.insuranceExpiryDate,
                oilChangeDate: a.oilChangeDate,
                gearOilDueDate: a.gearOilDueDate,
                lastServiceDate: a.lastServiceDate,
                nextServiceDate: a.nextServiceDate
            })))
        ];

        res.status(200).json(unifiedList);
    } catch (error) {
        console.error('Error fetching asset entities:', error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// @desc    Get single asset type
// @route   GET /api/AssetType/:id
// @access  Private
export const getAssetTypeById = async (req, res) => {
    try {
        const assetType = await AssetType.findById(req.params.id);
        if (!assetType) {
            return res.status(404).json({ message: 'Asset Type not found' });
        }
        res.status(200).json(assetType);
    } catch (error) {
        console.error('Error fetching asset type:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete asset type (soft delete)
// @route   DELETE /api/AssetType/:id
// @access  Private
export const deleteAssetType = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format for deletion.' });
        }

        // Try Category first
        let item = await AssetCategory.findById(id);
        if (item) {
            item.isActive = false;
            await item.save();
            return res.status(200).json({ message: 'Category deleted successfully' });
        }

        // Try AssetType
        item = await AssetType.findById(id);
        if (item) {
            item.isActive = false;
            await item.save();
            return res.status(200).json({ message: 'Type deleted successfully' });
        }

        // Try AssetItem
        item = await AssetItem.findById(id);
        if (item) {
            const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
            const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
            const currentUserId = req.user?._id?.toString() || req.user?.id?.toString();
            const isCreator = item.createdBy?.toString() === currentUserId;
            const isEditableDraft = item.status === 'Draft' && !item.actionRequiredBy;

            if (!isAdmin) {
                // Creator can delete only before submission
                if (!(isCreator && isEditableDraft)) {
                    // Explicit business rule: controller cannot delete after approval
                    if (isAssetController && item.status === 'Unassigned') {
                        return res.status(403).json({ message: 'Approved assets cannot be deleted by Asset Controller.' });
                    }
                    return res.status(403).json({ message: 'Only creator can delete editable drafts before submission. Admin can delete all.' });
                }
            }

            await AssetItem.findByIdAndDelete(id);
            return res.status(200).json({ message: 'Asset deleted' });
        }

        res.status(404).json({ message: 'Item not found' });
    } catch (error) {
        console.error('Error deleting asset entity:', error);
        res.status(500).json({ message: 'Server Error', error: error.message, stack: error.stack });
    }
};

// @desc    Upload Invoice
// @route   POST /api/AssetType/upload
// @access  Private
export const uploadInvoice = async (req, res) => {
    try {
        const { file, fileName } = req.body; // Expecting base64 string
        if (!file) return res.status(400).json({ message: 'No file uploaded' });

        // 'asset-invoices' is the folder name in S3
        const result = await uploadDocumentToS3(file, 'asset-invoices', fileName);
        res.status(200).json({ url: result.url, publicId: result.publicId });
    } catch (error) {
        console.error('Invoice Upload Error:', error);
        res.status(500).json({ message: 'Upload failed', error: error.message });
    }
};

// @desc    Update Asset Item (General)
// @route   PUT /api/AssetType/:id
// @access  Private
export const updateAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const isAdmin = req.user.isAdmin || req.user.role === 'Admin' || req.user.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        let asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Permission logic:
        // - Creator can edit only while editable Draft (before submission)
        // - Asset Controller/Admin rules are kept as-is
        // - Assigned employee can edit their assigned asset (not only accessories)
        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = asset.createdBy?.toString() === currentUserId;
        const isEditableDraft = asset.status === 'Draft' && !asset.actionRequiredBy;
        const isSubmittedOrPending = asset.status === 'Pending' || (asset.status === 'Draft' && !!asset.actionRequiredBy);
        const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        let currentEmpObjectId = req.user.employeeObjectId?.toString?.() || null;
        if (!currentEmpObjectId && req.user.employeeId) {
            const userNorm = norm(req.user.employeeId);
            if (userNorm) {
                const empRow = await EmployeeBasic.findOne({
                    $expr: {
                        $eq: [
                            {
                                $replaceAll: {
                                    input: { $toLower: { $ifNull: ['$employeeId', ''] } },
                                    find: ' ',
                                    replacement: ''
                                }
                            },
                            userNorm
                        ]
                    }
                }).select('_id').lean();
                if (empRow?._id) currentEmpObjectId = empRow._id.toString();
            }
        }

        const isAssignedUser =
            !!asset.assignedTo &&
            !!currentEmpObjectId &&
            asset.assignedTo.toString() === currentEmpObjectId;

        // Full permission for assigner (assignedBy)
        const isAssigner =
            !!asset.assignedBy &&
            !!currentEmpObjectId &&
            asset.assignedBy.toString() === currentEmpObjectId;

        // If assignee has NO companyEmail, allow primaryReportee delegate to edit too
        let isPrimaryReporteeDelegate = false;
        if (asset.assignedToType === 'Employee' && asset.assignedTo && currentEmpObjectId) {
            const assigneeDoc = await EmployeeBasic.findById(asset.assignedTo)
                .select('companyEmail primaryReportee employeeId')
                .lean()
                .catch(() => null);

            const hasCompanyEmail = !!(assigneeDoc?.companyEmail && String(assigneeDoc.companyEmail).trim().length > 0);
            let hasPortalAccess = null;
            if (assigneeDoc?.employeeId) {
                const linkedUser = await User.findOne({ employeeId: assigneeDoc.employeeId, status: 'Active' })
                    .select('enablePortalAccess')
                    .lean()
                    .catch(() => null);
                hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
            }
            const primaryId = assigneeDoc?.primaryReportee?._id
                ? assigneeDoc.primaryReportee._id.toString()
                : assigneeDoc?.primaryReportee?.toString?.() || assigneeDoc?.primaryReportee || null;

            isPrimaryReporteeDelegate = !!(
                primaryId &&
                primaryId.toString() === currentEmpObjectId &&
                (!hasCompanyEmail || hasPortalAccess === false)
            );
        }

        const isAssignedEditAllowed = isAssignedUser || isAssigner || isPrimaryReporteeDelegate; // assigned employee/assigner/delegated reportee can edit

        // Controller can only edit after accepting (i.e., once Unassigned/approved)
        if (!isAdmin && isAssetController && isSubmittedOrPending && !isAssignedEditAllowed) {
            return res.status(403).json({ message: 'Asset is pending approval. Asset Controller can edit only after accepting it.' });
        }

        if (!isAdmin && !isAssetController) {
            if (!(isCreator && isEditableDraft) && !isAssignedEditAllowed) {
                return res.status(403).json({ message: "Creator can edit only before submission. After submission, only controller/admin after approval can edit." });
            }
        }

        // Apply updates
        for (const key of Object.keys(updates)) {
            // Prevent updating immutable fields
            if (key !== '_id' && key !== 'assetId') {
                if (key === 'accessories' && Array.isArray(updates[key])) {
                    const isAssigned = asset.status === 'Assigned' && asset.assignedTo;
                    const actorId = req.user.employeeObjectId?.toString() || req.user._id?.toString();
                    // "Owner-like" actors for assigned assets:
                    // - assignee
                    // - assigner (asset.assignedBy)
                    // - primaryReportee delegate when assignee has no companyEmail
                    const isOwner = isAssigned && (
                        asset.assignedTo.toString() === actorId ||
                        isAssigner ||
                        isPrimaryReporteeDelegate
                    );
                    const oldAccessories = asset.accessories || [];
                    const newAccessoriesList = [];
                    let hasNewPending = false;
                    let hasEditsByOthers = false;

                    for (let i = 0; i < updates[key].length; i++) {
                        const acc = updates[key][i];
                        const existing = oldAccessories.find(oa =>
                            (oa._id && acc._id && oa._id.toString() === acc._id.toString()) ||
                            (oa.accessoryId && acc.accessoryId && oa.accessoryId === acc.accessoryId)
                        );

                        if (existing) {
                            // Detect edits by others
                            if (isAssigned && !isOwner) {
                                const hasChanged = (acc.name && existing.name !== acc.name) ||
                                    (acc.amount !== undefined && existing.amount !== acc.amount);
                                if (hasChanged) hasEditsByOthers = true;
                            }
                            // Keep existing accessory
                            newAccessoriesList.push({
                                ...existing.toObject(),
                                ...acc,
                                accessoryId: generateAccessoryId(asset.assetId, i)
                            });
                        } else {
                            // NEW Accessory
                            const newAcc = {
                                ...acc,
                                accessoryId: generateAccessoryId(asset.assetId, i)
                            };

                            if (isAssigned && !isOwner) {
                                // Approval needed when Asset Controller/Admin adds to assigned asset
                                newAcc.status = 'Pending';
                                newAcc.pendingAction = 'Add';
                                newAcc.pendingActionDetails = {
                                    requestedBy: req.user.employeeObjectId || req.user._id,
                                    requestedAt: new Date()
                                };
                                hasNewPending = true;
                            } else {
                                // Directly attach: unassigned asset, or assigned user adding to their own asset
                                newAcc.status = 'Attached';
                            }
                            newAccessoriesList.push(newAcc);
                        }
                    }
                    asset.accessories = newAccessoriesList;

                    // If new accessories were added to an assigned asset, create notification
                    if (hasNewPending && isAssigned) {
                        try {
                            const isUnassignedStage = String(asset?.acceptanceStatus || '').toLowerCase() !== 'accepted';
                            const employee = await EmployeeBasic.findById(asset.assignedTo);
                            if (isUnassignedStage) {
                                // Unassigned/pending-acceptance stage: notify ONLY Asset Controller
                                const controller = await getDepartmentHOD('assetcontroller');
                                if (controller) {
                                    const requesterName = req.user.name || 'System';
                                    asset.actionRequiredBy = controller._id;

                                    await DashboardAction.create({
                                        assignedTo: controller._id,
                                        assignedToEmpId: controller.employeeId,
                                        requestId: asset._id,
                                        requestType: 'Asset Accessory Approval',
                                        status: 'Pending',
                                        subjectEmployeeId: controller.employeeId,
                                        subjectName: `${controller.firstName || ''} ${controller.lastName || ''}`.trim() || 'Asset Controller',
                                        requestedByName: requesterName,
                                        extra1: `${asset.assetId} — Accessory: Adding New`,
                                        extra2: 'Add'
                                    });

                                    await sendAssetActionApprovalEmail(
                                        { ...asset.toObject(), assetId: asset.assetId },
                                        'Add Accessory',
                                        controller,
                                        { name: requesterName },
                                        'New accessories are being added. Please review and approve.'
                                    );
                                }
                            } else if (employee) {
                                const requesterName = req.user.name || 'System';
                                asset.actionRequiredBy = employee._id;

                                // Create Dashboard Action
                                await DashboardAction.create({
                                    assignedTo: employee._id,
                                    assignedToEmpId: employee.employeeId,
                                    requestId: asset._id,
                                    requestType: 'Asset Accessory Approval',
                                    status: 'Pending',
                                    subjectEmployeeId: employee.employeeId,
                                    subjectName: `${employee.firstName} ${employee.lastName}`,
                                    requestedByName: requesterName,
                                    extra1: `${asset.assetId} — Accessory: Adding New`,
                                    extra2: 'Add'
                                });

                                // Send Email
                                let emailRecipient = employee;
                                const linkedUser = await User.findOne({ employeeId: employee.employeeId, status: 'Active' });
                                // Access is based on ERP portal access, not companyEmail
                                const hasAccess = !!(linkedUser && linkedUser.enablePortalAccess);

                                if (!hasAccess && employee.primaryReportee) {
                                    const managerId = employee.primaryReportee._id || employee.primaryReportee;
                                    const manager = await EmployeeBasic.findById(managerId);
                                    if (manager) {
                                        emailRecipient = manager;
                                        asset.actionRequiredBy = manager._id;
                                        // Update Dashboard assignedTo too
                                        await DashboardAction.findOneAndUpdate(
                                            { requestId: asset._id, requestType: 'Asset Accessory Approval', status: 'Pending' },
                                            { assignedTo: manager._id, assignedToEmpId: manager.employeeId }
                                        );
                                    }
                                }

                                await sendAssetActionApprovalEmail(
                                    { ...asset.toObject(), assetId: asset.assetId },
                                    'Add Accessory',
                                    emailRecipient,
                                    { name: requesterName },
                                    'New accessories are being added to your assigned asset. Please review and approve.'
                                );
                            }
                        } catch (err) {
                            console.error('[AddAccessory Notification] Error:', err);
                        }
                    } else if (hasEditsByOthers && isAssigned && !isOwner) {
                        // Notify if edited by someone else but no NEW ones (which would require approval anyway)
                        try {
                            const isUnassignedStage = String(asset?.acceptanceStatus || '').toLowerCase() !== 'accepted';
                            const employee = await EmployeeBasic.findById(asset.assignedTo);
                            if (isUnassignedStage) {
                                // Unassigned/pending-acceptance stage: notify ONLY Asset Controller
                                const controller = await getDepartmentHOD('assetcontroller');
                                if (controller) {
                                    const requesterName = req.user.name || 'System';
                                    await sendAssetActionApprovalEmail(
                                        { ...asset.toObject(), assetId: asset.assetId },
                                        'Update Accessory',
                                        controller,
                                        { name: requesterName },
                                        'Existing accessories have been updated. Please review the changes.'
                                    );
                                }
                            } else if (employee) {
                                const requesterName = req.user.name || 'System';
                                let emailRecipient = employee;
                                const linkedUser = await User.findOne({ employeeId: employee.employeeId, status: 'Active' });
                                // Access is based on ERP portal access, not companyEmail
                                const hasAccess = !!(linkedUser && linkedUser.enablePortalAccess);

                                if (!hasAccess && employee.primaryReportee) {
                                    const managerId = employee.primaryReportee._id || employee.primaryReportee;
                                    const manager = await EmployeeBasic.findById(managerId);
                                    if (manager) emailRecipient = manager;
                                }

                                await sendAssetActionApprovalEmail(
                                    { ...asset.toObject(), assetId: asset.assetId },
                                    'Update Accessory',
                                    emailRecipient,
                                    { name: requesterName },
                                    'Existing accessories on your assigned asset have been updated. Please review the changes.'
                                );
                            }
                        } catch (err) {
                            console.error('[UpdateAccessory Notification] Error:', err);
                        }
                    }
                } else if ((key === 'photo' || key === 'imagePreview') && updates[key] && updates[key].startsWith('data:image')) {
                    // Handle Image Upload to S3
                    try {
                        const uploadResult = await uploadDocumentToS3(updates[key], 'asset-photos');
                        asset[key] = uploadResult.publicId;
                    } catch (error) {
                        console.error(`Error uploading updated ${key} to S3:`, error);
                        asset[key] = updates[key];
                    }
                } else {
                    if (key === 'plateNumber' && updates[key]) {
                        if (!UAE_PLATE_REGEX.test(updates[key].trim().toUpperCase())) {
                            return res.status(400).json({ message: 'Enter a valid UAE vehicle plate number' });
                        }
                        asset[key] = normalizePlate(updates[key]);
                    } else {
                        asset[key] = updates[key];
                    }
                }
            }
        }

        await asset.save();

        // Log to history
        try {
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Update',
                performedBy: req.user.employeeObjectId || req.user._id,
                comments: 'Asset details updated via Edit modal.',
                details: asset.toObject()
            });
        } catch (historyErr) {
            console.error('History log failed during updateAssetItem:', historyErr);
        }

        // Convert to object and sign the invoice URL before returning
        const assetObj = asset.toObject();
        if (assetObj.invoiceFile) {
            assetObj.invoiceFile = await getSignedFileUrl(assetObj.invoiceFile);
        }
        if (assetObj.warrantyAttachment) {
            assetObj.warrantyAttachment = await getSignedFileUrl(assetObj.warrantyAttachment);
        }

        if (assetObj.accessories && Array.isArray(assetObj.accessories)) {
            assetObj.accessories = await Promise.all(assetObj.accessories.map(async (acc) => {
                return {
                    ...acc,
                    attachment: acc.attachment ? await getSignedFileUrl(acc.attachment) : null
                };
            }));
        }

        res.status(200).json(assetObj);

    } catch (error) {
        console.error('Update Asset Error:', error);
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

// @desc    Submit draft asset for approval
// @route   PUT /api/AssetType/:id/submit-approval
// @access  Private
export const submitAssetForApproval = async (req, res) => {
    try {
        const { id } = req.params;
        const asset = await AssetItem.findById(id);
        if (!asset) return res.status(404).json({ message: 'Asset not found' });

        const currentUserId = req.user?._id?.toString() || req.user?.id?.toString();
        const isCreator = asset.createdBy?.toString() === currentUserId;
        const isAdmin = req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        if (!isAdmin && !isCreator && !isAssetController) {
            return res.status(403).json({ message: 'Only creator, Asset Controller, or Admin can submit.' });
        }

        if (asset.status !== 'Draft') {
            return res.status(400).json({ message: 'Only Draft assets can be submitted.' });
        }
        if (asset.actionRequiredBy) {
            return res.status(400).json({ message: 'Asset is already submitted for approval.' });
        }

        const assetControllerRaw = await getDepartmentHOD('assetcontroller');
        const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;
        if (!assetController?._id && !isAdmin) {
            return res.status(403).json({
                message: 'No Asset Controller assigned in Flowchart, or controller is not linked to an employee record.'
            });
        }

        const requesterDisplayName = await getAssetRequesterDisplayName(req);

        if (isAdmin || isAssetController) {
            asset.status = 'Unassigned';
            asset.actionRequiredBy = null;
        } else {
            asset.status = 'Pending';
            asset.actionRequiredBy = assetController._id;
        }
        await asset.save();

        if (asset.status === 'Pending' && assetController?._id) {
            try {
                await DashboardAction.findOneAndUpdate(
                    { requestId: asset._id, requestType: 'Asset Approval', status: 'Pending' },
                    {
                        assignedTo: assetController._id,
                        assignedToEmpId: assetController.employeeId,
                        requestId: asset._id,
                        requestType: 'Asset Approval',
                        subjectEmployeeId: req.user.employeeId,
                        subjectName: requesterDisplayName,
                        requestedByName: requesterDisplayName,
                        extra1: `${asset.assetId} — ${asset.name}`,
                        extra2: `Asset creation — requested by ${requesterDisplayName}`,
                        status: 'Pending'
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                await sendAssetCreationApprovalEmail({
                    asset,
                    recipient: assetController,
                    creatorName: requesterDisplayName
                });
            } catch (err) {
                console.error('[submitAssetForApproval] Notification error:', err);
            }
        }

        return res.status(200).json(asset);
    } catch (error) {
        console.error('submitAssetForApproval error:', error);
        return res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

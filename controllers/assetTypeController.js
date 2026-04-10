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
import { buildBulkAssetInventoryPdfAttachment, requireBulkAssetInventoryPdfAttachment } from '../utils/generateBulkAssetInventoryPdf.js';
import { sendAssetCreatedByAdminInfoEmail } from '../utils/sendAssetCreationDecisionEmail.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { sendAssignedEmployeeActionEmail } from '../utils/sendAssignedEmployeeActionEmail.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import { resolveAssetControllerEmployee, getAssetRequesterDisplayName } from '../utils/assetApprovalHelpers.js';
import {
    notifyAdminDeletedAssetTypeOrCategory,
    notifyAdminDeletedWholeAsset,
    notifyAdminRemovedAccessoriesFromAssignedAsset,
    getAssetControllerNotificationEmail
} from '../utils/sendAdminDeletionNotificationEmails.js';
import {
    syncAllAccessoryInstancesForAsset,
    markCatalogInstancesDetachedFromAsset
} from '../utils/syncAssetAccessoryCatalog.js';
import { cleanupDashboardActionsForDeletedAsset } from '../utils/cleanupAssetDashboardActions.js';

/** Collapse duplicate accessory rows in a PUT payload (match by Mongo subdoc _id or accessoryId, not name). */
function dedupeAccessoryPayloadById(arr) {
    if (!Array.isArray(arr)) return arr;
    const map = new Map();
    let n = 0;
    for (const acc of arr) {
        const k =
            acc._id != null && acc._id !== ''
                ? String(acc._id)
                : acc.accessoryId != null && acc.accessoryId !== ''
                    ? String(acc.accessoryId)
                    : `__new_${n++}`;
        map.set(k, acc);
    }
    return Array.from(map.values());
}

const isAdminUser = async (reqUser) => {
    if (!reqUser) return false;
    if (reqUser.isAdmin === true || reqUser.role === 'Admin' || reqUser.role === 'ROOT') return true;
    const uid = reqUser.id || reqUser._id?.toString?.();
    return uid ? !!(await isUserAdministrator(uid)) : false;
};

// @desc    Role flags for asset type/category UI (GET /api/AssetType/meta/role)
export const getAssetTypeRoleMeta = async (req, res) => {
    try {
        const isJwtOrEnvAdmin = await isAdminUser(req.user);
        const isFlowchartOrgAdmin = await isUserInFlowchart(req.user, 'admincontroller').catch(() => false);
        const isAdmin = isJwtOrEnvAdmin || isFlowchartOrgAdmin;
        let isAssetController = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);
        const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
        let currentEmpObjectId = req.user?.employeeObjectId?.toString?.() || null;
        if (!currentEmpObjectId && req.user?.employeeId) {
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
                })
                    .select('_id')
                    .lean();
                if (empRow?._id) currentEmpObjectId = empRow._id.toString();
            }
        }
        const acHodMeta = await getDepartmentHOD('assetcontroller');
        let isDeptAssetControllerMeta = false;
        if (acHodMeta?._id && currentEmpObjectId) {
            isDeptAssetControllerMeta = acHodMeta._id.toString() === currentEmpObjectId;
        }
        if (!isDeptAssetControllerMeta && acHodMeta?.employeeId && req.user?.employeeId) {
            isDeptAssetControllerMeta = norm(req.user.employeeId) === norm(acHodMeta.employeeId);
        }
        isAssetController = isAssetController || isDeptAssetControllerMeta;
        res.status(200).json({ isAdmin, isAssetController });
    } catch (error) {
        console.error('getAssetTypeRoleMeta:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

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
            insuranceExpiryDate, oilChangeDate, gearOilDueDate, lastServiceDate, nextServiceDate,
            creationIntent
        } = req.body;

        // UAE Plate Validation if provided (usually for vehicles)
        if (plateNumber) {
            if (!UAE_PLATE_REGEX.test(plateNumber.trim().toUpperCase())) {
                return res.status(400).json({ message: 'Enter a valid UAE vehicle plate number' });
            }
            plateNumber = normalizePlate(plateNumber);
        }

        if (mode === 'category' || mode === 'type') {
            if (!(await isAdminUser(req.user))) {
                return res.status(403).json({ message: 'Only administrators can create asset types and categories.' });
            }
        }

        if (mode === 'category') {
            if (!category) return res.status(400).json({ message: 'Category name is required' });
            if (!type) return res.status(400).json({ message: 'Parent Type is required for categories' });

            const parentType = await AssetType.findOne({ name: type, isActive: true });
            if (!parentType) return res.status(404).json({ message: 'Selected Type not found' });

            const nameTrim = String(category).trim();
            const existingActive = await AssetCategory.findOne({ name: nameTrim, isActive: true });
            if (existingActive) {
                return res.status(400).json({ message: 'A category with this name already exists.' });
            }

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
                name: nameTrim,
                typeId: parentType._id,
                imagePreview: imageS3Key
            });
            return res.status(201).json(newCategory);

        } else if (mode === 'type') {
            if (!type) return res.status(400).json({ message: 'Type name is required' });

            const typeNameTrim = String(type).trim();
            const existingType = await AssetType.findOne({ name: typeNameTrim, isActive: true });
            if (existingType) {
                return res.status(400).json({ message: 'An asset type with this name already exists.' });
            }

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
                name: typeNameTrim,
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
            let t = await AssetType.findOne({ name: type, isActive: true });
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
                const cat = await AssetCategory.findOne({ name: category, isActive: true });
                if (cat) catId = cat._id;
            }

            if (!catId) {
                return res.status(400).json({ message: 'Valid Category is required for individual assets.' });
            }

            // Approval Logic: Check if creator is Asset Controller or Admin
            const assetControllerRaw = await getDepartmentHOD('assetcontroller');
            const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;

            if (!assetController) {
                return res.status(403).json({
                    message: "Asset controller is not assigned in the ERP flowchart. ERP cannot create an asset without an asset controller."
                });
            }

            const isJwtAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
            const isSysAdmin = await isUserAdministrator(req.user?.id);
            const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

            let initialStatus = 'Draft';
            let actionRequiredBy = null;

            const isPrivilegedCreator = isJwtAdmin || isSysAdmin || isAssetController;

            if (isPrivilegedCreator) {
                if (creationIntent === 'saveDraft') {
                    initialStatus = 'Draft';
                    actionRequiredBy = null;
                    console.log(
                        `[Asset creation] Draft saved by privileged user (${isJwtAdmin || isSysAdmin ? 'Admin' : 'Asset Controller'})`
                    );
                } else if (creationIntent === 'submitForApproval') {
                    initialStatus = 'Submitted for Approval';
                    actionRequiredBy = assetController._id;
                    console.log(
                        `[Asset creation] Submitted for approval by privileged user → Asset Controller (${req.user.employeeId || ''})`
                    );
                } else if (
                    creationIntent === 'createUnassigned' ||
                    creationIntent === undefined ||
                    creationIntent === null ||
                    creationIntent === ''
                ) {
                    initialStatus = 'Unassigned';
                    actionRequiredBy = null;
                    console.log(
                        `[Asset creation] Created as Unassigned by privileged user (${isJwtAdmin || isSysAdmin ? 'Admin' : 'Asset Controller'})`
                    );
                } else {
                    return res.status(400).json({
                        message:
                            'Invalid creationIntent. Use saveDraft, submitForApproval, or createUnassigned (omit for direct Unassigned).'
                    });
                }
            } else if (assetController) {
                // Regular creator: saveDraft = Draft with no approver/email; submitForApproval = new status + AC workflow
                const intent = creationIntent === 'saveDraft' ? 'saveDraft' : 'submitForApproval';
                if (intent === 'saveDraft') {
                    initialStatus = 'Draft';
                    actionRequiredBy = null;
                    console.log(`[Asset creation (Bulk/Type)] Saved as Draft (no AC notification) by ${req.user.employeeId}`);
                } else {
                    initialStatus = 'Submitted for Approval';
                    actionRequiredBy = assetController._id;
                    console.log(`[Asset creation (Bulk/Type)] Submitted for approval by ${req.user.employeeId} → Asset Controller`);
                }
            } else {
                // No asset controller defined & user is not admin
                return res.status(403).json({
                    message: "Asset controller is not assigned in the ERP flowchart. ERP cannot create an asset without an asset controller."
                });
            }

            const qty = Math.max(1, Number(quantity) || 1);
            const createdAssets = [];
            const requesterDisplayName = await getAssetRequesterDisplayName(req);

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
                    amount: acc?.amount != null && acc.amount !== '' ? Number(acc.amount) : 0,
                    description: acc?.description ? String(acc.description).trim() : '',
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

                try {
                    await syncAllAccessoryInstancesForAsset(newAsset);
                } catch (syncErr) {
                    console.error('[createAssetType accessory catalog sync]', syncErr?.message || syncErr);
                }

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

                // If admin created directly as Unassigned, notify asset controller (info email).
                if (initialStatus === 'Unassigned' && (isJwtAdmin || isSysAdmin) && assetController?._id) {
                    await sendAssetCreatedByAdminInfoEmail({
                        asset: newAsset,
                        recipient: assetController,
                        creatorName: requesterDisplayName
                    });
                }
            }

            // Submitted for approval (single or bulk): create one dashboard request and one email. (Draft / Unassigned skip this.)
            if (actionRequiredBy && assetController?._id && createdAssets.length > 0) {
                const first = createdAssets[0];
                const createdObjectIds = createdAssets.map((a) => a._id?.toString()).filter(Boolean);
                const createdCodes = createdAssets.map((a) => a.assetId).filter(Boolean);
                const isBulkCreation = createdAssets.length > 1;

                await DashboardAction.findOneAndUpdate(
                    { requestId: first._id, requestType: 'Asset Approval', status: 'Pending' },
                    {
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: assetController.employeeId,
                        requestId: first._id,
                        requestType: 'Asset Approval',
                        subjectEmployeeId: req.user.employeeId,
                        subjectName: requesterDisplayName,
                        requestedByName: requesterDisplayName,
                        extra1: isBulkCreation
                            ? `Bulk creation (${createdAssets.length}) — ${name}`
                            : `${first.assetId} — ${first.name}`,
                        extra2: `Asset creation — requested by ${requesterDisplayName}`,
                        extra3: JSON.stringify({
                            isBulkCreation,
                            bulkAssetIds: createdObjectIds,
                            bulkAssetCodes: createdCodes
                        }),
                        status: 'Pending'
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                let creationBulkAttachments = [];
                if (isBulkCreation) {
                    try {
                        creationBulkAttachments = await requireBulkAssetInventoryPdfAttachment(
                            req,
                            createdObjectIds,
                            'asset-creation-draft-inventory'
                        );
                    } catch (pdfErr) {
                        console.error('[createAssetType] Bulk creation PDF required:', pdfErr?.message || pdfErr);
                        return res.status(503).json({
                            message:
                                pdfErr?.message ||
                                'Assets were created but the asset list PDF could not be generated. Notify Asset Controller manually from the asset list.',
                            createdAssetIds: createdObjectIds,
                            createdCount: createdAssets.length
                        });
                    }
                } else {
                    try {
                        creationBulkAttachments = await buildBulkAssetInventoryPdfAttachment(
                            req,
                            [first._id.toString()],
                            'asset-creation-draft-inventory'
                        );
                    } catch (pdfErr) {
                        console.error('[createAssetType] PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
                    }
                }
                await sendAssetCreationApprovalEmail({
                    asset: first,
                    recipient: assetController,
                    creatorName: requesterDisplayName,
                    isBulk: isBulkCreation,
                    assetCount: createdAssets.length,
                    bulkAssetIds: createdObjectIds,
                    attachments: creationBulkAttachments
                });
            }

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

            // Keep backward compatibility (first created asset as base object),
            // and include bulk metadata for quantity > 1 UX.
            assetObj.createdCount = createdAssets.length;
            assetObj.createdAssetIds = createdAssets.map(a => a.assetId).filter(Boolean);

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

        // Draft assets are visible only to the creating user (User id), for every role.
        const uid = req.user?._id || req.user?.id;
        const assetQuery = {};
        if (uid && mongoose.Types.ObjectId.isValid(String(uid))) {
            assetQuery.$or = [
                { status: { $ne: 'Draft' } },
                { createdBy: new mongoose.Types.ObjectId(String(uid)) }
            ];
        } else {
            assetQuery.status = { $ne: 'Draft' };
        }

        const assets = await AssetItem.find(assetQuery)
            .populate('typeId')
            .populate('categoryId')
            .populate('actionRequiredBy', 'firstName lastName employeeId')
            .populate('assignedCompany', 'name companyId companyEmail')
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
                /** Required for bulk assign / filters: keys use id:${type|category} from catalog rows. */
                typeId: a.typeId
                    ? { _id: a.typeId._id, name: a.typeId.name }
                    : null,
                categoryId: a.categoryId
                    ? { _id: a.categoryId._id, name: a.categoryId.name }
                    : null,
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
                acceptanceStatus: a.acceptanceStatus,
                assignedToType: a.assignedToType,
                assigned: a.status === 'Assigned' ? 1 : 0,
                unassigned: a.status === 'Unassigned' ? 1 : 0,
                invoiceFile: await getSignedFileUrl(a.invoiceFile),
                actionRequiredBy: a.actionRequiredBy,
                assignedCompany: a.assignedCompany,
                designatedAssetController,
                pendingAction: a.pendingAction,
                accessories: await Promise.all((a.accessories || []).map(async (acc) => {
                    const accObj = acc.toObject ? acc.toObject() : acc;
                    return {
                        ...accObj,
                        attachment: accObj.attachment ? await getSignedFileUrl(accObj.attachment) : null
                    };
                })),
                lostDetachedAccessories: (a.lostDetachedAccessories || []).map((x) => (x.toObject ? x.toObject() : { ...x })),
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
        if (assetType) {
            const o = assetType.toObject();
            if (o.imagePreview) o.imagePreview = await getSignedFileUrl(o.imagePreview);
            return res.status(200).json(o);
        }
        const category = await AssetCategory.findById(req.params.id).populate('typeId', 'name typeId');
        if (category) {
            const o = category.toObject();
            if (o.imagePreview) o.imagePreview = await getSignedFileUrl(o.imagePreview);
            return res.status(200).json(o);
        }
        return res.status(404).json({ message: 'Asset type or category not found' });
    } catch (error) {
        console.error('Error fetching asset type:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete asset type / category (hard delete when no assets reference them)
// @route   DELETE /api/AssetType/:id
// @access  Private
export const deleteAssetType = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: 'Invalid ID format for deletion.' });
        }

        const category = await AssetCategory.findById(id);
        if (category) {
            if (!(await isAdminUser(req.user))) {
                return res.status(403).json({ message: 'Only administrators can delete asset types and categories.' });
            }
            const assetCount = await AssetItem.countDocuments({ categoryId: id });
            if (assetCount > 0) {
                return res.status(400).json({
                    message: `Cannot delete category: ${assetCount} asset(s) still use this category.`
                });
            }
            const categoryName = category.name;
            const performedBy = req.user?.name || req.user?.employeeId || 'Administrator';
            await AssetCategory.findByIdAndDelete(id);
            void notifyAdminDeletedAssetTypeOrCategory({
                kind: 'Category',
                name: categoryName,
                performedBy
            }).catch((e) => console.error('[notify category delete]', e?.message || e));
            return res.status(200).json({ message: 'Category deleted successfully' });
        }

        const assetType = await AssetType.findById(id);
        if (assetType) {
            if (!(await isAdminUser(req.user))) {
                return res.status(403).json({ message: 'Only administrators can delete asset types and categories.' });
            }
            const assetCount = await AssetItem.countDocuments({ typeId: id });
            if (assetCount > 0) {
                return res.status(400).json({
                    message: `Cannot delete type: ${assetCount} asset(s) still use this type.`
                });
            }
            const typeName = assetType.name;
            const performedBy = req.user?.name || req.user?.employeeId || 'Administrator';
            await AssetType.findByIdAndDelete(id);
            void notifyAdminDeletedAssetTypeOrCategory({
                kind: 'Type',
                name: typeName,
                performedBy
            }).catch((e) => console.error('[notify type delete]', e?.message || e));
            return res.status(200).json({ message: 'Type deleted successfully' });
        }

        // Try AssetItem (same ID path as types/categories — list UI often calls DELETE /AssetType/:id)
        const item = await AssetItem.findById(id);
        if (item) {
            const isAdmin = await isAdminUser(req.user);
            const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');
            const currentUserId = req.user?._id?.toString() || req.user?.id?.toString();
            const isCreator = item.createdBy?.toString() === currentUserId;
            const isEditableDraft = item.status === 'Draft' && !item.actionRequiredBy;

            if (Array.isArray(item.accessories) && item.accessories.length > 0) {
                return res.status(400).json({
                    message: 'Administrator cannot delete the asset while accessories are attached. Delete accessories first.',
                    accessoriesCount: item.accessories.length
                });
            }

            if (!isAdmin) {
                // Creator can delete only a save-only draft (not yet submitted for approval)
                if (!(isCreator && isEditableDraft)) {
                    // Explicit business rule: controller cannot delete after approval
                    if (isAssetController && item.status === 'Unassigned') {
                        return res.status(403).json({ message: 'Approved assets cannot be deleted by Asset Controller.' });
                    }
                    return res.status(403).json({ message: 'Only creator can delete editable drafts before submission. Admin can delete all.' });
                }
            }

            const typeIdForCounts = item.typeId;
            let adminNotificationEmail = null;

            if (isAdmin) {
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

            await cleanupDashboardActionsForDeletedAsset(item._id);
            await AssetHistory.deleteMany({ assetId: item._id });
            await AssetItem.findByIdAndDelete(id);

            if (typeIdForCounts) {
                const total = await AssetItem.countDocuments({ typeId: typeIdForCounts });
                const assigned = await AssetItem.countDocuments({ typeId: typeIdForCounts, status: 'Assigned' });
                const pending = await AssetItem.countDocuments({ typeId: typeIdForCounts, status: 'Pending' });
                const unassigned = total - assigned - pending;
                await AssetType.findByIdAndUpdate(typeIdForCounts, { total, assigned, unassigned });
            }

            return res.status(200).json({
                message: 'Asset deleted',
                ...(adminNotificationEmail ? { assetControllerEmail: adminNotificationEmail } : {})
            });
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

        const isAdmin =
            req.user.isAdmin === true ||
            req.user.role === 'Admin' ||
            req.user.role === 'ROOT' ||
            await isUserAdministrator(req.user?.id);
        const isAssetController = await isUserInFlowchart(req.user, 'assetcontroller');

        // Asset Category / Asset Type documents (not AssetItem): only Asset Controller may edit names and images
        const categoryDoc = await AssetCategory.findById(id);
        if (categoryDoc) {
            if (!isAssetController && !isAdmin) {
                return res.status(403).json({
                    message: 'Only administrators and Asset Controller can edit asset categories and types (including images).'
                });
            }
            const name = updates.category ?? updates.name;
            if (name !== undefined && String(name).trim()) {
                const n = String(name).trim();
                const clash = await AssetCategory.findOne({
                    name: n,
                    isActive: true,
                    _id: { $ne: categoryDoc._id }
                });
                if (clash) {
                    return res.status(400).json({ message: 'A category with this name already exists.' });
                }
                categoryDoc.name = n;
            }
            const img = updates.imagePreview || updates.photo;
            if (img && typeof img === 'string' && img.startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(img, 'asset-photos');
                    categoryDoc.imagePreview = uploadResult.publicId;
                } catch (e) {
                    console.error('Category image upload failed:', e);
                }
            }
            if (updates.type && typeof updates.type === 'string') {
                const parentType = await AssetType.findOne({ name: updates.type.trim(), isActive: true });
                if (parentType) categoryDoc.typeId = parentType._id;
            }
            await categoryDoc.save();
            const out = categoryDoc.toObject();
            if (out.imagePreview) out.imagePreview = await getSignedFileUrl(out.imagePreview);
            return res.status(200).json(out);
        }

        const typeDoc = await AssetType.findById(id);
        if (typeDoc) {
            if (!isAssetController && !isAdmin) {
                return res.status(403).json({
                    message: 'Only administrators and Asset Controller can edit asset categories and types (including images).'
                });
            }
            const name = updates.type ?? updates.name;
            if (name !== undefined && String(name).trim()) typeDoc.name = String(name).trim();
            if (updates.description !== undefined) typeDoc.description = updates.description;
            const img = updates.imagePreview || updates.photo;
            if (img && typeof img === 'string' && img.startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(img, 'asset-photos');
                    typeDoc.imagePreview = uploadResult.publicId;
                } catch (e) {
                    console.error('Type image upload failed:', e);
                }
            }
            await typeDoc.save();
            const out = typeDoc.toObject();
            if (out.imagePreview) out.imagePreview = await getSignedFileUrl(out.imagePreview);
            return res.status(200).json(out);
        }

        let asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Permission logic:
        // - Before creation approval (Draft/Pending): Creator + Asset Controller + Admin can edit
        // - After approval flow: keep assigned-asset edit rules for assignee/assigner/delegate
        const currentUserId = req.user._id?.toString() || req.user.id?.toString();
        const isCreator = asset.createdBy?.toString() === currentUserId;
        const isSubmittedForApproval = asset.status === 'Submitted for Approval';
        const isAwaitingCreationApproval = asset.status === 'Draft' || asset.status === 'Pending';
        const isCreationRejected = asset.status === 'Rejected';
        const initialAssetStatus = asset.status;
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

        const acHodForAsset = await getDepartmentHOD('assetcontroller');
        let isDeptAssetController = false;
        if (acHodForAsset?._id && currentEmpObjectId) {
            isDeptAssetController = acHodForAsset._id.toString() === currentEmpObjectId;
        }
        if (!isDeptAssetController && acHodForAsset?.employeeId && req.user?.employeeId) {
            isDeptAssetController = norm(req.user.employeeId) === norm(acHodForAsset.employeeId);
        }
        const isAssetControllerEffective = isAssetController || isDeptAssetController;

        if (isSubmittedForApproval) {
            if (isCreator && !isAdmin) {
                return res.status(403).json({
                    message: 'This asset is awaiting approval. The creator cannot edit until it is approved or rejected.'
                });
            }
            if (!isAdmin && !isAssetControllerEffective) {
                return res.status(403).json({
                    message: 'This asset is awaiting approval. Only Asset Controller or Admin can edit.'
                });
            }
        } else if (isAwaitingCreationApproval) {
            if (!isCreator && !isAdmin && !isAssetControllerEffective) {
                return res.status(403).json({ message: "Only creator, Asset Controller, or Admin can edit before creation approval." });
            }
        } else if (isCreationRejected) {
            if (!isCreator && !isAdmin && !isAssetControllerEffective) {
                return res.status(403).json({
                    message: 'Only the creator, Asset Controller, or Admin can edit a rejected asset.'
                });
            }
        } else if (!isAdmin && !isAssetControllerEffective && !isAssignedEditAllowed) {
            return res.status(403).json({ message: "Access denied. Only Asset Controller/Admin or assigned owner/delegate can edit this asset." });
        }

        /** @type {{ name?: string, accessoryId?: string }[] | null} */
        let adminRemovedAccessoriesForNotify = null;
        /** @type {{ name?: string, accessoryId?: string }[] | null} */
        let detachedAccessoryRefsForCatalog = null;

        const creatorDraftOrRejected =
            isCreator &&
            !isAdmin &&
            !isAssetControllerEffective &&
            (initialAssetStatus === 'Draft' || initialAssetStatus === 'Rejected');

        // Apply updates
        for (const key of Object.keys(updates)) {
            // Prevent updating immutable fields
            if (key !== '_id' && key !== 'assetId') {
                if (key === 'status' && creatorDraftOrRejected) {
                    continue;
                }
                // Security rule: only admin can edit asset value
                if (key === 'assetValue' && !isAdmin) {
                    continue;
                }
                if (key === 'accessories' && Array.isArray(updates[key])) {
                    updates[key] = dedupeAccessoryPayloadById(updates[key]);
                    const isAssigned = asset.status === 'Assigned' && asset.assignedTo;
                    const actorIsControllerOrAdmin = isAdmin || isAssetControllerEffective;
                    const oldAccessories = asset.accessories || [];
                    const incomingAccessoryPayload = updates[key];
                    const accessoryStillInPayload = (oa) =>
                        incomingAccessoryPayload.some(
                            (acc) =>
                                (oa._id &&
                                    acc._id &&
                                    oa._id.toString() === acc._id.toString()) ||
                                (oa.accessoryId &&
                                    acc.accessoryId &&
                                    oa.accessoryId === acc.accessoryId)
                        );
                    const removedAccessories = oldAccessories.filter((oa) => !accessoryStillInPayload(oa));
                    const creatorMayTrimAccessories =
                        removedAccessories.length > 0 &&
                        isCreator &&
                        !isAdmin &&
                        !isAssetControllerEffective &&
                        (initialAssetStatus === 'Draft' || initialAssetStatus === 'Rejected');
                    if (
                        removedAccessories.length > 0 &&
                        !isAdmin &&
                        !isAssetControllerEffective &&
                        !creatorMayTrimAccessories
                    ) {
                        return res.status(403).json({
                            message:
                                'Only Asset Controller, administrators, or (for draft/rejected assets) the creator can remove accessories from an asset.'
                        });
                    }
                    if (removedAccessories.length > 0 && isAdmin) {
                        adminRemovedAccessoriesForNotify = removedAccessories.map((oa) => ({
                            name: oa.name,
                            accessoryId: oa.accessoryId
                        }));
                        detachedAccessoryRefsForCatalog = adminRemovedAccessoriesForNotify;
                    } else if (creatorMayTrimAccessories) {
                        detachedAccessoryRefsForCatalog = removedAccessories.map((oa) => ({
                            name: oa.name,
                            accessoryId: oa.accessoryId
                        }));
                    } else if (removedAccessories.length > 0 && isAssetControllerEffective) {
                        detachedAccessoryRefsForCatalog = removedAccessories.map((oa) => ({
                            name: oa.name,
                            accessoryId: oa.accessoryId
                        }));
                    }

                    const newAccessoriesList = [];
                    let hasNewPending = false;
                    /** Admin/AC added new lines on an assigned asset — assignee must accept/reject. */
                    let hasAssigneeAccessoryApproval = false;
                    const addedAccessoryNames = [];

                    for (let i = 0; i < updates[key].length; i++) {
                        const acc = updates[key][i];
                        const existing = oldAccessories.find(oa =>
                            (oa._id && acc._id && oa._id.toString() === acc._id.toString()) ||
                            (oa.accessoryId && acc.accessoryId && oa.accessoryId === acc.accessoryId)
                        );

                        if (existing) {
                            if (!actorIsControllerOrAdmin && !creatorDraftOrRejected) {
                                const mergedName = acc.name !== undefined ? acc.name : existing.name;
                                const mergedDesc = acc.description !== undefined ? acc.description : existing.description;
                                const nameChanged = String(existing.name ?? '') !== String(mergedName ?? '');
                                const descChanged = String(existing.description ?? '') !== String(mergedDesc ?? '');
                                if (nameChanged || descChanged) {
                                    return res.status(403).json({
                                        message: 'Only Asset Controller or Admin can edit existing accessories.'
                                    });
                                }
                            }
                            // Keep existing accessory
                            const nextAmount = isAdmin
                                ? (acc.amount !== undefined ? acc.amount : existing.amount)
                                : existing.amount; // Accessory amount is admin-editable only
                            newAccessoriesList.push({
                                ...existing.toObject(),
                                ...acc,
                                amount: nextAmount,
                                accessoryId:
                                    existing.accessoryId ||
                                    acc.accessoryId ||
                                    generateAccessoryId(asset.assetId, i)
                            });
                        } else {
                            // NEW Accessory
                            const newAcc = {
                                ...acc,
                                accessoryId: generateAccessoryId(asset.assetId, i)
                            };
                            addedAccessoryNames.push(newAcc.name || newAcc.accessoryId || `Accessory ${i + 1}`);

                            if (!actorIsControllerOrAdmin) {
                                // Assignee (or non-authority): Asset Controller approves.
                                newAcc.status = 'Pending';
                                newAcc.pendingAction = 'Add';
                                newAcc.pendingActionDetails = {
                                    requestedBy: req.user.employeeObjectId || req.user._id,
                                    requestedAt: new Date(),
                                    addApprovalKind: 'AssetController'
                                };
                                hasNewPending = true;
                            } else if (isAssigned) {
                                // Admin/AC on assigned asset: holder must approve before Attached.
                                newAcc.status = 'Pending';
                                newAcc.pendingAction = 'Add';
                                newAcc.pendingActionDetails = {
                                    requestedBy: req.user.employeeObjectId || req.user._id,
                                    requestedAt: new Date(),
                                    addApprovalKind: 'Assignee'
                                };
                                hasAssigneeAccessoryApproval = true;
                            } else {
                                // Unassigned (or no assignee): attach immediately.
                                newAcc.status = 'Attached';
                            }
                            newAccessoriesList.push(newAcc);
                        }
                    }

                    const pendingAddsBefore = oldAccessories.filter((a) => a.pendingAction === 'Add');
                    const isAssigneeApprovalKind = (a) => String(a.pendingActionDetails?.addApprovalKind || '') === 'Assignee';
                    const isAcSidePendingAdd = (a) => a.pendingAction === 'Add' && !isAssigneeApprovalKind(a);
                    if (hasAssigneeAccessoryApproval && pendingAddsBefore.some(isAcSidePendingAdd)) {
                        return res.status(409).json({
                            message:
                                'Resolve pending accessory additions awaiting Asset Controller before adding items that require assignee approval.'
                        });
                    }
                    if (hasNewPending && pendingAddsBefore.some(isAssigneeApprovalKind)) {
                        return res.status(409).json({
                            message:
                                'Resolve pending accessory additions awaiting the assigned user before submitting new add requests.'
                        });
                    }

                    asset.accessories = newAccessoriesList;

                    // If new accessories were added to an assigned asset, create notification
                    if (hasNewPending) {
                        try {
                            // Always route accessory add approvals to Asset Controller.
                            const controller = await getDepartmentHOD('assetcontroller');
                            if (controller?._id) {
                                const requesterName = req.user.name || 'System';
                                asset.actionRequiredBy = controller._id;

                                await DashboardAction.findOneAndUpdate(
                                    { requestId: asset._id, requestType: 'Asset Accessory Approval', status: 'Pending' },
                                    {
                                        assignedTo: controller._id,
                                        assignedToEmpId: controller.employeeId,
                                        requestId: asset._id,
                                        requestType: 'Asset Accessory Approval',
                                        status: 'Pending',
                                        subjectEmployeeId: asset.assignedTo?.employeeId || '',
                                        subjectName: asset.assignedTo ? `${asset.assignedTo.firstName || ''} ${asset.assignedTo.lastName || ''}`.trim() : 'Assigned Employee',
                                        requestedByName: requesterName,
                                        extra1: `${asset.assetId} — Accessory: Adding New`,
                                        extra2: 'Add'
                                    },
                                    { upsert: true, new: true, setDefaultsOnInsert: true }
                                );

                                let addAccPdf = [];
                                try {
                                    addAccPdf = await buildBulkAssetInventoryPdfAttachment(req, [asset._id.toString()], 'accessory-add-request-inventory');
                                } catch (e) {
                                    /* non-fatal */
                                }
                                await sendAssetActionApprovalEmail(
                                    { ...asset.toObject(), assetId: asset.assetId },
                                    'Add Accessory',
                                    controller,
                                    { name: requesterName },
                                    'Assigned user requested accessory addition. Please approve or reject.',
                                    addAccPdf
                                );

                                await AssetHistory.create({
                                    assetId: asset._id,
                                    action: 'Comment',
                                    performedBy: req.user.employeeObjectId || req.user._id,
                                    comments: `Accessory add request submitted for approval to Asset Controller by ${requesterName}.`,
                                    date: new Date(),
                                    details: { type: 'AccessoryAddRequest', requestedBy: requesterName }
                                });
                            }
                        } catch (err) {
                            console.error('[AddAccessory Notification] Error:', err);
                        }
                    } else if (hasAssigneeAccessoryApproval && isAssigned) {
                        // Admin/AC added pending lines: assignee must approve (same inbox type as other accessory approvals).
                        try {
                            const assigneeEmp = await EmployeeBasic.findById(asset.assignedTo);
                            if (assigneeEmp?._id) {
                                asset.actionRequiredBy = assigneeEmp._id;
                                const actorName =
                                    (await getAssetRequesterDisplayName(req)) ||
                                    req.user.name ||
                                    req.user.employeeId ||
                                    'Asset Controller';

                                let assigneeApprovalPdf = [];
                                try {
                                    assigneeApprovalPdf = await buildBulkAssetInventoryPdfAttachment(
                                        req,
                                        [asset._id.toString()],
                                        'accessory-add-by-authority-assignee-approval'
                                    );
                                } catch (e) {
                                    /* non-fatal */
                                }

                                await sendAssetActionApprovalEmail(
                                    { ...asset.toObject(), assetId: asset.assetId },
                                    'Add Accessory',
                                    assigneeEmp,
                                    { name: actorName },
                                    'An administrator or Asset Controller added new accessories to your assigned asset. Please open the asset and accept or reject each pending addition in VeRP.',
                                    assigneeApprovalPdf
                                );

                                await DashboardAction.findOneAndUpdate(
                                    { requestId: asset._id, requestType: 'Asset Accessory Approval', status: 'Pending' },
                                    {
                                        assignedTo: assigneeEmp._id,
                                        assignedToEmpId: assigneeEmp.employeeId,
                                        requestId: asset._id,
                                        requestType: 'Asset Accessory Approval',
                                        status: 'Pending',
                                        subjectEmployeeId: assigneeEmp.employeeId || '',
                                        subjectName: `${assigneeEmp.firstName || ''} ${assigneeEmp.lastName || ''}`.trim(),
                                        requestedByName: actorName,
                                        extra1: `${asset.assetId} — Accessory: approval required (added by authority)`,
                                        extra2: 'Add'
                                    },
                                    { upsert: true, new: true, setDefaultsOnInsert: true }
                                );

                                await AssetHistory.create({
                                    assetId: asset._id,
                                    action: 'Comment',
                                    performedBy: req.user.employeeObjectId || req.user._id,
                                    comments: `${actorName} added accessory(ies) pending assignee approval: ${addedAccessoryNames.join(', ')}.`,
                                    date: new Date(),
                                    details: { type: 'AuthorityAccessoryAddPendingAssignee', names: addedAccessoryNames }
                                }).catch(() => { });
                            }
                        } catch (err) {
                            console.error('[AddAccessory Assignee Approval Flow] Error:', err);
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

        try {
            if (detachedAccessoryRefsForCatalog?.length) {
                await markCatalogInstancesDetachedFromAsset(
                    asset._id,
                    detachedAccessoryRefsForCatalog.map((x) => x.accessoryId).filter(Boolean)
                );
            }
            await syncAllAccessoryInstancesForAsset(asset);
        } catch (syncErr) {
            console.error('[updateAssetItem accessory catalog sync]', syncErr?.message || syncErr);
        }

        if (adminRemovedAccessoriesForNotify?.length) {
            const assetForEmail = await AssetItem.findById(asset._id)
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
            if (assetForEmail) {
                void notifyAdminRemovedAccessoriesFromAssignedAsset(req, assetForEmail, adminRemovedAccessoriesForNotify).catch(
                    (e) => console.error('[notify accessory removal]', e?.message || e)
                );
            }
        }

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

                let submitAttachments = [];
                try {
                    submitAttachments = await buildBulkAssetInventoryPdfAttachment(req, [asset._id.toString()], 'asset-creation-draft-inventory');
                } catch (pdfErr) {
                    console.error('[submitAssetForApproval] PDF attachment failed (non-fatal):', pdfErr?.message || pdfErr);
                }
                await sendAssetCreationApprovalEmail({
                    asset,
                    recipient: assetController,
                    creatorName: requesterDisplayName,
                    attachments: submitAttachments
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

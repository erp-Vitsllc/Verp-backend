import AssetType from '../models/AssetType.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetItem from '../models/AssetItem.js';
import AssetHistory from '../models/AssetHistory.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { isUserAdministrator } from '../services/permissionService.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import mongoose from 'mongoose';
import { uploadDocumentToS3, getSignedFileUrl, persistStoredAttachmentValue, normalizeS3Key } from '../utils/s3Upload.js';
import { sendAssetCreationApprovalEmail } from '../utils/sendAssetCreationApprovalEmail.js';
import {
    buildCreationRequestHandoverAttachments,
    buildPendingRequestHandoverCtx,
    buildAssignmentHandoverEmailAttachments,
} from '../utils/buildAssignmentHandoverEmailAttachments.js';
import { sendAssetCreatedByAdminInfoEmail } from '../utils/sendAssetCreationDecisionEmail.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { sendAssignedEmployeeActionEmail } from '../utils/sendAssignedEmployeeActionEmail.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import {
    resolveAssetControllerEmployee,
    getAssetRequesterDisplayName,
    resolveNewAssetCreationStatus,
    userCanDirectAddAssetToPool,
    resolveAssetCreationApproverEmployee,
    creationApproverRoleLabel,
    isFleetVehicleAssetFields,
    userIsFlowchartAdminOfficer,
} from '../utils/assetApprovalHelpers.js';
import {
    FLEET_VEHICLE_ASSET_ID_PREFIX,
    generateNextFleetVehicleAssetId,
} from '../utils/fleetVehicleAssetId.js';
import {
    notifyAdminDeletedAssetTypeOrCategory,
    notifyAdminDeletedWholeAsset,
    notifyAdminRemovedAccessoriesFromAssignedAsset,
    getAssetControllerNotificationEmail,
} from '../utils/sendAdminDeletionNotificationEmails.js';
import { awaitAdminDeletionArchive } from '../utils/adminDeletionArchiveRun.js';
import {
    syncAllAccessoryInstancesForAsset,
    markCatalogInstancesDetachedFromAsset
} from '../utils/syncAssetAccessoryCatalog.js';
import { cleanupDashboardActionsForDeletedAsset } from '../utils/cleanupAssetDashboardActions.js';
import { isTransientMongoError } from '../utils/mongoTransientRetry.js';
import { migrateLegacyOperationalFlags } from '../utils/assetOperationalFlags.js';
import { isAssetStatusBlockingAccessoryAdd } from '../utils/assetPendingAccessoryVisibility.js';
import { signVehicleAccessoriesListEntries } from '../utils/vehicleAccessoriesListSync.js';

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
    if (isJwtSystemSuperUser(reqUser)) return true;
    const uid = reqUser.id || reqUser._id?.toString?.();
    return uid ? !!(await isUserAdministrator(uid)) : false;
};

// @desc    Role flags for asset type/category UI (GET /api/AssetType/meta/role)
export const getAssetTypeRoleMeta = async (req, res) => {
    try {
        const isJwtOrEnvAdmin = await isAdminUser(req.user);
        const isFlowchartOrgAdmin = await isUserInFlowchart(req.user, 'admincontroller').catch(() => false);
        const isAdmin = isJwtOrEnvAdmin || isFlowchartOrgAdmin;
        const acHodMeta = await getDepartmentHOD('assetcontroller');
        const acEmpMeta = acHodMeta ? await resolveAssetControllerEmployee(acHodMeta) : null;
        const isAssetController = await userCanDirectAddAssetToPool(req, acEmpMeta);
        const canDirectAddAsset = isAssetController;
        res.status(200).json({ isAdmin, isAssetController, canDirectAddAsset });
    } catch (error) {
        console.error('getAssetTypeRoleMeta:', error?.message || error);
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
        return `${prefix}001`;
    }
};

/** Match create-asset behaviour: resolve brand/type name to an AssetType, auto-creating when missing. */
const resolveAssetTypeDocByName = async (typeName) => {
    const trimmed = String(typeName || '').trim();
    if (!trimmed) return null;

    let tDoc = await AssetType.findOne({ name: trimmed, isActive: true });
    if (!tDoc) {
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        tDoc = await AssetType.findOne({
            name: { $regex: new RegExp(`^${escaped}$`, 'i') },
            isActive: true,
        });
    }
    if (!tDoc) {
        const typeId = await generateGenericId(AssetType, 'asset-type-', 'typeId');
        tDoc = await AssetType.create({
            typeId,
            name: trimmed,
            description: `Auto-created type: ${trimmed}`,
        });
    }
    return tDoc;
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

const VALID_PLATE_EMIRATES = new Set([
    'Abu Dhabi',
    'Dubai',
    'Sharjah',
    'Ajman',
    'Umm Al Quwain',
    'Ras Al Khaimah',
    'Fujairah'
]);

const sanitizePlateEmirate = (val) => {
    const s = String(val || '').trim();
    return VALID_PLATE_EMIRATES.has(s) ? s : '';
};

const parseBool = (val) => {
    if (typeof val === 'boolean') return val;
    const s = String(val ?? '').trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
    return false;
};

// Helper to generate accessory suffix (A, B, C...)
const generateAccessoryId = (assetId, index) => {
    const charCode = 65 + (index % 26);
    const suffix = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
    return `${assetId}${String.fromCharCode(charCode)}${suffix}`;
};

export const createAssetType = async (req, res) => {
    try {
        let {
            mode, category, type, name, assetValue, purchaseDate, quantity, warranty, warrantyYears, warrantyAttachment, invoiceNumber, imagePreview, description, invoiceFile, accessories,
            vehicleCode, plateNumber, plateEmirate, modelYear, currentKilometer, registrationExpiryDate,
            insuranceExpiryDate, oilChangeDate, gearOilDueDate, lastServiceDate, nextServiceDate,
            warrantyEnabled, warrantyKm, warrantyExpiryDate,
            creationIntent
        } = req.body;

        // Plate normalization if provided (usually for vehicles).
        // Validation is intentionally relaxed to accept real-world formats from UI/backend variations.
        let plateEmirateStored = '';
        if (plateNumber) {
            plateNumber = normalizePlate(plateNumber);
            plateEmirateStored = sanitizePlateEmirate(plateEmirate);
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
            if (!purchaseDate) {
                return res.status(400).json({ message: 'Purchase Date is required' });
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

            const fleetVehicle = isFleetVehicleAssetFields({ plateNumber, typeName: type });
            const approverLabel = fleetVehicle ? 'HR' : creationApproverRoleLabel({ plateNumber, typeName: type });
            const creationApprover = fleetVehicle
                ? null
                : await resolveAssetCreationApproverEmployee({ plateNumber, typeName: type });
            const assetControllerRaw = await getDepartmentHOD('assetcontroller');
            const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;

            if (!fleetVehicle && !creationApprover) {
                return res.status(403).json({
                    message: `${approverLabel} is not assigned in the ERP flowchart. Cannot create this asset until ${approverLabel} is configured.`,
                });
            }

            const creationResolved = await resolveNewAssetCreationStatus(req, {
                creationIntent,
                approverEmp: creationApprover,
                approverLabel,
                isFleetVehicle: fleetVehicle,
            });
            if (creationResolved.error) {
                return res.status(creationResolved.status || 400).json({ message: creationResolved.error });
            }
            const { initialStatus, actionRequiredBy } = creationResolved;
            const isJwtAdmin = isJwtSystemSuperUser(req.user);
            const isSysAdmin = await isUserAdministrator(req.user?.id);

            const qty = Math.max(1, Number(quantity) || 1);
            const createdAssets = [];
            const requesterDisplayName = await getAssetRequesterDisplayName(req);

            // Fetch the starting numeric part for IDs
            const prefix = fleetVehicle ? FLEET_VEHICLE_ASSET_ID_PREFIX : 'VEGA-ASSET-';
            let startingNum = 1;

            if (fleetVehicle) {
                const nextFleetId = await generateNextFleetVehicleAssetId();
                const fleetNum = parseInt(nextFleetId.substring(prefix.length), 10);
                if (Number.isFinite(fleetNum)) startingNum = fleetNum;
            } else {
                const regex = new RegExp(`^${prefix}\\d+$`);
                const lastItem = await AssetItem.findOne({
                    assetId: { $regex: regex },
                }).sort({ assetId: -1 });

                if (lastItem?.assetId) {
                    const numStr = lastItem.assetId.substring(prefix.length);
                    const numericPart = parseInt(numStr, 10);
                    if (!isNaN(numericPart)) startingNum = numericPart + 1;
                }
            }

            // Handle Image Upload
            let imageS3Key = imagePreview;
            if (imagePreview && imagePreview.startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(imagePreview, 'asset-photos');
                    imageS3Key = uploadResult.publicId;
                } catch (error) {
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
                    warrantyEnabled: parseBool(warrantyEnabled),
                    warrantyKm: Number(warrantyKm) || 0,
                    warrantyExpiryDate: parseBool(warrantyEnabled) ? (warrantyExpiryDate || null) : null,
                    invoiceNumber,
                    imagePreview: imageS3Key,
                    photo: imageS3Key,
                    invoiceFile,
                    accessories: formattedAccessories,
                    status: initialStatus,
                    actionRequiredBy: actionRequiredBy,
                    createdBy: req.user._id,
                    vehicleCode,
                    plateEmirate: plateEmirateStored,
                    plateNumber,
                    modelYear,
                    currentKilometer,
                    registrationExpiryDate,
                    insuranceExpiryDate,
                    oilChangeDate,
                    gearOilDueDate,
                    lastServiceDate,
                    nextServiceDate,
                    ...(plateNumber && String(plateNumber).trim()
                        ? {
                            vehicleProfileActivationStatus: 'inactive',
                            vehicleDispositionStatus: 'active',
                            vehicleBrand: String(type || '').trim(),
                        }
                        : {}),
                };

                const newAsset = await AssetItem.create(assetData);
                createdAssets.push(newAsset.toObject());

                try {
                    await syncAllAccessoryInstancesForAsset(newAsset);
                } catch (syncErr) {
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

                // If administrator created directly as Unassigned, notify asset controller (info email).
                if (initialStatus === 'Unassigned' && (isJwtAdmin || isSysAdmin) && assetController?._id) {
                    await sendAssetCreatedByAdminInfoEmail({
                        asset: newAsset,
                        recipient: assetController,
                        creatorName: requesterDisplayName
                    });
                }
            }

            // Submitted for approval (single or bulk): create one dashboard request and one email. (Draft / Unassigned skip this.)
            if (actionRequiredBy && creationApprover?._id && createdAssets.length > 0) {
                const first = createdAssets[0];
                const createdObjectIds = createdAssets.map((a) => a._id?.toString()).filter(Boolean);
                const createdCodes = createdAssets.map((a) => a.assetId).filter(Boolean);
                const isBulkCreation = createdAssets.length > 1;
                const fleetVehicle = isFleetVehicleAssetFields({ plateNumber, typeName: type });

                await DashboardAction.findOneAndUpdate(
                    { requestId: first._id, requestType: 'Asset Approval', status: 'Pending' },
                    {
                        assignedTo: actionRequiredBy,
                        assignedToEmpId: creationApprover.employeeId,
                        requestId: first._id,
                        requestType: 'Asset Approval',
                        subjectEmployeeId: req.user.employeeId,
                        subjectName: requesterDisplayName,
                        requestedByName: requesterDisplayName,
                        extra1: isBulkCreation
                            ? `Bulk creation (${createdAssets.length}) — ${name}`
                            : `${first.assetId} — ${first.name}`,
                        extra2: fleetVehicle
                            ? `Vehicle creation — HR review (${requesterDisplayName})`
                            : `Asset creation — requested by ${requesterDisplayName}`,
                        extra3: JSON.stringify({
                            isBulkCreation,
                            bulkAssetIds: createdObjectIds,
                            bulkAssetCodes: createdCodes,
                            isFleetVehicle: fleetVehicle,
                            vehicleMongoId: fleetVehicle ? String(first._id) : undefined,
                        }),
                        status: 'Pending'
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                const requester = req.user.employeeObjectId
                    ? await EmployeeBasic.findById(req.user.employeeObjectId)
                        .select('firstName lastName signature employeeId department')
                        .lean()
                    : null;
                let creationBulkAttachments = [];
                try {
                    creationBulkAttachments = await buildCreationRequestHandoverAttachments(
                        req,
                        isBulkCreation ? createdObjectIds : [first._id.toString()],
                        { assigner: requester, assignerName: requesterDisplayName },
                    );
                    if (isBulkCreation && !creationBulkAttachments?.length) {
                        return res.status(503).json({
                            message:
                                'Assets were created but the Asset Handover Form PDF could not be generated. Notify Asset Controller manually from the asset list.',
                            createdAssetIds: createdObjectIds,
                            createdCount: createdAssets.length,
                        });
                    }
                } catch (pdfErr) {
                    if (isBulkCreation) {
                        return res.status(503).json({
                            message:
                                pdfErr?.message ||
                                'Assets were created but the Asset Handover Form PDF could not be generated. Notify Asset Controller manually from the asset list.',
                            createdAssetIds: createdObjectIds,
                            createdCount: createdAssets.length,
                        });
                    }
                }
                await sendAssetCreationApprovalEmail({
                    asset: first,
                    recipient: creationApprover,
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
    const scope = String(req.query.scope || '').toLowerCase().trim();
    const catalogOnly = scope === 'catalog';
    const toolsOnly = scope === 'tools';

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!catalogOnly && !toolsOnly) {
                // Fix: Drop the index causing 500 errors if it was created accidentally
                try { await AssetType.collection.dropIndex('assetId_1'); } catch (e) { /* ignore */ }
            }

            // We aggregate all 3 collections into a unified list for the frontend
            const categories = await AssetCategory.find({ isActive: true }).populate('typeId');
            const types = await AssetType.find({ isActive: true });

            if (catalogOnly) {
                const typeCategoryCounts = {};
                categories.forEach((c) => {
                    if (c.typeId) {
                        const typeIdStr = c.typeId._id.toString();
                        typeCategoryCounts[typeIdStr] = (typeCategoryCounts[typeIdStr] || 0) + 1;
                    }
                });
                const unifiedList = [
                    ...categories.map((c) => ({
                        _id: c._id,
                        assetId: c.categoryId,
                        category: c.name,
                        imagePreview: c.imagePreview || null,
                        type: c.typeId?.name || null,
                    })),
                    ...types.map((t) => ({
                        _id: t._id,
                        assetId: t.typeId,
                        type: t.name,
                        category: null,
                        categoryCount: typeCategoryCounts[t._id.toString()] || 0,
                        imagePreview: t.imagePreview || null,
                        description: t.description,
                    })),
                ];
                return res.status(200).json(unifiedList);
            }

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

            if (toolsOnly) {
                assetQuery.$and = assetQuery.$and || [];
                assetQuery.$and.push({
                    $or: [
                        { plateNumber: { $exists: false } },
                        { plateNumber: null },
                        { plateNumber: '' },
                    ],
                });
            }

            const assets = await AssetItem.find(assetQuery)
                .populate('typeId')
                .populate('categoryId')
                .populate('actionRequiredBy', 'firstName lastName employeeId')
                .populate('assignedCompany', 'name nickName companyId companyEmail')
                .populate({
                    path: 'assignedTo',
                    select: 'firstName lastName employeeId department primaryReportee reportingAuthority',
                    populate: [
                        { path: 'primaryReportee', select: 'firstName lastName' },
                        { path: 'reportingAuthority', select: 'firstName lastName' }
                    ]
                })
                .lean();

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

            // Fetch all fines related to the returned assets (object id + human asset id for legacy rows)
            const assetIds = assets.map(a => a._id);
            const assetHumanIds = [...new Set(assets.map((a) => a.assetId).filter(Boolean))];
            const Fine = (await import('../models/Fine.js')).default;
            const fineQuery = [{ assetObjectId: { $in: assetIds } }];
            if (assetHumanIds.length) {
                fineQuery.push({ assetId: { $in: assetHumanIds } });
            }
            let fines = await Fine.find({ $or: fineQuery })
                .select('fineId fineStatus assetId assetObjectId accessoryId accessoryObjectId createdAt')
                .lean();

            const lostHistoryRows = await AssetHistory.find({
                assetId: { $in: assetIds },
                $or: [
                    { action: { $in: ['Lost', 'End of Life'] } },
                    { 'details.fineId': { $exists: true, $ne: null } },
                ],
            })
                .select('assetId action date details comments')
                .sort({ date: -1 })
                .lean();

            const lostAtByAssetId = new Map();
            const fineIdByAssetId = new Map();
            for (const row of lostHistoryRows) {
                const key = row.assetId?.toString();
                if (!key) continue;
                if ((row.action === 'Lost' || row.action === 'End of Life') && !lostAtByAssetId.has(key)) {
                    lostAtByAssetId.set(key, row.date);
                }
                const detailFineId = row.details?.fineId;
                if (detailFineId && !fineIdByAssetId.has(key)) {
                    fineIdByAssetId.set(key, String(detailFineId).trim());
                }
                if (!fineIdByAssetId.has(key) && row.comments) {
                    const match = String(row.comments).match(/VEGA-(?:FINE|FNE)-\d+/i);
                    if (match) fineIdByAssetId.set(key, match[0].toUpperCase());
                }
            }

            const knownFineIds = new Set(fines.map((f) => f.fineId).filter(Boolean));
            const historyFineIds = [...fineIdByAssetId.values()].filter((id) => id && !knownFineIds.has(id));
            if (historyFineIds.length) {
                const extraFines = await Fine.find({ fineId: { $in: historyFineIds } })
                    .select('fineId fineStatus assetId assetObjectId accessoryId accessoryObjectId createdAt')
                    .lean();
                fines = [...fines, ...extraFines];
            }
            fines = [...new Map(fines.map((f) => [f.fineId, f])).values()];

            const fineByFineId = new Map(fines.map((f) => [f.fineId, f]));

            const pickMainAssetFine = (assetFines) => {
                const mains = assetFines.filter((f) => {
                    const accId = f.accessoryId;
                    return !(accId && String(accId).trim()) && !f.accessoryObjectId;
                });
                const pool = mains.length ? mains : assetFines;
                if (!pool.length) return null;
                return pool.sort(
                    (x, y) => new Date(y.createdAt || 0).getTime() - new Date(x.createdAt || 0).getTime(),
                )[0];
            };

            const matchFinesToAsset = (a) =>
                fines.filter(
                    (f) =>
                        f.assetObjectId?.toString() === a._id.toString() ||
                        (f.assetId && a.assetId && f.assetId === a.assetId),
                );

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
                ...await Promise.all(
                    assets.map(async (a) => {
                        const assetFines = matchFinesToAsset(a);
                        const mainFine = pickMainAssetFine(assetFines);
                        const assetKey = a._id.toString();
                        const historyFineId = fineIdByAssetId.get(assetKey) || null;
                        const resolvedFineId =
                            mainFine?.fineId || a.pendingActionDetails?.fineId || historyFineId || null;
                        const resolvedFine =
                            mainFine ||
                            (resolvedFineId ? fineByFineId.get(resolvedFineId) : null) ||
                            null;
                        const resolvedLostAt =
                            a.lostAt ||
                            mainFine?.createdAt ||
                            resolvedFine?.createdAt ||
                            lostAtByAssetId.get(assetKey) ||
                            (['lost', 'end of life'].includes(String(a.status || '').trim().toLowerCase())
                                ? a.updatedAt
                                : null) ||
                            null;

                        const accList = (a.accessories || []).map((acc) => {
                            const accFine = assetFines.find(f => 
                                (acc.accessoryId && f.accessoryId === acc.accessoryId) || 
                                (acc._id && f.accessoryObjectId?.toString() === acc._id.toString())
                            );
                            return {
                                ...acc,
                                fineId: accFine ? accFine.fineId : (acc.fineId || null),
                                fineStatus: accFine ? accFine.fineStatus : null,
                                lostAt: acc.lostAt || accFine?.createdAt || null,
                            };
                        });
                        const lostList = (a.lostDetachedAccessories || []).map((x) => {
                            const accFine = assetFines.find(f => 
                                (x.accessoryId && f.accessoryId === x.accessoryId) || 
                                (x._id && f.accessoryObjectId?.toString() === x._id.toString()) ||
                                (x.fineId && f.fineId === x.fineId)
                            );
                            return {
                                ...x,
                                fineId: accFine ? accFine.fineId : (x.fineId || null),
                                fineStatus: accFine ? accFine.fineStatus : null,
                                lostAt: x.detachedAt || accFine?.createdAt || null,
                            };
                        });

                        const signIf = async (key) => (key ? getSignedFileUrl(key) : null);
                        const imagePreview = await signIf(a.imagePreview);
                        const photo = await signIf(a.photo);
                        return {
                            _id: a._id,
                            assetId: a.assetId,
                            name: a.name,
                            type: a.typeId?.name || '-',
                            category: a.categoryId?.name || '-',
                            typeId: a.typeId ? { _id: a.typeId._id, name: a.typeId.name } : null,
                            categoryId: a.categoryId ? { _id: a.categoryId._id, name: a.categoryId.name } : null,
                            assetValue: a.assetValue,
                            purchaseDate: a.purchaseDate,
                            quantity: a.quantity || 1,
                            warranty: a.warranty,
                            warrantyYears: a.warrantyYears,
                            warrantyAttachment: toolsOnly ? a.warrantyAttachment : await signIf(a.warrantyAttachment),
                            invoiceNumber: a.invoiceNumber,
                            imagePreview,
                            photo,
                            status: a.status,
                            acceptanceStatus: a.acceptanceStatus,
                            assignedToType: a.assignedToType,
                            assigned: a.status === 'Assigned' ? 1 : 0,
                            unassigned: a.status === 'Unassigned' ? 1 : 0,
                            invoiceFile: await signIf(a.invoiceFile),
                            actionRequiredBy: a.actionRequiredBy,
                            assignedCompany: a.assignedCompany,
                            designatedAssetController,
                            pendingAction: a.pendingAction,
                            pendingActionDetails: a.pendingActionDetails || null,
                            lossDamageFineId: resolvedFineId,
                            lossDamageFineStatus: resolvedFine?.fineStatus || mainFine?.fineStatus || null,
                            lostAt: resolvedLostAt,
                            createdBy: a.createdBy,
                            accessories: toolsOnly
                                ? accList
                                : await Promise.all(
                                    accList.map(async (accObj) => ({
                                        ...accObj,
                                        attachment: accObj.attachment
                                            ? await getSignedFileUrl(accObj.attachment)
                                            : null,
                                    })),
                                ),
                            lostDetachedAccessories: lostList,
                            assignedTo: a.assignedTo,
                            vehicleCode: a.vehicleCode,
                            plateEmirate: a.plateEmirate,
                            plateNumber: a.plateNumber,
                            modelYear: a.modelYear,
                            currentKilometer: a.currentKilometer,
                            registrationExpiryDate: a.registrationExpiryDate,
                            insuranceExpiryDate: a.insuranceExpiryDate,
                            oilChangeDate: a.oilChangeDate,
                            gearOilDueDate: a.gearOilDueDate,
                            lastServiceDate: a.lastServiceDate,
                            nextServiceDate: a.nextServiceDate,
                            onLeaveActive: a.onLeaveActive === true,
                            onServiceActive: a.onServiceActive === true,
                            onLeaveStartDate: a.onLeaveStartDate,
                            onLeaveEndDate: a.onLeaveEndDate,
                            onLeaveDuration: a.onLeaveDuration,
                            services: Array.isArray(a.services) ? a.services : [],
                        };
                    }),
                ),
            ];

            return res.status(200).json(unifiedList);
        } catch (error) {
            const canRetry = attempt < 2 && isTransientMongoError(error);
            if (canRetry) {
                await new Promise((r) => setTimeout(r, 450 * (attempt + 1)));
                continue;
            }
            const transient = isTransientMongoError(error);
            return res.status(transient ? 503 : 500).json({
                message: transient ? 'Database temporarily unavailable. Please try again.' : 'Server Error',
                error: error.message,
                retryable: transient,
            });
        }
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
            const categorySnapshot = category.toObject ? category.toObject() : category;
            await awaitAdminDeletionArchive(req, {
                moduleName: 'Asset Category',
                recordId: categoryName,
                details: `Asset category deleted`,
                deletedPayload: categorySnapshot,
            });
            void notifyAdminDeletedAssetTypeOrCategory({
                kind: 'Category',
                name: categoryName,
                performedBy,
            });
            await AssetCategory.findByIdAndDelete(id);
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
            const typeSnapshot = assetType.toObject ? assetType.toObject() : assetType;
            await awaitAdminDeletionArchive(req, {
                moduleName: 'Asset Type',
                recordId: typeName,
                details: `Asset type deleted`,
                deletedPayload: typeSnapshot,
            });
            void notifyAdminDeletedAssetTypeOrCategory({
                kind: 'Type',
                name: typeName,
                performedBy,
            });
            await AssetType.findByIdAndDelete(id);
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

            const {
                shouldBlockAssetDeleteBecauseOfAccessories,
                accessoryDeleteBlockMessage,
            } = await import('../utils/assetDeleteAccessoriesRule.js');
            if (shouldBlockAssetDeleteBecauseOfAccessories(item, { isAdmin })) {
                return res.status(400).json({
                    message: accessoryDeleteBlockMessage(item),
                    accessoriesCount: item.accessories.length,
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
                    .populate('assignedCompany', 'name nickName companyId')
                    .lean();
                if (itemForEmail) {
                    await notifyAdminDeletedWholeAsset(req, itemForEmail);
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
        res.status(500).json({ message: 'Upload failed', error: error.message });
    }
};

const VEHICLE_ACCESSORIES_LIST_KEYS = [
    'spareTyre',
    'toolsKit',
    'scissorJack',
    'firstAidKit',
    'fireExtinguisher',
];

async function persistVehicleAccessoriesListPhoto(photo) {
    if (!photo) return null;
    if (typeof photo === 'string' && photo.startsWith('data:image')) {
        const uploadResult = await uploadDocumentToS3(photo, 'asset-accessories');
        return uploadResult.publicId;
    }
    if (typeof photo === 'string') {
        const normalized = normalizeS3Key(photo);
        if (normalized) return normalized;
        if (photo.startsWith('http')) return null;
        return photo.trim() || null;
    }
    return photo;
}

async function normalizeVehicleAccessoriesListEntries(entries) {
    if (!Array.isArray(entries)) return [];

    const normalized = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const next = {
            ...(entry._id ? { _id: entry._id } : {}),
            createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
            kind: String(entry.kind || 'manual').trim() || 'manual',
        };
        if (entry.sourceHistoryId) {
            next.sourceHistoryId = entry.sourceHistoryId;
        }
        if (entry.changedByKey && typeof entry.changedByKey === 'object') {
            next.changedByKey = entry.changedByKey;
        }
        if (entry.replacedKey) {
            next.replacedKey = String(entry.replacedKey).trim();
        }

        for (const key of VEHICLE_ACCESSORIES_LIST_KEYS) {
            const row = entry[key];
            if (!row || typeof row !== 'object') continue;
            const present =
                row.present === true ? true : row.present === false ? false : null;
            let photo = present === true ? row.photo || null : null;
            if (photo) {
                photo = await persistVehicleAccessoriesListPhoto(photo);
            }
            const amount =
                row.amount != null && row.amount !== '' && Number.isFinite(Number(row.amount))
                    ? Number(row.amount)
                    : null;
            next[key] = { present, photo, amount };
        }

        normalized.push(next);
    }

    return normalized;
}

// @desc    Update Asset Item (General)
// @route   PUT /api/AssetType/:id
// @access  Private
export const updateAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const isAdmin =
            isJwtSystemSuperUser(req.user) ||
            (await isUserAdministrator(req.user?.id)) ||
            (await userIsFlowchartAdminOfficer(req).catch(() => false));
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

        const vehicleTypeCheck = await AssetItem.findById(id)
            .populate('typeId', 'name')
            .select(
                'plateNumber plateEmirate typeId vehicleBrand vehicleCode vehicleProfileActivationStatus vehicleInspectionStatus vehicleDispositionStatus vehicleAccessoriesListEntries locatorDeviceId',
            )
            .lean()
            .catch(() => null);
        // Locator stubs often have no plate yet — still treat as fleet via emirate / profile / device markers.
        const isFleetVehicleAssetForCollaborativeEdit = isFleetVehicleAssetFields({
            plateNumber: vehicleTypeCheck?.plateNumber,
            typeName: vehicleTypeCheck?.typeId?.name,
            asset: vehicleTypeCheck,
        });

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
        } else if (
            !isAdmin &&
            !isAssetControllerEffective &&
            !isAssignedEditAllowed &&
            !isFleetVehicleAssetForCollaborativeEdit
        ) {
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

        if (updates.accidentReportDocument && typeof updates.accidentReportDocument === 'object' && updates.accidentReportDocument.data) {
            try {
                const ar = updates.accidentReportDocument;
                const uploadResult = await uploadDocumentToS3(
                    ar.data,
                    'asset-documents',
                    ar.name || 'accident-report'
                );
                asset.accidentReportAttachment = uploadResult.publicId;
            } catch (uploadErr) {
                return res.status(500).json({ message: 'Failed to upload accident report' });
            }
        }
        delete updates.accidentReportDocument;

        const mortgageFileKeys = [
            'mortgageSecurityCheckAttachment',
            'mortgageScheduleListAttachment',
            'mortgageBankDocument',
        ];
        for (const mk of mortgageFileKeys) {
            if (Object.prototype.hasOwnProperty.call(updates, mk)) {
                asset[mk] = await persistStoredAttachmentValue(
                    updates[mk],
                    'asset-documents',
                    mk,
                );
                delete updates[mk];
            }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'mortgageExtraAttachments')) {
            const rows = Array.isArray(updates.mortgageExtraAttachments)
                ? updates.mortgageExtraAttachments
                : [];
            asset.mortgageExtraAttachments = await Promise.all(
                rows.map(async (row) => {
                    const docName = String(row?.docName || '').trim();
                    const file = await persistStoredAttachmentValue(
                        row?.file,
                        'asset-documents',
                        row?.file?.name || docName || 'mortgage-doc',
                    );
                    return { docName, file };
                }),
            );
            delete updates.mortgageExtraAttachments;
        }

        if (updates.vehicleDispositionStatus != null) {
            const nextDisp = String(updates.vehicleDispositionStatus || '').toLowerCase().trim();
            const curDisp = String(asset.vehicleDispositionStatus || 'active').toLowerCase().trim();
            if (['sold', 'total loss'].includes(nextDisp) && nextDisp !== curDisp) {
                return res.status(400).json({
                    message:
                        'To mark a vehicle Sold or Total loss, use Edit basic details → change status → Send request (HR approval workflow).',
                });
            }
        }

        const isFleetVehicleAsset = Boolean(
            String(asset.plateNumber || vehicleTypeCheck?.plateNumber || updates.plateNumber || '').trim(),
        );

        if (isFleetVehicleAsset) {
            const brandInput = String(updates.brand ?? updates.type ?? '').trim();
            if (brandInput) {
                asset.vehicleBrand = brandInput;
                const brandTypeDoc = await resolveAssetTypeDocByName(brandInput);
                if (brandTypeDoc) asset.typeId = brandTypeDoc._id;
            }
        }

        for (const key of Object.keys(updates)) {
            // Prevent updating immutable fields
            if (key !== '_id' && key !== 'assetId') {
                if (isFleetVehicleAsset && (key === 'brand' || key === 'type')) {
                    continue;
                }
                if (key === 'purchaseDate' && !updates[key]) {
                    return res.status(400).json({ message: 'Purchase Date is required' });
                }
                if (key === 'status' && creatorDraftOrRejected) {
                    continue;
                }
                // Asset value: admin always; creator may set while Draft / Rejected (vehicle draft flow)
                if (key === 'assetValue' && !isAdmin) {
                    const creatorMaySetValue =
                        isCreator && (initialAssetStatus === 'Draft' || initialAssetStatus === 'Rejected');
                    const fleetCollaboratorMaySetValue = isFleetVehicleAssetForCollaborativeEdit;
                    if (!creatorMaySetValue && !fleetCollaboratorMaySetValue) continue;
                }
                if (key === 'onServiceActive' || key === 'onLeaveActive') {
                    if (!isAdmin && !isAssetControllerEffective) continue;
                    asset[key] = updates[key] === true || updates[key] === 'yes';
                    continue;
                }
                if (key === 'vehicleAccessoriesListEntries' && Array.isArray(updates[key])) {
                    asset.vehicleAccessoriesListEntries = await normalizeVehicleAccessoriesListEntries(
                        updates[key],
                    );
                    asset.markModified('vehicleAccessoriesListEntries');
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
                    const hasNewAccessory = incomingAccessoryPayload.some(
                        (acc) =>
                            !oldAccessories.find(
                                (oa) =>
                                    (oa._id &&
                                        acc._id &&
                                        oa._id.toString() === acc._id.toString()) ||
                                    (oa.accessoryId &&
                                        acc.accessoryId &&
                                        oa.accessoryId === acc.accessoryId),
                            ),
                    );
                    if (isAssetStatusBlockingAccessoryAdd(asset.status) && hasNewAccessory) {
                        return res.status(400).json({
                            message: 'Accessories cannot be added when the asset is Lost or End of Life.',
                        });
                    }
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
                                // Admin/AC on assigned asset: attach immediately (no assignee approval step).
                                newAcc.status = 'Attached';
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
                                    const requester = req.user.employeeObjectId
                                        ? await EmployeeBasic.findById(req.user.employeeObjectId)
                                            .select('firstName lastName signature employeeId department')
                                            .lean()
                                        : null;
                                    addAccPdf = await buildCreationRequestHandoverAttachments(
                                        req,
                                        [asset._id.toString()],
                                        { assigner: requester, assignerName: requesterName },
                                    );
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
                                    const actor = req.user.employeeObjectId
                                        ? await EmployeeBasic.findById(req.user.employeeObjectId)
                                            .select('firstName lastName signature employeeId department')
                                            .lean()
                                        : null;
                                    assigneeApprovalPdf = await buildAssignmentHandoverEmailAttachments(
                                        req,
                                        [asset._id.toString()],
                                        {
                                            ...buildPendingRequestHandoverCtx({
                                                assigner: actor,
                                                assignerName: actorName,
                                                assigneeName: `${assigneeEmp.firstName || ''} ${assigneeEmp.lastName || ''}`.trim(),
                                                employeeCode: assigneeEmp.employeeId || '—',
                                                department:
                                                    (assigneeEmp.department &&
                                                        String(assigneeEmp.department).trim()) ||
                                                    '—',
                                            }),
                                            assigner: actor,
                                            filenameBase: 'accessory-add-assignee-approval-handover',
                                        },
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
                        }
                    }
                } else if ((key === 'photo' || key === 'imagePreview') && updates[key] && updates[key].startsWith('data:image')) {
                    // Handle Image Upload to S3
                    try {
                        const uploadResult = await uploadDocumentToS3(updates[key], 'asset-photos');
                        asset[key] = uploadResult.publicId;
                    } catch (error) {
                        asset[key] = updates[key];
                    }
                } else {
                    if (key === 'type' && typeof updates[key] === 'string' && updates[key].trim()) {
                        const tDoc = await resolveAssetTypeDocByName(updates[key]);
                        if (tDoc) asset.typeId = tDoc._id;
                    } else if (key === 'plateNumber' && updates[key]) {
                        asset[key] = normalizePlate(updates[key]);
                    } else if (key === 'plateEmirate') {
                        asset[key] = sanitizePlateEmirate(updates[key]);
                    } else if (key !== 'type') {
                        asset[key] = updates[key];
                    }
                }
            }
        }

        // Keep warranty fields consistent on every update.
        const hasWarrantyIntent =
            Object.prototype.hasOwnProperty.call(updates, 'warrantyEnabled') ||
            Object.prototype.hasOwnProperty.call(updates, 'warrantyKm') ||
            Object.prototype.hasOwnProperty.call(updates, 'warrantyExpiryDate');
        if (hasWarrantyIntent) {
            const enabled = parseBool(updates.warrantyEnabled ?? asset.warrantyEnabled);
            asset.warrantyEnabled = enabled;
            if (enabled) {
                asset.warrantyKm = Number(updates.warrantyKm ?? asset.warrantyKm) || 0;
                asset.warrantyExpiryDate = updates.warrantyExpiryDate ?? asset.warrantyExpiryDate ?? null;
            } else {
                asset.warrantyKm = 0;
                asset.warrantyExpiryDate = null;
            }
        }

        await asset.save();

        await asset.populate('typeId', 'name imagePreview');

        try {
            if (detachedAccessoryRefsForCatalog?.length) {
                await markCatalogInstancesDetachedFromAsset(
                    asset._id,
                    detachedAccessoryRefsForCatalog.map((x) => x.accessoryId).filter(Boolean)
                );
            }
            await syncAllAccessoryInstancesForAsset(asset);
        } catch (syncErr) {
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
                .populate('assignedCompany', 'name nickName companyId')
                .lean();
            if (assetForEmail) {
                void notifyAdminRemovedAccessoriesFromAssignedAsset(req, assetForEmail, adminRemovedAccessoriesForNotify).catch(
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
        }

        // Convert to object and sign the invoice URL before returning
        const assetObj = asset.toObject();
        if (assetObj.invoiceFile) {
            assetObj.invoiceFile = await getSignedFileUrl(assetObj.invoiceFile);
        }
        if (assetObj.warrantyAttachment) {
            assetObj.warrantyAttachment = await getSignedFileUrl(assetObj.warrantyAttachment);
        }
        if (assetObj.accidentReportAttachment) {
            assetObj.accidentReportAttachment = await getSignedFileUrl(assetObj.accidentReportAttachment);
        }

        const signMortgageAttachment = async (val) => {
            if (val == null || val === '') return val;
            if (typeof val === 'string') {
                const trimmed = val.trim();
                if (!trimmed || trimmed.startsWith('data:')) return val;
                if (trimmed.length > 80 && !trimmed.includes('/') && !trimmed.startsWith('http')) {
                    return val;
                }
                return getSignedFileUrl(trimmed);
            }
            if (typeof val === 'object' && !Array.isArray(val)) {
                if (val.data && !val.publicId && !val.url) return val;
                if (val.file != null) {
                    return { ...val, file: await signMortgageAttachment(val.file) };
                }
                const ref = val.publicId || val.url;
                if (ref) {
                    const signed = await getSignedFileUrl(String(ref));
                    return { ...val, url: signed };
                }
            }
            return val;
        };

        if (assetObj.mortgageSecurityCheckAttachment) {
            assetObj.mortgageSecurityCheckAttachment = await signMortgageAttachment(
                assetObj.mortgageSecurityCheckAttachment,
            );
        }
        if (assetObj.mortgageScheduleListAttachment) {
            assetObj.mortgageScheduleListAttachment = await signMortgageAttachment(
                assetObj.mortgageScheduleListAttachment,
            );
        }
        if (assetObj.mortgageBankDocument) {
            assetObj.mortgageBankDocument = await signMortgageAttachment(assetObj.mortgageBankDocument);
        }
        if (Array.isArray(assetObj.mortgageExtraAttachments)) {
            assetObj.mortgageExtraAttachments = await Promise.all(
                assetObj.mortgageExtraAttachments.map(async (row) => ({
                    ...row,
                    file: row?.file ? await signMortgageAttachment(row.file) : row?.file,
                })),
            );
        }

        if (assetObj.accessories && Array.isArray(assetObj.accessories)) {
            assetObj.accessories = await Promise.all(assetObj.accessories.map(async (acc) => {
                return {
                    ...acc,
                    attachment: acc.attachment ? await getSignedFileUrl(acc.attachment) : null
                };
            }));
        }

        if (Array.isArray(assetObj.vehicleAccessoriesListEntries) && assetObj.vehicleAccessoriesListEntries.length) {
            assetObj.vehicleAccessoriesListEntries = await signVehicleAccessoriesListEntries(
                assetObj.vehicleAccessoriesListEntries,
                getSignedFileUrl,
            );
        }

        res.status(200).json(assetObj);

    } catch (error) {
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
        const isAdmin = isJwtSystemSuperUser(req.user);
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

        const fleetVehicle = isFleetVehicleAssetFields({ plateNumber: asset.plateNumber });
        const requesterDisplayName = await getAssetRequesterDisplayName(req);

        if (fleetVehicle) {
            asset.status = 'Unassigned';
            asset.actionRequiredBy = null;
            if (!asset.vehicleProfileActivationStatus) {
                asset.vehicleProfileActivationStatus = 'inactive';
            }
            await asset.save();
            return res.status(200).json(asset);
        }

        const assetControllerRaw = await getDepartmentHOD('assetcontroller');
        const assetController = assetControllerRaw ? await resolveAssetControllerEmployee(assetControllerRaw) : null;
        if (!assetController?._id && !isAdmin) {
            return res.status(403).json({
                message: 'No Asset Controller assigned in Flowchart, or controller is not linked to an employee record.'
            });
        }

        if (isAdmin || isAssetController) {
            asset.status = 'Unassigned';
            asset.actionRequiredBy = null;
        } else {
            asset.status = 'Submitted for Approval';
            asset.actionRequiredBy = assetController._id;
        }
        await asset.save();

        if (asset.status === 'Unassigned' && isAdmin && !isAssetController && assetController?._id) {
            try {
                await sendAssetCreatedByAdminInfoEmail({
                    asset,
                    recipient: assetController,
                    creatorName: requesterDisplayName,
                });
            } catch (infoErr) {
            }
        }

        if (asset.status === 'Submitted for Approval' && assetController?._id) {
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
                    const requester = req.user.employeeObjectId
                        ? await EmployeeBasic.findById(req.user.employeeObjectId)
                            .select('firstName lastName signature employeeId department')
                            .lean()
                        : null;
                    submitAttachments = await buildCreationRequestHandoverAttachments(
                        req,
                        [asset._id.toString()],
                        { assigner: requester, assignerName: requesterDisplayName },
                    );
                } catch (pdfErr) {
                }
                await sendAssetCreationApprovalEmail({
                    asset,
                    recipient: assetController,
                    creatorName: requesterDisplayName,
                    attachments: submitAttachments
                });
            } catch (err) {
            }
        }

        return res.status(200).json(asset);
    } catch (error) {
        return res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

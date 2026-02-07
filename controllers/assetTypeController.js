import AssetType from '../models/AssetType.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetItem from '../models/AssetItem.js';
import mongoose from 'mongoose';
import { uploadDocumentToS3, getSignedFileUrl } from '../utils/s3Upload.js';

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
            mode, category, type, name, assetValue, purchaseDate, quantity, warranty, warrantyYears, warrantyAttachment, invoiceNumber, imagePreview, description, invoiceFile, accessories
        } = req.body;

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
            if (!type || !name || !assetValue) {
                return res.status(400).json({ message: 'Name, Type, and Value are required' });
            }

            // Find type
            const t = await AssetType.findOne({ name: type });
            if (!t) return res.status(400).json({ message: 'Selected Type not found.' });

            // Find category provided in request
            let catId = null;
            if (category) {
                const cat = await AssetCategory.findOne({ name: category });
                if (cat) catId = cat._id;
            }

            if (!catId) {
                return res.status(400).json({ message: 'Valid Category is required for individual assets.' });
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
                    accessories: formattedAccessories
                };

                const newAsset = await AssetItem.create(assetData);
                createdAssets.push(newAsset.toObject());
            }

            // Prepare the first asset for the response (same as before)
            const assetObj = createdAssets[0];
            if (assetObj.imagePreview) {
                assetObj.imagePreview = await getSignedFileUrl(assetObj.imagePreview);
            }
            if (assetObj.invoiceFile) {
                assetObj.invoiceFile = await getSignedFileUrl(assetObj.invoiceFile);
            }
            if (assetObj.warrantyAttachment) {
                assetObj.warrantyAttachment = await getSignedFileUrl(assetObj.warrantyAttachment);
            }

            // Sign accessory attachments for the returned object
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
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
        const assets = await AssetItem.find()
            .populate('typeId')
            .populate('categoryId')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department primaryReportee reportingAuthority',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName' },
                    { path: 'reportingAuthority', select: 'firstName lastName' }
                ]
            });

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
                accessories: await Promise.all((a.accessories || []).map(async (acc) => {
                    const accObj = acc.toObject ? acc.toObject() : acc;
                    return {
                        ...accObj,
                        attachment: accObj.attachment ? await getSignedFileUrl(accObj.attachment) : null
                    };
                })),
                assignedTo: a.assignedTo
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
            // Assets might not need soft delete if they are individual items, 
            // but let's be consistent or just remove for individual assets?
            // Usually assets are deleted permanently or marked 'Lost'.
            // Let's just remove them for now to keep it simple or mark status 'Deleted'
            await AssetItem.findByIdAndDelete(id);
            return res.status(200).json({ message: 'Asset deleted' });
        }

        res.status(404).json({ message: 'Item not found' });
    } catch (error) {
        console.error('Error deleting asset entity:', error);
        res.status(500).json({ message: 'Server Error' });
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

        // Determine what we are updating. For now assuming AssetItem as that's where accessories are.
        // We can add logic for Type/Category if needed later.

        let asset = await AssetItem.findById(id);
        if (!asset) {
            // Fallback to check if it's a Type or Category if we expand this
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Apply updates
        for (const key of Object.keys(updates)) {
            // Prevent updating immutable fields
            if (key !== '_id' && key !== 'assetId') {
                if (key === 'accessories' && Array.isArray(updates[key])) {
                    // Re-calculate accessory IDs based on position
                    asset[key] = updates[key].map((acc, index) => ({
                        ...acc,
                        accessoryId: generateAccessoryId(asset.assetId, index)
                    }));
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
                    asset[key] = updates[key];
                }
            }
        }

        await asset.save();

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

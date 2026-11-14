import mongoose from 'mongoose';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import { httpError, idStrings, nameKey, optionalImagePatch, readImage, requireName, sendError } from './http.js';

function presentCategory(row, subcategoryCount, stats) {
    const brandIds = idStrings(stats?.brandIds);
    return {
        _id: row._id,
        name: row.name,
        imageName: row.imageName || '',
        subcategoryCount: subcategoryCount || 0,
        brandIds,
        brandCount: brandIds.length,
        itemCount: stats?.itemCount || 0,
    };
}

export async function listCategories(_req, res) {
    try {
        const [categories, subcategoryCounts, itemStats] = await Promise.all([
            ItemCategory.find().select('name imageName').sort({ name: 1 }).lean(),
            ItemSubcategory.aggregate([
                { $match: { categoryId: { $exists: true, $ne: null } } },
                { $group: { _id: '$categoryId', count: { $sum: 1 } } },
            ]),
            InventoryItem.aggregate([
                {
                    $group: {
                        _id: '$categoryId',
                        itemCount: { $sum: 1 },
                        brandIds: { $addToSet: '$brandId' },
                    },
                },
            ]),
        ]);
        const subcategoryMap = new Map(subcategoryCounts.map((row) => [String(row._id), row.count]));
        const itemMap = new Map(itemStats.map((row) => [String(row._id), row]));
        res.json(categories.map((row) => presentCategory(
            row,
            subcategoryMap.get(String(row._id)),
            itemMap.get(String(row._id)),
        )));
    } catch (error) {
        sendError(res, error);
    }
}

export async function createCategory(req, res) {
    try {
        const name = requireName(req.body?.name, 'Category name');
        const image = readImage(req.body?.image, { required: false });
        const category = await ItemCategory.create({
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
        });
        res.status(201).json(presentCategory(category, 0, null));
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateCategory(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Category was not found.');
        const name = requireName(req.body?.name, 'Category name');
        const category = await ItemCategory.findByIdAndUpdate(req.params.id, {
            name,
            nameKey: nameKey(name),
            ...optionalImagePatch(req.body),
        }, { new: true, runValidators: true });
        if (!category) throw httpError(404, 'Category was not found.');
        res.json(presentCategory(category, 0, null));
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteCategory(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Category was not found.');
        const category = await ItemCategory.findById(req.params.id).select('_id');
        if (!category) throw httpError(404, 'Category was not found.');
        if (await ItemSubcategory.exists({ categoryId: req.params.id })) {
            throw httpError(400, 'Delete the subcategories in this category first.');
        }
        if (await InventoryItem.exists({ categoryId: req.params.id })) {
            throw httpError(400, 'Delete the items in this category first.');
        }
        if (await InventoryVendorContact.exists({ 'lines.categoryId': req.params.id })) {
            throw httpError(400, 'This category is used by a vendor. Remove it there first.');
        }
        await ItemCategory.deleteOne({ _id: req.params.id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

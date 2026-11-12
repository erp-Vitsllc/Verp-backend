import mongoose from 'mongoose';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { distinctCount, httpError, nameKey, readImage, requireName, sendError } from './http.js';

function presentSubcategory(row, stats) {
    const categoryIds = [
        ...(row.categoryId ? [row.categoryId] : []),
        ...(stats?.categoryIds || []),
    ];
    return {
        _id: row._id,
        name: row.name,
        categoryId: row.categoryId ? String(row.categoryId) : '',
        imageName: row.imageName || '',
        categoryCount: distinctCount(categoryIds),
        brandCount: distinctCount(stats?.brandIds),
        itemCount: stats?.itemCount || 0,
    };
}

export async function listSubcategories(req, res) {
    try {
        const filter = {};
        if (req.query.categoryId) {
            if (!mongoose.isValidObjectId(req.query.categoryId)) {
                throw httpError(400, 'Category was not found.');
            }
            filter.categoryId = req.query.categoryId;
        }
        const rows = await ItemSubcategory.find(filter)
            .select('name categoryId imageName')
            .sort({ name: 1 })
            .lean();
        const ids = rows.map((row) => row._id);
        const itemStats = ids.length
            ? await InventoryItem.aggregate([
                { $match: { subcategoryId: { $in: ids } } },
                {
                    $group: {
                        _id: '$subcategoryId',
                        itemCount: { $sum: 1 },
                        brandIds: { $addToSet: '$brandId' },
                        categoryIds: { $addToSet: '$categoryId' },
                    },
                },
            ])
            : [];
        const itemMap = new Map(itemStats.map((row) => [String(row._id), row]));
        res.json(rows.map((row) => presentSubcategory(row, itemMap.get(String(row._id)))));
    } catch (error) {
        sendError(res, error);
    }
}

export async function createSubcategory(req, res) {
    try {
        const name = requireName(req.body?.name, 'Subcategory name');
        const categoryId = req.body?.categoryId;
        if (!categoryId || !mongoose.isValidObjectId(categoryId)) {
            throw httpError(400, 'Category is required.');
        }
        const category = await ItemCategory.findById(categoryId).select('_id');
        if (!category) throw httpError(400, 'Category was not found.');
        const image = readImage(req.body?.image, { required: false });
        const row = await ItemSubcategory.create({
            categoryId,
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
        });
        res.status(201).json(presentSubcategory(row, null));
    } catch (error) {
        sendError(res, error);
    }
}

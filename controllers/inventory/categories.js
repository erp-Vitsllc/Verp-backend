import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { distinctCount, nameKey, readImage, requireName, sendError } from './http.js';

function presentCategory(row, subcategoryCount, stats) {
    return {
        _id: row._id,
        name: row.name,
        imageName: row.imageName || '',
        subcategoryCount: subcategoryCount || 0,
        brandCount: distinctCount(stats?.brandIds),
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

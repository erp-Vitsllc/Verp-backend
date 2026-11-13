import ItemBrand from '../../models/inventory/ItemBrand.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { idStrings, nameKey, readImage, requireName, sendError } from './http.js';

function presentBrand(row, stats) {
    const categoryIds = idStrings(stats?.categoryIds);
    const subcategoryIds = idStrings(stats?.subcategoryIds);
    return {
        _id: row._id,
        name: row.name,
        imageName: row.imageName || '',
        categoryIds,
        categoryCount: categoryIds.length,
        subcategoryIds,
        subcategoryCount: subcategoryIds.length,
        itemCount: stats?.itemCount || 0,
    };
}

export async function listBrands(_req, res) {
    try {
        const [brands, itemStats] = await Promise.all([
            ItemBrand.find().select('name imageName').sort({ name: 1 }).lean(),
            InventoryItem.aggregate([
                {
                    $group: {
                        _id: '$brandId',
                        itemCount: { $sum: 1 },
                        categoryIds: { $addToSet: '$categoryId' },
                        subcategoryIds: { $addToSet: '$subcategoryId' },
                    },
                },
            ]),
        ]);
        const itemMap = new Map(itemStats.map((row) => [String(row._id), row]));
        res.json(brands.map((row) => presentBrand(row, itemMap.get(String(row._id)))));
    } catch (error) {
        sendError(res, error);
    }
}

export async function createBrand(req, res) {
    try {
        const name = requireName(req.body?.name, 'Brand name');
        const image = readImage(req.body?.image, { required: false });
        const brand = await ItemBrand.create({
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
        });
        res.status(201).json(presentBrand(brand, null));
    } catch (error) {
        sendError(res, error);
    }
}

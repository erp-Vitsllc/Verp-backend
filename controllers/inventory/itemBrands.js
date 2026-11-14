import mongoose from 'mongoose';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import { httpError, idStrings, nameKey, optionalImagePatch, readImage, requireName, sendError } from './http.js';

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

export async function updateBrand(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Brand was not found.');
        const name = requireName(req.body?.name, 'Brand name');
        const brand = await ItemBrand.findByIdAndUpdate(req.params.id, {
            name,
            nameKey: nameKey(name),
            ...optionalImagePatch(req.body),
        }, { new: true, runValidators: true });
        if (!brand) throw httpError(404, 'Brand was not found.');
        res.json(presentBrand(brand, null));
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteBrand(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Brand was not found.');
        const brand = await ItemBrand.findById(req.params.id).select('_id');
        if (!brand) throw httpError(404, 'Brand was not found.');
        if (await InventoryItem.exists({ brandId: req.params.id })) {
            throw httpError(400, 'Delete the items that use this brand first.');
        }
        if (await InventoryVendorContact.exists({ 'lines.brandId': req.params.id })) {
            throw httpError(400, 'This brand is used by a vendor. Remove it there first.');
        }
        await ItemBrand.deleteOne({ _id: req.params.id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

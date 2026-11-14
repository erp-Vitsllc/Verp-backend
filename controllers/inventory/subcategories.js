import mongoose from 'mongoose';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import ItemOption from '../../models/inventory/ItemOption.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { httpError, idStrings, nameKey, optionalImagePatch, readImage, requireName, sendError } from './http.js';

function readReservationQuantity(value) {
    if (value == null || value === '') return null;
    const count = Number(value);
    if (!Number.isInteger(count) || count < 0) {
        throw httpError(400, 'Enter a whole reservation count of zero or more.');
    }
    return count;
}

function presentSubcategory(row, stats) {
    const categoryIds = idStrings([
        ...(row.categoryId ? [row.categoryId] : []),
        ...(stats?.categoryIds || []),
    ]);
    const brandIds = idStrings(stats?.brandIds);
    return {
        _id: row._id,
        name: row.name,
        categoryId: row.categoryId ? String(row.categoryId) : '',
        imageName: row.imageName || '',
        reservationQuantity: row.reservationQuantity == null ? null : row.reservationQuantity,
        categoryIds,
        categoryCount: categoryIds.length,
        brandIds,
        brandCount: brandIds.length,
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
            .select('name categoryId imageName reservationQuantity')
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
        const reservationQuantity = readReservationQuantity(req.body?.reservationQuantity);
        const row = await ItemSubcategory.create({
            categoryId,
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
            reservationQuantity,
        });
        res.status(201).json(presentSubcategory(row, null));
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateSubcategory(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Subcategory was not found.');
        const name = requireName(req.body?.name, 'Subcategory name');
        const categoryId = req.body?.categoryId;
        if (!categoryId || !mongoose.isValidObjectId(categoryId)) {
            throw httpError(400, 'Category is required.');
        }
        const category = await ItemCategory.findById(categoryId).select('_id');
        if (!category) throw httpError(400, 'Category was not found.');
        const reservationQuantity = readReservationQuantity(req.body?.reservationQuantity);
        const row = await ItemSubcategory.findByIdAndUpdate(req.params.id, {
            categoryId,
            name,
            nameKey: nameKey(name),
            reservationQuantity,
            ...optionalImagePatch(req.body),
        }, { new: true, runValidators: true });
        if (!row) throw httpError(404, 'Subcategory was not found.');
        res.json(presentSubcategory(row, null));
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteSubcategory(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Subcategory was not found.');
        const row = await ItemSubcategory.findById(req.params.id).select('_id');
        if (!row) throw httpError(404, 'Subcategory was not found.');
        if (await InventoryItem.exists({ subcategoryId: req.params.id })) {
            throw httpError(400, 'Delete the items in this subcategory first.');
        }
        await ItemOption.deleteMany({ subcategoryId: req.params.id });
        await ItemSubcategory.deleteOne({ _id: req.params.id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

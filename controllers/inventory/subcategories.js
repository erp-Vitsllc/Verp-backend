import mongoose from 'mongoose';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import { cleanName, nameKey, httpError, sendError, readImage } from './http.js';

export async function listSubcategories(req, res) {
    try {
        const filter = {};
        if (req.query.categoryId) filter.categoryId = req.query.categoryId;
        const rows = await ItemSubcategory.find(filter)
            .select('-imageData')
            .sort({ name: 1 })
            .lean();
        res.json(rows);
    } catch (error) {
        sendError(res, error);
    }
}

export async function createSubcategory(req, res) {
    try {
        const name = cleanName(req.body?.name);
        const categoryId = req.body?.categoryId;
        if (!name) throw httpError(400, 'Subcategory name is required.');
        if (!categoryId || !mongoose.isValidObjectId(categoryId)) throw httpError(400, 'Category is required.');
        const category = await ItemCategory.findById(categoryId).select('_id');
        if (!category) throw httpError(400, 'Category was not found.');
        const image = readImage(req.body?.image, { required: true });
        const row = await ItemSubcategory.create({
            categoryId,
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
        });
        res.status(201).json({
            _id: row._id,
            categoryId: row.categoryId,
            name: row.name,
            imageName: row.imageName,
        });
    } catch (error) {
        sendError(res, error);
    }
}

import mongoose from 'mongoose';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import ItemOption from '../../models/inventory/ItemOption.js';
import { cleanName, nameKey, httpError, sendError } from './http.js';

export async function listItemOptions(req, res) {
    try {
        const filter = {};
        if (req.query.subcategoryId) filter.subcategoryId = req.query.subcategoryId;
        const rows = await ItemOption.find(filter).sort({ name: 1 }).lean();
        res.json(rows);
    } catch (error) {
        sendError(res, error);
    }
}

export async function createItemOption(req, res) {
    try {
        const name = cleanName(req.body?.name);
        const subcategoryId = req.body?.subcategoryId;
        if (!name) throw httpError(400, 'Item name is required.');
        if (!subcategoryId || !mongoose.isValidObjectId(subcategoryId)) throw httpError(400, 'Subcategory is required.');
        const subcategory = await ItemSubcategory.findById(subcategoryId).select('_id');
        if (!subcategory) throw httpError(400, 'Subcategory was not found.');
        const row = await ItemOption.create({
            subcategoryId,
            name,
            nameKey: nameKey(name),
        });
        res.status(201).json(row);
    } catch (error) {
        sendError(res, error);
    }
}

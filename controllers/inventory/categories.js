import ItemCategory from '../../models/inventory/ItemCategory.js';
import { cleanName, nameKey, httpError, sendError } from './http.js';

export async function listCategories(_req, res) {
    try {
        const categories = await ItemCategory.find().sort({ name: 1 }).lean();
        res.json(categories);
    } catch (error) {
        sendError(res, error);
    }
}

export async function createCategory(req, res) {
    try {
        const name = cleanName(req.body?.name);
        if (!name) throw httpError(400, 'Category type is required.');
        const category = await ItemCategory.create({ name, nameKey: nameKey(name) });
        res.status(201).json(category);
    } catch (error) {
        sendError(res, error);
    }
}

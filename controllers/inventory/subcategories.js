import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import { cleanName, nameKey, httpError, sendError, readImage } from './http.js';

export async function listSubcategories(req, res) {
    try {
        const rows = await ItemSubcategory.find({})
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
        if (!name) throw httpError(400, 'Subcategory name is required.');
        const image = readImage(req.body?.image, { required: true });
        const row = await ItemSubcategory.create({
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
        });
        res.status(201).json({
            _id: row._id,
            name: row.name,
            imageName: row.imageName,
        });
    } catch (error) {
        sendError(res, error);
    }
}

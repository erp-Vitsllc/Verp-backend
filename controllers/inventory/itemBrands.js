import ItemBrand from '../../models/inventory/ItemBrand.js';
import { cleanName, nameKey, sendError, readImage, httpError } from './http.js';

export async function listBrands(_req, res) {
    try {
        const brands = await ItemBrand.find().select('-imageData').sort({ name: 1 }).lean();
        res.json(brands);
    } catch (error) {
        sendError(res, error);
    }
}

export async function createBrand(req, res) {
    try {
        const name = cleanName(req.body?.name);
        if (!name) throw httpError(400, 'Brand name is required.');
        const image = readImage(req.body?.image, { required: false });
        const brand = await ItemBrand.create({
            name,
            nameKey: nameKey(name),
            imageData: image.imageData,
            imageName: image.imageName,
        });
        res.status(201).json({
            _id: brand._id,
            name: brand.name,
            imageName: brand.imageName,
        });
    } catch (error) {
        sendError(res, error);
    }
}

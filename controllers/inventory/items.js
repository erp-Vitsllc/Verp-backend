import mongoose from 'mongoose';
import InventoryItem, { INVENTORY_UNITS, INVENTORY_STATUSES } from '../../models/inventory/InventoryItem.js';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import ItemOption from '../../models/inventory/ItemOption.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import { escapeRegex } from '../../utils/regexHelper.js';
import { cleanName, httpError, sendError } from './http.js';

const ITEM_POPULATE = [
    { path: 'categoryId', select: 'name' },
    { path: 'subcategoryId', select: 'name' },
    { path: 'itemOptionId', select: 'name' },
    { path: 'brandId', select: 'name' },
];

const DETAIL_POPULATE = [
    { path: 'categoryId', select: 'name' },
    { path: 'subcategoryId', select: 'name imageData' },
    { path: 'itemOptionId', select: 'name' },
    { path: 'brandId', select: 'name' },
];

function refId(value) {
    if (!value) return '';
    if (typeof value === 'object') return String(value._id || '');
    return String(value);
}

function presentItem(row) {
    return {
        _id: row._id,
        itemCode: row.itemCode,
        description: row.description,
        modelNumber: row.modelNumber,
        unitOfMeasure: row.unitOfMeasure,
        manufacturerPartNumber: row.manufacturerPartNumber || '',
        reservationQuantity: row.reservationQuantity || 0,
        hsCode: row.hsCode || '',
        countryOfOrigin: row.countryOfOrigin || '',
        status: row.status,
        availableQuantity: row.availableQuantity || 0,
        categoryId: refId(row.categoryId),
        subcategoryId: refId(row.subcategoryId),
        itemOptionId: refId(row.itemOptionId),
        brandId: refId(row.brandId),
        categoryName: row.categoryId?.name || '',
        subcategoryName: row.subcategoryId?.name || '',
        subcategoryImage: row.subcategoryId?.imageData || '',
        itemName: row.itemOptionId?.name || '',
        brandName: row.brandId?.name || '',
    };
}

async function nextItemCode() {
    const latest = await InventoryItem.findOne().sort({ itemCode: -1 }).select('itemCode').lean();
    const current = latest ? Number(String(latest.itemCode).replace(/\D/g, '')) : 0;
    const next = Number.isFinite(current) ? current + 1 : 1;
    return `ITM-${String(next).padStart(5, '0')}`;
}

async function assertLinks({ categoryId, subcategoryId, itemOptionId, brandId }) {
    const ids = [categoryId, subcategoryId, itemOptionId, brandId];
    if (!ids.every((id) => mongoose.isValidObjectId(id))) {
        throw httpError(400, 'Category, subcategory, item, and brand are required.');
    }
    const [category, subcategory, option, brand] = await Promise.all([
        ItemCategory.findById(categoryId).select('_id'),
        ItemSubcategory.findById(subcategoryId).select('_id categoryId'),
        ItemOption.findById(itemOptionId).select('subcategoryId'),
        ItemBrand.findById(brandId).select('_id'),
    ]);
    if (!category) throw httpError(400, 'Category was not found.');
    if (!subcategory) throw httpError(400, 'Subcategory was not found.');
    if (subcategory.categoryId && String(subcategory.categoryId) !== String(categoryId)) {
        throw httpError(400, 'Subcategory does not belong to the selected category.');
    }
    if (!option || String(option.subcategoryId) !== String(subcategoryId)) {
        throw httpError(400, 'Item does not belong to the selected subcategory.');
    }
    if (!brand) throw httpError(400, 'Brand was not found.');
}

function readItemBody(body) {
    const description = cleanName(body?.description);
    const modelNumber = cleanName(body?.modelNumber);
    const unitOfMeasure = cleanName(body?.unitOfMeasure);
    const status = cleanName(body?.status) || 'Active';
    const reservationQuantity = Number(body?.reservationQuantity ?? 0);
    if (!body?.categoryId || !body?.subcategoryId || !body?.itemOptionId || !body?.brandId) {
        throw httpError(400, 'Category, subcategory, item, and brand are required.');
    }
    if (!description) throw httpError(400, 'Description is required.');
    if (!INVENTORY_UNITS.includes(unitOfMeasure)) throw httpError(400, 'Choose a unit of measure.');
    if (!INVENTORY_STATUSES.includes(status)) throw httpError(400, 'Choose a valid status.');
    if (!Number.isFinite(reservationQuantity) || reservationQuantity < 0) {
        throw httpError(400, 'Reservation quantity must be zero or more.');
    }
    return {
        categoryId: body.categoryId,
        subcategoryId: body.subcategoryId,
        itemOptionId: body.itemOptionId,
        brandId: body.brandId,
        description,
        modelNumber,
        unitOfMeasure,
        manufacturerPartNumber: cleanName(body?.manufacturerPartNumber),
        reservationQuantity,
        hsCode: cleanName(body?.hsCode),
        countryOfOrigin: cleanName(body?.countryOfOrigin),
        status,
    };
}

export async function listItems(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 6));
        const filter = {};
        if (req.query.categoryId && mongoose.isValidObjectId(req.query.categoryId)) {
            filter.categoryId = req.query.categoryId;
        }
        if (req.query.brandId && mongoose.isValidObjectId(req.query.brandId)) {
            filter.brandId = req.query.brandId;
        }
        if (INVENTORY_STATUSES.includes(req.query.status)) filter.status = req.query.status;
        const search = cleanName(req.query.search);
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            const [categories, brands, options] = await Promise.all([
                ItemCategory.find({ name: regex }).select('_id'),
                ItemBrand.find({ name: regex }).select('_id'),
                ItemOption.find({ name: regex }).select('_id'),
            ]);
            filter.$or = [
                { itemCode: regex },
                { description: regex },
                { modelNumber: regex },
                { manufacturerPartNumber: regex },
                { categoryId: { $in: categories.map((row) => row._id) } },
                { brandId: { $in: brands.map((row) => row._id) } },
                { itemOptionId: { $in: options.map((row) => row._id) } },
            ];
        }
        const [total, rows] = await Promise.all([
            InventoryItem.countDocuments(filter),
            InventoryItem.find(filter)
                .sort({ itemCode: 1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .populate(ITEM_POPULATE)
                .lean(),
        ]);
        res.json({
            items: rows.map(presentItem),
            total,
            page,
            limit,
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function getItem(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const row = await InventoryItem.findById(req.params.id).populate(DETAIL_POPULATE).lean();
        if (!row) throw httpError(404, 'Item was not found.');
        res.json(presentItem(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function createItem(req, res) {
    try {
        const payload = readItemBody(req.body);
        await assertLinks(payload);
        const item = await InventoryItem.create({
            ...payload,
            itemCode: await nextItemCode(),
        });
        const saved = await InventoryItem.findById(item._id).populate(ITEM_POPULATE).lean();
        res.status(201).json(presentItem(saved));
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateItem(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const payload = readItemBody(req.body);
        await assertLinks(payload);
        const saved = await InventoryItem.findByIdAndUpdate(req.params.id, payload, {
            new: true,
            runValidators: true,
        }).populate(ITEM_POPULATE).lean();
        if (!saved) throw httpError(404, 'Item was not found.');
        res.json(presentItem(saved));
    } catch (error) {
        sendError(res, error);
    }
}

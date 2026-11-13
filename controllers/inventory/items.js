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
    { path: 'subcategoryId', select: 'name reservationQuantity' },
    { path: 'itemOptionId', select: 'name' },
    { path: 'brandId', select: 'name' },
];

const DETAIL_POPULATE = [
    { path: 'categoryId', select: 'name' },
    { path: 'subcategoryId', select: 'name imageData reservationQuantity' },
    { path: 'itemOptionId', select: 'name' },
    { path: 'brandId', select: 'name' },
];

const DISPLAY_STATUSES = ['Stock In', 'Low Stock', 'Out of Stock'];
const STATUS_ORDER = {
    'Out of Stock': 0,
    'Low Stock': 1,
    'Stock In': 2,
};

/** Status comes from on-hand stock and the subcategory reservation rule. */
export function stockStatus(availableQuantity, reservationQuantity) {
    const stock = Number(availableQuantity);
    const onHand = Number.isFinite(stock) ? stock : 0;
    if (onHand === 0) return 'Out of Stock';
    if (reservationQuantity == null || reservationQuantity === '') return 'Stock In';
    const reserve = Number(reservationQuantity);
    if (!Number.isFinite(reserve)) return 'Stock In';
    if (onHand < reserve) return 'Low Stock';
    return 'Stock In';
}

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
        moreDescription: row.moreDescription || '',
        copyToDescription: Boolean(row.copyToDescription),
        modelNumber: row.modelNumber,
        unitOfMeasure: row.unitOfMeasure,
        manufacturerPartNumber: row.manufacturerPartNumber || '',
        reservationQuantity: row.reservationQuantity || 0,
        hsCode: row.hsCode || '',
        countryOfOrigin: row.countryOfOrigin || '',
        status: stockStatus(row.availableQuantity, row.subcategoryId?.reservationQuantity),
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
    if (![categoryId, subcategoryId, brandId].every((id) => mongoose.isValidObjectId(id))) {
        throw httpError(400, 'Category, subcategory, and brand are required.');
    }
    const [category, subcategory, option, brand] = await Promise.all([
        ItemCategory.findById(categoryId).select('_id'),
        ItemSubcategory.findById(subcategoryId).select('_id categoryId'),
        itemOptionId ? ItemOption.findById(itemOptionId).select('subcategoryId') : null,
        ItemBrand.findById(brandId).select('_id'),
    ]);
    if (!category) throw httpError(400, 'Category was not found.');
    if (!subcategory) throw httpError(400, 'Subcategory was not found.');
    if (subcategory.categoryId && String(subcategory.categoryId) !== String(categoryId)) {
        throw httpError(400, 'Subcategory does not belong to the selected category.');
    }
    if (itemOptionId && (!option || String(option.subcategoryId) !== String(subcategoryId))) {
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
    const hasItemOption = body != null && Object.prototype.hasOwnProperty.call(body, 'itemOptionId');
    const itemOptionId = hasItemOption ? (body.itemOptionId || null) : undefined;
    if (!body?.categoryId || !body?.subcategoryId || !body?.brandId) {
        throw httpError(400, 'Category, subcategory, and brand are required.');
    }
    if (hasItemOption && itemOptionId && !mongoose.isValidObjectId(itemOptionId)) {
        throw httpError(400, 'Item was not found.');
    }
    if (!description) throw httpError(400, 'Description is required.');
    if (!unitOfMeasure || unitOfMeasure === 'None' || !INVENTORY_UNITS.includes(unitOfMeasure)) {
        throw httpError(400, 'Choose a unit of measure.');
    }
    if (!INVENTORY_STATUSES.includes(status)) throw httpError(400, 'Choose a valid status.');
    if (!Number.isFinite(reservationQuantity) || reservationQuantity < 0) {
        throw httpError(400, 'Reservation quantity must be zero or more.');
    }
    return {
        categoryId: body.categoryId,
        subcategoryId: body.subcategoryId,
        ...(hasItemOption ? { itemOptionId } : {}),
        brandId: body.brandId,
        description,
        moreDescription: cleanName(body?.moreDescription),
        copyToDescription: body?.copyToDescription === true,
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
        if (req.query.subcategoryId && mongoose.isValidObjectId(req.query.subcategoryId)) {
            filter.subcategoryId = req.query.subcategoryId;
        }
        if (req.query.brandId && mongoose.isValidObjectId(req.query.brandId)) {
            filter.brandId = req.query.brandId;
        }
        const statusQuery = DISPLAY_STATUSES.includes(req.query.status) ? req.query.status : '';
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
        const rows = await InventoryItem.find(filter).populate(ITEM_POPULATE).lean();
        const matched = rows
            .map(presentItem)
            .filter((row) => !statusQuery || row.status === statusQuery)
            .sort((left, right) => {
                const statusGap = (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9);
                if (statusGap) return statusGap;
                return String(left.itemCode || '').localeCompare(String(right.itemCode || ''));
            });
        const start = (page - 1) * limit;
        res.json({
            items: matched.slice(start, start + limit),
            total: matched.length,
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

import mongoose from 'mongoose';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import ItemOption from '../../models/inventory/ItemOption.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import { hasPermission } from '../../services/permissionService.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';
import { cleanName, httpError, nameKey, sendError } from './http.js';
import { assertLinks, nextItemCode, stockStatus } from './items.js';

const STOCK_POPULATE = [
    { path: 'categoryId', select: 'name' },
    { path: 'subcategoryId', select: 'name reservationQuantity' },
    { path: 'itemOptionId', select: 'name' },
    { path: 'brandId', select: 'name' },
];

function refId(value) {
    if (!value) return '';
    if (typeof value === 'object') return String(value._id || '');
    return String(value);
}

function presentStockOption(row) {
    return {
        _id: row._id,
        itemCode: row.itemCode,
        description: row.description,
        modelNumber: row.modelNumber || '',
        availableQuantity: row.availableQuantity || 0,
        categoryId: refId(row.categoryId),
        subcategoryId: refId(row.subcategoryId),
        itemOptionId: refId(row.itemOptionId),
        brandId: refId(row.brandId),
        categoryName: row.categoryId?.name || '',
        subcategoryName: row.subcategoryId?.name || '',
        itemName: row.itemOptionId?.name || row.description || '',
        brandName: row.brandId?.name || '',
        lastStockPrice: row.lastStockPrice || 0,
    };
}

function readAmount(value, label) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) {
        throw httpError(400, `${label} must be a valid amount.`);
    }
    return Math.round(amount * 100) / 100;
}

function sameRef(left, right) {
    return String(left || '') === String(right || '');
}

function readIdentity(body, source) {
    const readId = (key, label, fallback) => {
        if (body && Object.prototype.hasOwnProperty.call(body, key)) {
            const value = String(body[key] || '');
            if (!mongoose.isValidObjectId(value)) throw httpError(400, `${label} is required.`);
            return value;
        }
        return String(fallback || '');
    };
    const modelNumber = body && Object.prototype.hasOwnProperty.call(body, 'modelNumber')
        ? cleanName(body.modelNumber)
        : cleanName(source.modelNumber);
    return {
        categoryId: readId('categoryId', 'Category', source.categoryId),
        subcategoryId: readId('subcategoryId', 'Sub category', source.subcategoryId),
        brandId: readId('brandId', 'Brand', source.brandId),
        modelNumber,
    };
}

function sameIdentity(identity, source) {
    return sameRef(identity.categoryId, source.categoryId)
        && sameRef(identity.subcategoryId, source.subcategoryId)
        && sameRef(identity.brandId, source.brandId)
        && identity.modelNumber === cleanName(source.modelNumber);
}

async function canCreateItem(req) {
    if (await isReqUserSystemSuperUser(req.user)) return true;
    if (!req.user?.id) return false;
    return hasPermission(req.user.id, 'inventory_item_master', 'create');
}

async function resolveItemOption(source, subcategoryId) {
    if (!source.itemOptionId) return { id: null, name: '' };
    const option = await ItemOption.findById(source.itemOptionId).select('name nameKey subcategoryId').lean();
    if (!option) return { id: null, name: '' };
    if (sameRef(option.subcategoryId, subcategoryId)) return { id: option._id, name: option.name || '' };
    const match = await ItemOption.findOne({
        subcategoryId,
        nameKey: option.nameKey || nameKey(option.name),
    }).select('name').lean();
    if (match) return { id: match._id, name: match.name || option.name || '' };
    return { id: null, name: option.name || '' };
}

function buildDescription({ brandName, subcategoryName, itemName, modelNumber, manufacturerPartNumber, moreDescription, copyToDescription }) {
    const main = [brandName, subcategoryName, itemName, modelNumber, manufacturerPartNumber]
        .map((part) => cleanName(part))
        .filter(Boolean)
        .join(' ');
    const extra = copyToDescription ? cleanName(moreDescription) : '';
    const description = [main, extra].filter(Boolean).join(' ');
    if (!description) throw httpError(400, 'Description is required.');
    return description;
}

async function createStockItem(source, identity, quantity, price) {
    const [brand, subcategory, itemOption] = await Promise.all([
        ItemBrand.findById(identity.brandId).select('name').lean(),
        ItemSubcategory.findById(identity.subcategoryId).select('name').lean(),
        resolveItemOption(source, identity.subcategoryId),
    ]);
    const description = buildDescription({
        brandName: brand?.name,
        subcategoryName: subcategory?.name,
        itemName: itemOption.name,
        modelNumber: identity.modelNumber,
        manufacturerPartNumber: source.manufacturerPartNumber,
        moreDescription: source.moreDescription,
        copyToDescription: source.copyToDescription,
    });
    await assertLinks({
        categoryId: identity.categoryId,
        subcategoryId: identity.subcategoryId,
        itemOptionId: itemOption.id,
        brandId: identity.brandId,
    });
    const created = await InventoryItem.create({
        itemCode: await nextItemCode(),
        categoryId: identity.categoryId,
        subcategoryId: identity.subcategoryId,
        itemOptionId: itemOption.id,
        brandId: identity.brandId,
        description,
        moreDescription: source.moreDescription || '',
        copyToDescription: Boolean(source.copyToDescription),
        modelNumber: identity.modelNumber,
        unitOfMeasure: source.unitOfMeasure,
        manufacturerPartNumber: source.manufacturerPartNumber || '',
        reservationQuantity: source.reservationQuantity || 0,
        hsCode: source.hsCode || '',
        countryOfOrigin: source.countryOfOrigin || '',
        status: source.status || 'Active',
        availableQuantity: quantity,
        lastStockPrice: price,
    });
    return InventoryItem.findById(created._id).populate(STOCK_POPULATE).lean();
}

export async function listStockOptions(_req, res) {
    try {
        const rows = await InventoryItem.find()
            .select('itemCode description modelNumber availableQuantity categoryId subcategoryId itemOptionId brandId lastStockPrice')
            .populate(STOCK_POPULATE)
            .sort({ itemCode: 1 })
            .lean();
        res.json({ items: rows.map(presentStockOption) });
    } catch (error) {
        sendError(res, error);
    }
}

export async function addItemStock(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const quantity = readAmount(req.body?.quantity, 'Quantity');
        const price = readAmount(req.body?.price, 'Price');
        if (quantity <= 0) throw httpError(400, 'Quantity must be greater than zero.');
        const source = await InventoryItem.findById(req.params.id).lean();
        if (!source) throw httpError(404, 'Item was not found.');
        const identity = readIdentity(req.body, source);
        if (sameIdentity(identity, source)) {
            const saved = await InventoryItem.findByIdAndUpdate(
                source._id,
                { $inc: { availableQuantity: quantity }, $set: { lastStockPrice: price } },
                { new: true, runValidators: true },
            ).populate(STOCK_POPULATE).lean();
            if (!saved) throw httpError(404, 'Item was not found.');
            res.json({
                ...presentStockOption(saved),
                status: stockStatus(saved.availableQuantity, saved.subcategoryId?.reservationQuantity),
                created: false,
            });
            return;
        }
        // Different category, subcategory, brand, or model starts a new item.
        // The selected item keeps its stock and its saved details.
        if (!(await canCreateItem(req))) {
            throw httpError(403, 'Item create permission is required when category, sub category, brand, or model no differs from the selected item.');
        }
        const saved = await createStockItem(source, identity, quantity, price);
        res.status(201).json({
            ...presentStockOption(saved),
            status: stockStatus(saved.availableQuantity, saved.subcategoryId?.reservationQuantity),
            created: true,
        });
    } catch (error) {
        sendError(res, error);
    }
}

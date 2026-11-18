import mongoose from 'mongoose';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import ItemOption from '../../models/inventory/ItemOption.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import { hasPermission } from '../../services/permissionService.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';
import { cleanName, httpError, nameKey, requireName, sendError } from './http.js';
import { assertLinks, assertModelNumberAvailable, nextItemCode, stockStatus } from './items.js';

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
        pendingStock: Boolean(row.pendingStock),
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

async function ensureItemOption(subcategoryId, itemName) {
    const key = nameKey(itemName);
    const found = await ItemOption.findOne({ subcategoryId, nameKey: key });
    if (found) return found;
    try {
        return await ItemOption.create({ subcategoryId, name: itemName, nameKey: key });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const again = await ItemOption.findOne({ subcategoryId, nameKey: key });
        if (again) return again;
        throw error;
    }
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

function buildDescription({ brandName, itemName, modelNumber, subcategoryName }) {
    const description = [brandName, itemName, modelNumber, subcategoryName]
        .map((part) => cleanName(part))
        .filter(Boolean)
        .join(' ');
    if (!description) throw httpError(400, 'Description is required.');
    return description;
}

async function createStockItem(source, identity, quantity, price) {
    const [brand, subcategory, itemOption] = await Promise.all([
        ItemBrand.findById(identity.brandId).select('name').lean(),
        ItemSubcategory.findById(identity.subcategoryId).select('name').lean(),
        resolveItemOption(source, identity.subcategoryId),
    ]);
    const itemName = cleanName(itemOption.name) || cleanName(source.description);
    const modelNumber = cleanName(identity.modelNumber) || itemName;
    const description = buildDescription({
        brandName: brand?.name,
        itemName,
        modelNumber,
        subcategoryName: subcategory?.name,
    });
    await assertModelNumberAvailable(modelNumber);
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
        modelNumber,
        unitOfMeasure: source.unitOfMeasure,
        manufacturerPartNumber: source.manufacturerPartNumber || '',
        reservationQuantity: source.reservationQuantity || 0,
        hsCode: source.hsCode || '',
        countryOfOrigin: source.countryOfOrigin || '',
        status: source.status || 'Active',
        availableQuantity: quantity,
        lastStockPrice: price,
        pendingStock: false,
    });
    return InventoryItem.findById(created._id).populate(STOCK_POPULATE).lean();
}

async function optionForIdentity(source, subcategoryId) {
    const resolved = await resolveItemOption(source, subcategoryId);
    if (resolved.id) return resolved;
    const name = cleanName(resolved.name);
    if (!name) return { id: null, name: '' };
    const option = await ensureItemOption(subcategoryId, name);
    return { id: option._id, name: option.name || name };
}

async function finalizePendingItem(source, identity, quantity, price) {
    const itemOption = await optionForIdentity(source, identity.subcategoryId);
    const itemName = cleanName(itemOption.name) || cleanName(source.description);
    const modelNumber = cleanName(identity.modelNumber) || itemName;
    const [brand, subcategory] = await Promise.all([
        ItemBrand.findById(identity.brandId).select('name').lean(),
        ItemSubcategory.findById(identity.subcategoryId).select('name').lean(),
    ]);
    const description = buildDescription({
        brandName: brand?.name,
        itemName,
        modelNumber,
        subcategoryName: subcategory?.name,
    });
    await assertModelNumberAvailable(modelNumber, source._id);
    await assertLinks({
        categoryId: identity.categoryId,
        subcategoryId: identity.subcategoryId,
        itemOptionId: itemOption.id,
        brandId: identity.brandId,
    });
    const saved = await InventoryItem.findByIdAndUpdate(
        source._id,
        {
            $set: {
                categoryId: identity.categoryId,
                subcategoryId: identity.subcategoryId,
                brandId: identity.brandId,
                itemOptionId: itemOption.id,
                modelNumber,
                description,
                pendingStock: false,
                lastStockPrice: price,
            },
            $inc: { availableQuantity: quantity },
        },
        { new: true, runValidators: true },
    ).populate(STOCK_POPULATE).lean();
    if (!saved) throw httpError(404, 'Item was not found.');
    return saved;
}

export async function createPendingItem(req, res) {
    try {
        const categoryId = String(req.body?.categoryId || '');
        const subcategoryId = String(req.body?.subcategoryId || '');
        const brandId = String(req.body?.brandId || '');
        const itemName = requireName(req.body?.itemName, 'Item');
        const modelNumber = cleanName(req.body?.modelNumber);
        const requestedId = String(req.body?.itemId || '');
        await assertLinks({ categoryId, subcategoryId, brandId });
        const option = await ensureItemOption(subcategoryId, itemName);
        const [brand, subcategory] = await Promise.all([
            ItemBrand.findById(brandId).select('name').lean(),
            ItemSubcategory.findById(subcategoryId).select('name').lean(),
        ]);
        const description = buildDescription({
            brandName: brand?.name,
            itemName,
            modelNumber,
            subcategoryName: subcategory?.name,
        });
        if (requestedId && mongoose.isValidObjectId(requestedId) && modelNumber) {
            const current = await InventoryItem.findById(requestedId);
            if (current?.pendingStock && !cleanName(current.modelNumber)) {
                await assertModelNumberAvailable(modelNumber, current._id);
                current.categoryId = categoryId;
                current.subcategoryId = subcategoryId;
                current.brandId = brandId;
                current.itemOptionId = option._id;
                current.modelNumber = modelNumber;
                current.description = description;
                await current.save();
                const saved = await InventoryItem.findById(current._id).populate(STOCK_POPULATE).lean();
                res.json(presentStockOption(saved));
                return;
            }
        }
        if (modelNumber) await assertModelNumberAvailable(modelNumber);
        const duplicate = await InventoryItem.findOne({
            pendingStock: true,
            categoryId,
            subcategoryId,
            brandId,
            itemOptionId: option._id,
            modelNumber,
        }).populate(STOCK_POPULATE).lean();
        if (duplicate) {
            res.json(presentStockOption(duplicate));
            return;
        }
        const created = await InventoryItem.create({
            itemCode: await nextItemCode(),
            categoryId,
            subcategoryId,
            itemOptionId: option._id,
            brandId,
            description,
            modelNumber,
            unitOfMeasure: 'Quantity',
            status: 'Active',
            availableQuantity: 0,
            pendingStock: true,
        });
        const saved = await InventoryItem.findById(created._id).populate(STOCK_POPULATE).lean();
        res.status(201).json(presentStockOption(saved));
    } catch (error) {
        sendError(res, error);
    }
}

export async function listStockOptions(_req, res) {
    try {
        const rows = await InventoryItem.find()
            .select('itemCode description modelNumber availableQuantity categoryId subcategoryId itemOptionId brandId lastStockPrice pendingStock')
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
        if (source.pendingStock) {
            const saved = await finalizePendingItem(source, identity, quantity, price);
            res.json({
                ...presentStockOption(saved),
                status: stockStatus(saved.availableQuantity, saved.subcategoryId?.reservationQuantity),
                created: true,
                pendingStock: false,
            });
            return;
        }
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
        // Different category, subcategory, brand, item, or model starts a new item.
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

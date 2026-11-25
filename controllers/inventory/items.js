import mongoose from 'mongoose';
import InventoryItem, { INVENTORY_UNITS, INVENTORY_STATUSES } from '../../models/inventory/InventoryItem.js';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import ItemOption from '../../models/inventory/ItemOption.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import InventoryStockEntry from '../../models/inventory/InventoryStockEntry.js';
import DeliveryOrder from '../../models/inventory/DeliveryOrder.js';
import { escapeRegex } from '../../utils/regexHelper.js';
import { cleanName, httpError, listLimit, nameKey, requireName, sendError } from './http.js';

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
        lastStockPrice: Number(row.lastStockPrice) || 0,
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

export async function nextItemCode() {
    const latest = await InventoryItem.findOne().sort({ itemCode: -1 }).select('itemCode').lean();
    const current = latest ? Number(String(latest.itemCode).replace(/\D/g, '')) : 0;
    const next = Number.isFinite(current) ? current + 1 : 1;
    return `ITM-${String(next).padStart(5, '0')}`;
}

export async function assertModelNumberAvailable(modelNumber, exceptId = '') {
    const model = cleanName(modelNumber);
    if (!model) return;
    const rows = await InventoryItem.find({
        modelNumber: new RegExp(`^${escapeRegex(model)}$`, 'i'),
    }).select('_id modelNumber').lean();
    const conflict = rows.some((row) => cleanName(row.modelNumber) && String(row._id) !== String(exceptId || ''));
    if (conflict) throw httpError(400, `This model no "${model}" is already used on another item.`);
}

export async function assertLinks({ categoryId, subcategoryId, itemOptionId, brandId }) {
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

function buildStoredDescription({ brandName, itemName, modelNumber, subcategoryName }) {
    const description = [brandName, itemName, modelNumber, subcategoryName]
        .map((part) => cleanName(part))
        .filter(Boolean)
        .join(' ');
    if (!description) throw httpError(400, 'Item name is required.');
    return description;
}

function modelQuery(modelNumber) {
    const model = cleanName(modelNumber);
    if (!model) return { $in: ['', null] };
    return new RegExp(`^${escapeRegex(model)}$`, 'i');
}

async function findOrCreateNamed(Model, name, extra = {}) {
    const key = nameKey(name);
    const found = await Model.findOne({ nameKey: key, ...extra });
    if (found) return found;
    try {
        return await Model.create({ name, nameKey: key, ...extra });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const again = await Model.findOne({ nameKey: key, ...extra });
        if (again) return again;
        throw error;
    }
}

async function resolveCategory({ categoryId, categoryName }) {
    const named = cleanName(categoryName);
    if (categoryId && mongoose.isValidObjectId(categoryId)) {
        const row = await ItemCategory.findById(categoryId);
        if (row && (!named || nameKey(row.name) === nameKey(named))) return row;
    }
    return findOrCreateNamed(ItemCategory, requireName(named, 'Category'));
}

async function resolveBrand({ brandId, brandName }) {
    const named = cleanName(brandName);
    if (brandId && mongoose.isValidObjectId(brandId)) {
        const row = await ItemBrand.findById(brandId);
        if (row && (!named || nameKey(row.name) === nameKey(named))) return row;
    }
    return findOrCreateNamed(ItemBrand, requireName(named, 'Brand'));
}

async function resolveSubcategory(categoryId, { subcategoryId, subcategoryName }) {
    const named = cleanName(subcategoryName);
    const key = named ? nameKey(named) : '';
    if (subcategoryId && mongoose.isValidObjectId(subcategoryId)) {
        const row = await ItemSubcategory.findById(subcategoryId);
        if (row && (!key || nameKey(row.name) === key)) {
            if (String(row.categoryId) !== String(categoryId)) {
                throw httpError(400, 'Sub category does not belong to the selected category.');
            }
            return row;
        }
    }
    const name = requireName(named, 'Sub category');
    const existing = await ItemSubcategory.findOne({ nameKey: nameKey(name) });
    if (existing) {
        if (String(existing.categoryId) !== String(categoryId)) {
            throw httpError(400, 'This sub category already belongs to another category.');
        }
        return existing;
    }
    try {
        return await ItemSubcategory.create({ categoryId, name, nameKey: nameKey(name) });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const again = await ItemSubcategory.findOne({ nameKey: nameKey(name) });
        if (again && String(again.categoryId) === String(categoryId)) return again;
        throw httpError(400, 'This sub category already belongs to another category.');
    }
}

async function resolveItemOption(subcategoryId, itemOptionId, itemName) {
    const named = cleanName(itemName);
    if (itemOptionId && mongoose.isValidObjectId(itemOptionId)) {
        const row = await ItemOption.findById(itemOptionId);
        if (row && String(row.subcategoryId) === String(subcategoryId) && (!named || nameKey(row.name) === nameKey(named))) {
            return row;
        }
    }
    return findOrCreateNamed(ItemOption, requireName(named, 'Item'), { subcategoryId });
}

export async function resolveItemCatalog(body) {
    const category = await resolveCategory(body || {});
    const subcategory = await resolveSubcategory(category._id, body || {});
    const brand = await resolveBrand(body || {});
    const option = await resolveItemOption(subcategory._id, body?.itemOptionId, body?.itemName);
    const modelNumber = cleanName(body?.modelNumber);
    return {
        categoryId: category._id,
        subcategoryId: subcategory._id,
        brandId: brand._id,
        itemOptionId: option._id,
        categoryName: category.name,
        subcategoryName: subcategory.name,
        brandName: brand.name,
        itemName: option.name,
        modelNumber,
        description: buildStoredDescription({
            brandName: brand.name,
            itemName: option.name,
            modelNumber,
            subcategoryName: subcategory.name,
        }),
    };
}

export async function findSameItem(catalog, exceptId = '') {
    const filter = {
        categoryId: catalog.categoryId,
        subcategoryId: catalog.subcategoryId,
        brandId: catalog.brandId,
        itemOptionId: catalog.itemOptionId,
        modelNumber: modelQuery(catalog.modelNumber),
    };
    if (exceptId && mongoose.isValidObjectId(exceptId)) filter._id = { $ne: exceptId };
    return InventoryItem.findOne(filter);
}

async function assertItemIdentityAvailable(catalog, exceptId = '') {
    if (!cleanName(catalog?.modelNumber)) return;
    const conflict = await findSameItem(catalog, exceptId);
    if (conflict) {
        throw httpError(400, 'An item with this category, sub category, item, brand, and model no already exists.');
    }
}

async function syncItemCopies(itemId, catalog) {
    const objectId = new mongoose.Types.ObjectId(String(itemId));
    const idString = String(itemId);
    const stockPatch = {
        'lines.$[line].categoryId': catalog.categoryId,
        'lines.$[line].subcategoryId': catalog.subcategoryId,
        'lines.$[line].brandId': catalog.brandId,
        'lines.$[line].modelNumber': catalog.modelNumber,
        'lines.$[line].itemName': catalog.itemName,
        'lines.$[line].description': catalog.description,
    };
    await InventoryStockEntry.updateMany(
        { 'lines.itemId': objectId },
        { $set: stockPatch },
        { arrayFilters: [{ 'line.itemId': objectId }] },
    );
    await InventoryStockEntry.updateMany(
        { 'pendingEdit.lines.itemId': objectId },
        { $set: {
            'pendingEdit.lines.$[line].categoryId': catalog.categoryId,
            'pendingEdit.lines.$[line].subcategoryId': catalog.subcategoryId,
            'pendingEdit.lines.$[line].brandId': catalog.brandId,
            'pendingEdit.lines.$[line].modelNumber': catalog.modelNumber,
            'pendingEdit.lines.$[line].itemName': catalog.itemName,
            'pendingEdit.lines.$[line].description': catalog.description,
        } },
        { arrayFilters: [{ 'line.itemId': objectId }] },
    );
    const deliveryPatch = {
        'lines.$[line].categoryId': String(catalog.categoryId),
        'lines.$[line].categoryName': catalog.categoryName,
        'lines.$[line].subcategoryId': String(catalog.subcategoryId),
        'lines.$[line].subcategoryName': catalog.subcategoryName,
        'lines.$[line].itemOptionId': String(catalog.itemOptionId),
        'lines.$[line].itemName': catalog.itemName,
        'lines.$[line].brandId': String(catalog.brandId),
        'lines.$[line].brandName': catalog.brandName,
        'lines.$[line].modelNumber': catalog.modelNumber,
        'lines.$[line].description': catalog.description,
    };
    await DeliveryOrder.updateMany(
        { 'lines.inventoryItemId': idString },
        { $set: deliveryPatch },
        { arrayFilters: [{ 'line.inventoryItemId': idString }] },
    );
    await DeliveryOrder.updateMany(
        { 'pendingEdit.lines.inventoryItemId': idString },
        { $set: {
            'pendingEdit.lines.$[line].categoryId': String(catalog.categoryId),
            'pendingEdit.lines.$[line].categoryName': catalog.categoryName,
            'pendingEdit.lines.$[line].subcategoryId': String(catalog.subcategoryId),
            'pendingEdit.lines.$[line].subcategoryName': catalog.subcategoryName,
            'pendingEdit.lines.$[line].itemOptionId': String(catalog.itemOptionId),
            'pendingEdit.lines.$[line].itemName': catalog.itemName,
            'pendingEdit.lines.$[line].brandId': String(catalog.brandId),
            'pendingEdit.lines.$[line].brandName': catalog.brandName,
            'pendingEdit.lines.$[line].modelNumber': catalog.modelNumber,
            'pendingEdit.lines.$[line].description': catalog.description,
        } },
        { arrayFilters: [{ 'line.inventoryItemId': idString }] },
    );
    await InventoryVendorContact.updateMany(
        { 'lines.itemId': objectId },
        { $set: {
            'lines.$[line].itemLabel': catalog.description,
            'lines.$[line].categoryId': catalog.categoryId,
            'lines.$[line].categoryName': catalog.categoryName,
            'lines.$[line].brandId': catalog.brandId,
            'lines.$[line].brandName': catalog.brandName,
        } },
        { arrayFilters: [{ 'line.itemId': objectId }] },
    );
}

function waitingStatus(name) {
    return `Waiting for ${String(name || '').trim() || 'Purchase Officer'}`;
}

function isWaitingStatus(status) {
    return String(status || '').startsWith('Waiting for ');
}

function statusRank(status) {
    if (isWaitingStatus(status)) return -1;
    return STATUS_ORDER[status] ?? 9;
}

async function waitingItemMap() {
    const entries = await InventoryStockEntry.find({ status: 'pending' })
        .select('lines.itemId approverName')
        .lean();
    const waiting = new Map();
    entries.forEach((entry) => {
        const label = waitingStatus(entry.approverName);
        (entry.lines || []).forEach((line) => {
            if (line.itemId) waiting.set(String(line.itemId), label);
        });
    });
    return waiting;
}

function withWaitingStatus(item, waiting) {
    const label = waiting.get(String(item._id));
    if (!label) return item;
    return { ...item, status: label };
}

function matchesStockFilter(rowStatus, statusQuery) {
    if (isWaitingStatus(rowStatus)) {
        return !statusQuery || statusQuery === 'All' || statusQuery === 'Stock In';
    }
    if (statusQuery === 'All') return true;
    if (!statusQuery || statusQuery === 'Stock In') {
        return rowStatus === 'Stock In' || rowStatus === 'Low Stock';
    }
    return rowStatus === statusQuery;
}

function readItemDetails(body) {
    const unitOfMeasure = cleanName(body?.unitOfMeasure);
    const reservationQuantity = Number(body?.reservationQuantity ?? 0);
    if (!unitOfMeasure || unitOfMeasure === 'None' || !INVENTORY_UNITS.includes(unitOfMeasure)) {
        throw httpError(400, 'Choose a unit of measure.');
    }
    if (!Number.isFinite(reservationQuantity) || reservationQuantity < 0) {
        throw httpError(400, 'Reservation quantity must be zero or more.');
    }
    const status = cleanName(body?.status);
    return {
        unitOfMeasure,
        manufacturerPartNumber: cleanName(body?.manufacturerPartNumber),
        reservationQuantity,
        hsCode: cleanName(body?.hsCode),
        countryOfOrigin: cleanName(body?.countryOfOrigin),
        ...(INVENTORY_STATUSES.includes(status) ? { status } : {}),
    };
}

export async function listItems(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = listLimit(req.query.limit);
        const waiting = await waitingItemMap();
        const waitingIds = [...waiting.keys()].filter((id) => mongoose.isValidObjectId(id));
        const constraints = [
            waitingIds.length
                ? { $or: [{ pendingStock: { $ne: true } }, { _id: { $in: waitingIds } }] }
                : { pendingStock: { $ne: true } },
        ];
        const filter = {};
        if (req.query.categoryId && mongoose.isValidObjectId(req.query.categoryId)) {
            constraints.push({ categoryId: req.query.categoryId });
        }
        if (req.query.subcategoryId && mongoose.isValidObjectId(req.query.subcategoryId)) {
            constraints.push({ subcategoryId: req.query.subcategoryId });
        }
        if (req.query.brandId && mongoose.isValidObjectId(req.query.brandId)) {
            constraints.push({ brandId: req.query.brandId });
        }
        const requestedStatus = String(req.query.status || '').trim();
        const statusQuery = requestedStatus === 'All' || DISPLAY_STATUSES.includes(requestedStatus)
            ? requestedStatus
            : '';
        const search = cleanName(req.query.search);
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            const [categories, brands, options] = await Promise.all([
                ItemCategory.find({ name: regex }).select('_id'),
                ItemBrand.find({ name: regex }).select('_id'),
                ItemOption.find({ name: regex }).select('_id'),
            ]);
            constraints.push({
                $or: [
                    { itemCode: regex },
                    { description: regex },
                    { modelNumber: regex },
                    { manufacturerPartNumber: regex },
                    { categoryId: { $in: categories.map((row) => row._id) } },
                    { brandId: { $in: brands.map((row) => row._id) } },
                    { itemOptionId: { $in: options.map((row) => row._id) } },
                ],
            });
        }
        const query = constraints.length === 1 ? constraints[0] : { $and: constraints };
        Object.assign(filter, query);
        const rows = await InventoryItem.find(filter)
            .select('itemCode description moreDescription copyToDescription modelNumber unitOfMeasure manufacturerPartNumber reservationQuantity hsCode countryOfOrigin availableQuantity lastStockPrice categoryId subcategoryId itemOptionId brandId')
            .lean();
        const subcategoryIds = [...new Set(rows.map((row) => String(row.subcategoryId || '')).filter((id) => mongoose.isValidObjectId(id)))];
        const reservationRows = subcategoryIds.length
            ? await ItemSubcategory.find({ _id: { $in: subcategoryIds } }).select('reservationQuantity').lean()
            : [];
        const reservationById = new Map(reservationRows.map((row) => [String(row._id), row.reservationQuantity]));
        const matched = rows
            .map((row) => withWaitingStatus(presentItem({
                ...row,
                subcategoryId: { _id: row.subcategoryId, reservationQuantity: reservationById.get(String(row.subcategoryId)) },
            }), waiting))
            .filter((row) => matchesStockFilter(row.status, statusQuery))
            .sort((left, right) => {
                const statusGap = statusRank(left.status) - statusRank(right.status);
                if (statusGap) return statusGap;
                return String(left.itemCode || '').localeCompare(String(right.itemCode || ''));
            });
        const start = limit > 0 ? (page - 1) * limit : 0;
        const pageRows = limit > 0 ? matched.slice(start, start + limit) : matched;
        const idsOf = (key) => [...new Set(pageRows.map((row) => row[key]).filter((id) => mongoose.isValidObjectId(id)))];
        const [categories, subcategories, options, brands] = await Promise.all([
            idsOf('categoryId').length ? ItemCategory.find({ _id: { $in: idsOf('categoryId') } }).select('name').lean() : [],
            idsOf('subcategoryId').length ? ItemSubcategory.find({ _id: { $in: idsOf('subcategoryId') } }).select('name').lean() : [],
            idsOf('itemOptionId').length ? ItemOption.find({ _id: { $in: idsOf('itemOptionId') } }).select('name').lean() : [],
            idsOf('brandId').length ? ItemBrand.find({ _id: { $in: idsOf('brandId') } }).select('name').lean() : [],
        ]);
        const nameOf = (list) => new Map(list.map((row) => [String(row._id), row.name || '']));
        const categoryNames = nameOf(categories);
        const subcategoryNames = nameOf(subcategories);
        const optionNames = nameOf(options);
        const brandNames = nameOf(brands);
        res.json({
            items: pageRows.map((row) => ({
                ...row,
                categoryName: categoryNames.get(row.categoryId) || '',
                subcategoryName: subcategoryNames.get(row.subcategoryId) || '',
                itemName: optionNames.get(row.itemOptionId) || '',
                brandName: brandNames.get(row.brandId) || '',
            })),
            total: matched.length,
            page,
            limit,
        });
    } catch (error) {
        sendError(res, error);
    }
}

async function itemMovement(itemId) {
    const objectId = new mongoose.Types.ObjectId(itemId);
    const id = String(itemId);
    const [broughtRows, soldRows] = await Promise.all([
        InventoryStockEntry.aggregate([
            { $match: { status: 'posted', $or: [{ 'lines.itemId': objectId }, { 'lines.itemId': id }] } },
            { $unwind: '$lines' },
            { $match: { $or: [{ 'lines.itemId': objectId }, { 'lines.itemId': id }] } },
            { $group: { _id: null, total: { $sum: '$lines.quantity' } } },
        ]),
        DeliveryOrder.aggregate([
            { $match: { stockApplied: true, 'lines.inventoryItemId': id } },
            { $unwind: '$lines' },
            { $match: { 'lines.inventoryItemId': id } },
            { $group: { _id: null, total: { $sum: '$lines.quantity' } } },
        ]),
    ]);
    return {
        broughtQuantity: Number(broughtRows[0]?.total) || 0,
        soldQuantity: Number(soldRows[0]?.total) || 0,
    };
}

export async function getItem(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const row = await InventoryItem.findById(req.params.id).populate(DETAIL_POPULATE).lean();
        if (!row) throw httpError(404, 'Item was not found.');
        const [waiting, movement] = await Promise.all([
            waitingItemMap(),
            itemMovement(row._id),
        ]);
        res.json({ ...withWaitingStatus(presentItem(row), waiting), ...movement });
    } catch (error) {
        sendError(res, error);
    }
}

export async function createItem(req, res) {
    try {
        const catalog = await resolveItemCatalog(req.body);
        const details = readItemDetails(req.body);
        await assertItemIdentityAvailable(catalog);
        await assertModelNumberAvailable(catalog.modelNumber);
        const item = await InventoryItem.create({
            ...details,
            categoryId: catalog.categoryId,
            subcategoryId: catalog.subcategoryId,
            brandId: catalog.brandId,
            itemOptionId: catalog.itemOptionId,
            description: catalog.description,
            modelNumber: catalog.modelNumber,
            itemCode: await nextItemCode(),
            status: details.status || 'Active',
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
        const catalog = await resolveItemCatalog(req.body);
        const details = readItemDetails(req.body);
        await assertItemIdentityAvailable(catalog, req.params.id);
        await assertModelNumberAvailable(catalog.modelNumber, req.params.id);
        const saved = await InventoryItem.findByIdAndUpdate(req.params.id, {
            ...details,
            categoryId: catalog.categoryId,
            subcategoryId: catalog.subcategoryId,
            brandId: catalog.brandId,
            itemOptionId: catalog.itemOptionId,
            description: catalog.description,
            modelNumber: catalog.modelNumber,
        }, {
            new: true,
            runValidators: true,
        }).populate(ITEM_POPULATE).lean();
        if (!saved) throw httpError(404, 'Item was not found.');
        await syncItemCopies(req.params.id, catalog);
        res.json(presentItem(saved));
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteItem(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Item was not found.');
        const item = await InventoryItem.findById(req.params.id).select('_id availableQuantity');
        if (!item) throw httpError(404, 'Item was not found.');
        if (Number(item.availableQuantity) > 0) {
            throw httpError(400, 'This item still has stock. Delete is available when stock is 0.');
        }
        if (await InventoryVendorContact.exists({ 'lines.itemId': req.params.id })) {
            throw httpError(400, 'This item is used by a vendor. Remove it there first.');
        }
        await InventoryItem.deleteOne({ _id: req.params.id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

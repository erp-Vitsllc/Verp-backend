import mongoose from 'mongoose';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import { httpError, sendError } from './http.js';
import { stockStatus } from './items.js';

const STOCK_POPULATE = [
    { path: 'categoryId', select: 'name' },
    { path: 'subcategoryId', select: 'name reservationQuantity' },
    { path: 'itemOptionId', select: 'name' },
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
        categoryName: row.categoryId?.name || '',
        subcategoryName: row.subcategoryId?.name || '',
        itemName: row.itemOptionId?.name || row.description || '',
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

export async function listStockOptions(_req, res) {
    try {
        const rows = await InventoryItem.find()
            .select('itemCode description modelNumber availableQuantity categoryId subcategoryId itemOptionId lastStockPrice')
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
        const saved = await InventoryItem.findByIdAndUpdate(
            req.params.id,
            { $inc: { availableQuantity: quantity }, $set: { lastStockPrice: price } },
            { new: true, runValidators: true },
        ).populate(STOCK_POPULATE).lean();
        if (!saved) throw httpError(404, 'Item was not found.');
        res.json({
            ...presentStockOption(saved),
            status: stockStatus(saved.availableQuantity, saved.subcategoryId?.reservationQuantity),
        });
    } catch (error) {
        sendError(res, error);
    }
}

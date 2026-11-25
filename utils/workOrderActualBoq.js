import mongoose from 'mongoose';
import InventoryItem from '../models/inventory/InventoryItem.js';
import InventoryStockEntry from '../models/inventory/InventoryStockEntry.js';
import InventoryVendor from '../models/inventory/InventoryVendor.js';
import { savedQuotation } from './workOrderQuotationSync.js';

function text(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * 100) / 100;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function modelInText(model, source) {
    const needle = text(model);
    if (needle.length < 2 || !source) return false;
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(needle)}([^A-Za-z0-9]|$)`, 'i').test(source);
}

function catalogName(ref) {
    if (!ref || typeof ref !== 'object') return '';
    return text(ref.name);
}

function matchItem(lineText, catalog) {
    return catalog.find((item) => modelInText(item.modelNumber, lineText)) || null;
}

async function vendorsForItems(itemIds) {
    const found = new Map();
    if (!itemIds.length) return found;
    const entries = await InventoryStockEntry.find({
        status: 'posted',
        vendorId: { $ne: null },
        'lines.itemId': { $in: itemIds },
    })
        .sort({ purchaseDate: -1, updatedAt: -1 })
        .select('vendorId lines.itemId')
        .lean();
    entries.forEach((entry) => {
        (entry.lines || []).forEach((line) => {
            const itemId = line?.itemId ? String(line.itemId) : '';
            if (!itemId || found.has(itemId) || !itemIds.includes(itemId)) return;
            found.set(itemId, String(entry.vendorId));
        });
    });
    return found;
}

async function workOrderVendor(order) {
    const vendorId = text(order?.vendorId);
    if (vendorId && mongoose.Types.ObjectId.isValid(vendorId)) {
        const vendor = await InventoryVendor.findById(vendorId).select('name paymentTerms').lean();
        if (vendor) return { name: text(vendor.name), paymentTerms: text(vendor.paymentTerms) };
    }
    return { name: text(order?.vendorName), paymentTerms: '' };
}

export async function buildActualBoq(order) {
    const quote = savedQuotation(order);
    const lines = Array.isArray(quote.lines) ? quote.lines : [];
    if (!lines.length) return [];

    const catalog = await InventoryItem.find({ modelNumber: { $nin: ['', null] } })
        .select('description moreDescription modelNumber categoryId subcategoryId itemOptionId brandId')
        .populate('categoryId', 'name')
        .populate('subcategoryId', 'name')
        .populate('itemOptionId', 'name')
        .populate('brandId', 'name')
        .lean();
    catalog.sort((left, right) => text(right.modelNumber).length - text(left.modelNumber).length);

    const matched = lines.map((line) => matchItem(String(line?.description || ''), catalog));
    const itemIds = [...new Set(matched.filter(Boolean).map((item) => String(item._id)))];
    const [itemVendors, fallbackVendor] = await Promise.all([
        vendorsForItems(itemIds),
        workOrderVendor(order),
    ]);
    const vendorIds = [...new Set([...itemVendors.values()])];
    const vendors = vendorIds.length
        ? await InventoryVendor.find({ _id: { $in: vendorIds } }).select('name paymentTerms').lean()
        : [];
    const vendorById = new Map(vendors.map((vendor) => [String(vendor._id), vendor]));

    return lines.map((line, index) => {
        const item = matched[index];
        const purchased = item ? vendorById.get(itemVendors.get(String(item._id)) || '') : null;
        const vendorName = text(purchased?.name) || fallbackVendor.name;
        const paymentTerms = text(purchased?.paymentTerms) || (vendorName ? fallbackVendor.paymentTerms : '');
        const quantity = money(line?.quantity);
        const unitPrice = money(line?.rate);
        const total = money(line?.amount) || Math.round(quantity * unitPrice * 100) / 100;
        return {
            slNo: index + 1,
            category: catalogName(item?.categoryId),
            subcategory: catalogName(item?.subcategoryId),
            item: catalogName(item?.itemOptionId),
            brand: catalogName(item?.brandId),
            modelNo: text(item?.modelNumber),
            descriptionNew: item ? [text(item.description), text(item.moreDescription)].filter(Boolean).join('\n') : '',
            descriptionOld: String(line?.description || '').trim(),
            quantity,
            unitPrice,
            total,
            vendorName,
            paymentTerms,
        };
    });
}

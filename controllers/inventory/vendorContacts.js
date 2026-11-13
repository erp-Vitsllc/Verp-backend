import mongoose from 'mongoose';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import { cleanName, httpError, requireName, sendError } from './http.js';

function textList(entries, key) {
    const seen = new Set();
    const values = [];
    entries.forEach((entry) => {
        const value = cleanName(entry?.[key]).slice(0, 120);
        const id = value.toLowerCase();
        if (!value || seen.has(id)) return;
        seen.add(id);
        values.push(value);
    });
    return values.slice(0, 20);
}

function brandNames(lines) {
    const seen = new Set();
    const names = [];
    (lines || []).forEach((line) => {
        const name = cleanName(line?.brandName);
        const id = name.toLowerCase();
        if (!name || seen.has(id)) return;
        seen.add(id);
        names.push(name);
    });
    return names;
}

export function presentContact(row) {
    const lines = Array.isArray(row.lines) ? row.lines : [];
    return {
        id: row._id,
        name: row.name,
        designation: row.designation || '',
        emails: Array.isArray(row.emails) ? row.emails : [],
        phones: Array.isArray(row.phones) ? row.phones : [],
        isPrimary: Boolean(row.isPrimary),
        brands: brandNames(lines),
        lines: lines.map((line) => ({
            itemId: line.itemId ? String(line.itemId) : '',
            categoryId: line.categoryId ? String(line.categoryId) : '',
            categoryName: line.categoryName || '',
            brandId: line.brandId ? String(line.brandId) : '',
            brandName: line.brandName || '',
        })),
    };
}

function objectIdOrNull(value) {
    const id = cleanName(value);
    if (!id) return null;
    if (!mongoose.isValidObjectId(id)) throw httpError(400, 'Choose a valid item, category, or brand.');
    return id;
}

async function readLines(entries) {
    const lines = [];
    for (const entry of entries) {
        const itemId = objectIdOrNull(entry?.itemId);
        const categoryId = objectIdOrNull(entry?.categoryId);
        const brandId = objectIdOrNull(entry?.brandId);
        if (!itemId && !categoryId && !brandId) continue;
        const [item, category, brand] = await Promise.all([
            itemId ? InventoryItem.findById(itemId).select('description').lean() : null,
            categoryId ? ItemCategory.findById(categoryId).select('name').lean() : null,
            brandId ? ItemBrand.findById(brandId).select('name').lean() : null,
        ]);
        if (itemId && !item) throw httpError(400, 'Item was not found.');
        if (categoryId && !category) throw httpError(400, 'Category was not found.');
        if (brandId && !brand) throw httpError(400, 'Brand was not found.');
        lines.push({
            itemId: item?._id || null,
            itemLabel: item?.description || '',
            categoryId: category?._id || null,
            categoryName: category?.name || '',
            brandId: brand?._id || null,
            brandName: brand?.name || '',
        });
    }
    return lines;
}

async function readContactBody(body) {
    const name = requireName(body?.name, 'Name');
    const entries = Array.isArray(body?.entries) ? body.entries.slice(0, 20) : [];
    return {
        name,
        designation: cleanName(body?.designation).slice(0, 120),
        emails: textList(entries, 'email'),
        phones: textList(entries, 'phone'),
        isPrimary: body?.isPrimary === true,
        lines: await readLines(entries),
    };
}

async function requireVendor(id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Vendor was not found.');
    const vendor = await InventoryVendor.findById(id).select('_id').lean();
    if (!vendor) throw httpError(404, 'Vendor was not found.');
    return vendor;
}

async function applyPrimary(vendorId, contactId, isPrimary) {
    if (!isPrimary) return;
    await InventoryVendorContact.updateMany(
        { vendorId, _id: { $ne: contactId } },
        { $set: { isPrimary: false } },
    );
}

export async function createVendorContact(req, res) {
    try {
        const vendor = await requireVendor(req.params.id);
        const payload = await readContactBody(req.body);
        const saved = await InventoryVendorContact.create({ ...payload, vendorId: vendor._id });
        await applyPrimary(vendor._id, saved._id, payload.isPrimary);
        const row = await InventoryVendorContact.findById(saved._id).lean();
        res.status(201).json(presentContact(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateVendorContact(req, res) {
    try {
        const vendor = await requireVendor(req.params.id);
        if (!mongoose.isValidObjectId(req.params.contactId)) throw httpError(404, 'Contact was not found.');
        const payload = await readContactBody(req.body);
        const row = await InventoryVendorContact.findOneAndUpdate(
            { _id: req.params.contactId, vendorId: vendor._id },
            payload,
            { new: true },
        ).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        await applyPrimary(vendor._id, row._id, payload.isPrimary);
        const fresh = await InventoryVendorContact.findById(row._id).lean();
        res.json(presentContact(fresh));
    } catch (error) {
        sendError(res, error);
    }
}

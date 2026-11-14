import mongoose from 'mongoose';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import InventoryItem from '../../models/inventory/InventoryItem.js';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import { cleanName, httpError, requireName, sendError } from './http.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function assertContactChannels(entries) {
    let hasEmail = false;
    let hasPhone = false;
    entries.forEach((entry) => {
        const email = cleanName(entry?.email);
        if (email) {
            hasEmail = true;
            if (email.length > 120 || !EMAIL_PATTERN.test(email)) {
                throw httpError(400, 'Enter a valid email address.');
            }
        }
        const phone = cleanName(entry?.phone).replace(/[\s()-]/g, '');
        if (phone) {
            hasPhone = true;
            if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
                throw httpError(400, 'Enter a valid phone number with a country code.');
            }
        }
    });
    if (!hasEmail) throw httpError(400, 'Email is required.');
    if (!hasPhone) throw httpError(400, 'Phone number is required.');
}

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
    assertContactChannels(entries);
    return {
        name,
        designation: cleanName(body?.designation).slice(0, 120),
        emails: textList(entries, 'email'),
        phones: textList(entries, 'phone'),
        lines: await readLines(entries),
    };
}

async function requireVendor(id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Vendor was not found.');
    const vendor = await InventoryVendor.findById(id).select('_id').lean();
    if (!vendor) throw httpError(404, 'Vendor was not found.');
    return vendor;
}

export function withSinglePrimary(contacts) {
    const rows = Array.isArray(contacts) ? contacts : [];
    const chosen = rows.find((row) => row.isPrimary && row.source !== 'zoho')
        || rows.find((row) => row.isPrimary);
    const id = chosen ? String(chosen.id) : '';
    return rows
        .map((row) => ({ ...row, isPrimary: Boolean(id) && String(row.id) === id }))
        .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary));
}

async function makeOnlyPrimary(vendorId, contactId) {
    await InventoryVendorContact.updateMany(
        { vendorId },
        { $set: { isPrimary: false } },
    );
    const updated = await InventoryVendorContact.updateOne(
        { _id: contactId, vendorId },
        { $set: { isPrimary: true } },
    );
    if (!updated.matchedCount) throw httpError(404, 'Contact was not found.');
}

async function localCopyOfZoho(vendorId, zohoId) {
    const existing = await InventoryVendorContact.findOne({ vendorId, zohoPersonId: zohoId }).lean();
    if (existing) return existing;
    const { findVisibleZohoContact, suppressZohoContactId } = await import('./vendors.js');
    const snapshot = await findVisibleZohoContact(vendorId, zohoId);
    if (!snapshot) throw httpError(404, 'Contact was not found.');
    const saved = await InventoryVendorContact.create({
        vendorId,
        zohoPersonId: zohoId,
        name: snapshot.name || 'Contact',
        designation: snapshot.designation || '',
        emails: snapshot.emails || [],
        phones: snapshot.phones || [],
        isPrimary: false,
        lines: [],
    });
    await suppressZohoContactId(vendorId, zohoId);
    return saved.toObject();
}

function isZohoContactId(value) {
    return String(value || '').startsWith('zoho-');
}

export async function createVendorContact(req, res) {
    try {
        const vendor = await requireVendor(req.params.id);
        const payload = await readContactBody(req.body);
        const saved = await InventoryVendorContact.create({ ...payload, vendorId: vendor._id, isPrimary: false });
        const row = await InventoryVendorContact.findById(saved._id).lean();
        res.status(201).json(presentContact(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateVendorContact(req, res) {
    try {
        const vendor = await requireVendor(req.params.id);
        let contactId = req.params.contactId;
        if (isZohoContactId(contactId)) {
            const copied = await localCopyOfZoho(vendor._id, contactId);
            contactId = copied._id;
        } else if (!mongoose.isValidObjectId(contactId)) {
            throw httpError(404, 'Contact was not found.');
        }
        const payload = await readContactBody(req.body);
        const row = await InventoryVendorContact.findOneAndUpdate(
            { _id: contactId, vendorId: vendor._id },
            payload,
            { new: true },
        ).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        res.json(presentContact(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteVendorContact(req, res) {
    try {
        const vendor = await requireVendor(req.params.id);
        const contactId = req.params.contactId;
        if (isZohoContactId(contactId)) {
            const { suppressZohoContactId } = await import('./vendors.js');
            await InventoryVendorContact.deleteOne({ vendorId: vendor._id, zohoPersonId: contactId });
            await suppressZohoContactId(vendor._id, contactId);
            res.json({ ok: true });
            return;
        }
        if (!mongoose.isValidObjectId(contactId)) throw httpError(404, 'Contact was not found.');
        const row = await InventoryVendorContact.findOneAndDelete({ _id: contactId, vendorId: vendor._id }).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

export async function markVendorContactPrimary(req, res) {
    try {
        const vendor = await requireVendor(req.params.id);
        let contactId = req.params.contactId;
        if (isZohoContactId(contactId)) {
            const copied = await localCopyOfZoho(vendor._id, contactId);
            contactId = copied._id;
        } else if (!mongoose.isValidObjectId(contactId)) {
            throw httpError(404, 'Contact was not found.');
        }
        const row = await InventoryVendorContact.findOne({ _id: contactId, vendorId: vendor._id }).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        await makeOnlyPrimary(vendor._id, row._id);
        await InventoryVendor.updateOne(
            { _id: vendor._id },
            { $set: { primaryContact: row.name || '' } },
        );
        const { loadVendorDetail } = await import('./vendors.js');
        const savedVendor = await InventoryVendor.findById(vendor._id).lean();
        res.json(await loadVendorDetail(savedVendor));
    } catch (error) {
        sendError(res, error);
    }
}

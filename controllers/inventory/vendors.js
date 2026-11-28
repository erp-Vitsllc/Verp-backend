import mongoose from 'mongoose';
import ZohoVendor from '../../models/ZohoVendor.js';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import { fetchPurchaseOrdersByStatus, fetchVendorContact, getZohoOrganizationId } from '../../services/zohoService.js';
import { listErpVendorZohoBills, pendingErpBillCounts } from '../../utils/erpVendorZohoBills.js';
import { withZohoOrganization } from '../../utils/zohoOrgContext.js';
import { presentContact, withSinglePrimary } from './vendorContacts.js';
import { cleanName, httpError, listLimit, nameKey, sendError } from './http.js';
import { escapeRegex } from '../../utils/regexHelper.js';

const STATUSES = ['Active', 'Inactive'];

function text(value) {
    return cleanName(value);
}

function personName(person) {
    if (!person || typeof person !== 'object') return '';
    return text([person.salutation, person.first_name, person.last_name].filter(Boolean).join(' '))
        || text(person.contact_person_name);
}

function primaryContactName(raw, doc) {
    const people = Array.isArray(raw?.contact_persons) ? raw.contact_persons : [];
    const primary = people.find((person) => person?.is_primary_contact) || people[0];
    const fromPerson = personName(primary);
    if (fromPerson) return fromPerson;
    const named = text([raw?.first_name, raw?.last_name].filter(Boolean).join(' '));
    if (named) return named;
    const company = text(doc.companyName);
    const contact = text(doc.contactName);
    if (contact && contact !== company) return contact;
    return '';
}

function locationText(doc, raw) {
    const named = text(doc.locationName);
    if (named) return named;
    const billing = raw?.billing_address || raw?.address || {};
    const cityLine = text([billing.city, billing.state, billing.country].filter(Boolean).join(', '));
    if (cityLine) return cityLine;
    return text(doc.placeOfContact).replace(/[_-]+/g, ' ');
}

function paymentTermsText(doc, raw) {
    const label = text(doc.paymentTermsLabel || raw?.payment_terms_label);
    if (label) return label;
    const terms = doc.paymentTerms ?? raw?.payment_terms;
    if (terms === 0 || terms === '0') return 'Due on Receipt';
    if (terms !== null && terms !== undefined && String(terms).trim() !== '') return `Net ${terms}`;
    return '';
}

function addressText(raw) {
    const billing = raw?.billing_address || raw?.shipping_address || raw?.address || {};
    return [
        billing.attention,
        billing.address,
        billing.street2,
        [billing.city, billing.state].filter(Boolean).join(', '),
        billing.zip,
        billing.country,
    ].map((part) => text(part)).filter(Boolean).join(', ');
}

function fieldsFromZoho(doc) {
    const raw = doc.zohoRaw && typeof doc.zohoRaw === 'object' ? doc.zohoRaw : {};
    const name = text(doc.companyName) || text(doc.contactName) || text(raw.vendor_name) || 'Unnamed vendor';
    return {
        zohoContactId: String(doc.zohoContactId),
        name,
        location: locationText(doc, raw),
        address: addressText(raw),
        primaryContact: primaryContactName(raw, doc),
        email: text(doc.email || raw.email),
        phone: text(doc.phone || doc.mobile || raw.phone || raw.mobile),
        website: text(raw.website),
        taxRegNo: text(raw.tax_reg_no || raw.vat_reg_no || raw.gst_no),
        paymentTerms: paymentTermsText(doc, raw),
        vendorType: '',
        brands: [],
        productCount: null,
        status: doc.isActive === false || String(raw.status || '').toLowerCase() === 'inactive' ? 'Inactive' : 'Active',
    };
}

function finiteAmount(value) {
    if (value == null || value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
}

function outstandingPaymentFromZoho(raw, stored) {
    const live = raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
    const storedRaw = stored?.zohoRaw && typeof stored.zohoRaw === 'object' ? stored.zohoRaw : null;
    if (live) {
        const amount = finiteAmount(live.outstanding_payable_amount ?? live.outstanding_payable_amount_bcy);
        const credits = finiteAmount(live.unused_credits_payable_amount ?? live.unused_credits_payable_amount_bcy);
        return {
            outstandingPayment: amount == null ? 0 : amount,
            unusedCredits: credits == null ? 0 : credits,
            currencyCode: text(live.currency_code) || text(stored?.currencyCode) || 'AED',
        };
    }
    const outstanding = finiteAmount(stored?.outstandingPayableAmount);
    const credits = finiteAmount(stored?.unusedCreditsPayableAmount)
        ?? finiteAmount(storedRaw?.unused_credits_payable_amount ?? storedRaw?.unused_credits_payable_amount_bcy);
    if (outstanding != null || credits != null) {
        return {
            outstandingPayment: outstanding,
            unusedCredits: credits,
            currencyCode: text(stored?.currencyCode) || text(storedRaw?.currency_code) || 'AED',
        };
    }
    return { outstandingPayment: null, unusedCredits: null, currencyCode: 'AED' };
}

function presentVendor(row) {
    const brands = Array.isArray(row.brands) ? row.brands.filter(Boolean) : [];
    return {
        id: row._id,
        code: row.vendorCode,
        zohoContactId: row.zohoContactId || '',
        name: row.name,
        location: row.location || '',
        address: row.address || row.location || '',
        contact: row.primaryContact || '',
        email: row.email || '',
        phone: row.phone || '',
        website: row.website || '',
        taxRegNo: row.taxRegNo || '',
        brands,
        products: row.productCount == null ? null : Number(row.productCount) || 0,
        vendorType: row.vendorType || '',
        paymentTerms: row.paymentTerms || '',
        status: row.status || 'Active',
    };
}

function uniqueNames(values) {
    const seen = new Set();
    const names = [];
    (values || []).forEach((value) => {
        const name = cleanName(value);
        const key = name.toLowerCase();
        if (!name || seen.has(key)) return;
        seen.add(key);
        names.push(name);
    });
    return names;
}

async function contactNamesFor(vendorIds) {
    const map = new Map();
    if (!vendorIds.length) return map;
    const rows = await InventoryVendorContact.find({ vendorId: { $in: vendorIds } })
        .select('vendorId lines.brandName lines.categoryName')
        .sort({ createdAt: 1 })
        .lean();
    rows.forEach((row) => {
        const key = String(row.vendorId);
        const current = map.get(key) || { brands: [], categories: [] };
        (row.lines || []).forEach((line) => {
            current.brands.push(line?.brandName);
            current.categories.push(line?.categoryName);
        });
        map.set(key, current);
    });
    map.forEach((current, key) => {
        map.set(key, {
            brands: uniqueNames(current.brands),
            categories: uniqueNames(current.categories),
        });
    });
    return map;
}

async function zohoSource(doc) {
    let source = doc;
    try {
        const contact = await fetchVendorContact(doc.zohoContactId);
        if (contact) {
            source = {
                ...doc,
                companyName: text(contact.company_name) || doc.companyName,
                contactName: text(contact.contact_name) || doc.contactName,
                email: text(contact.email) || doc.email,
                phone: text(contact.phone) || doc.phone,
                mobile: text(contact.mobile) || doc.mobile,
                locationName: text(contact.location_name || contact.branch_name) || doc.locationName,
                paymentTerms: contact.payment_terms ?? doc.paymentTerms,
                paymentTermsLabel: text(contact.payment_terms_label) || doc.paymentTermsLabel,
                placeOfContact: text(contact.place_of_contact) || doc.placeOfContact,
                zohoRaw: contact,
            };
        }
    } catch {
        source = doc;
    }
    return source;
}

function storedZohoRaw(doc) {
    return doc?.zohoRaw && typeof doc.zohoRaw === 'object' ? doc.zohoRaw : {};
}

async function storedZohoVendor(zohoContactId) {
    const id = text(zohoContactId);
    if (!id) return null;
    return ZohoVendor.findOne({ zohoContactId: id })
        .select('outstandingPayableAmount unusedCreditsPayableAmount currencyCode zohoRaw')
        .lean();
}

async function persistLiveZohoVendor(zohoContactId) {
    const id = text(zohoContactId);
    if (!id) return;
    const source = await zohoSource({ zohoContactId: id, zohoRaw: {} });
    const raw = storedZohoRaw(source);
    if (!Object.keys(raw).length) return;
    const outstanding = finiteAmount(raw.outstanding_payable_amount ?? raw.outstanding_payable_amount_bcy);
    const credits = finiteAmount(raw.unused_credits_payable_amount ?? raw.unused_credits_payable_amount_bcy);
    const patch = {
        zohoRaw: raw,
        lastSyncedAt: new Date(),
        currencyCode: text(raw.currency_code) || 'AED',
    };
    if (outstanding != null) patch.outstandingPayableAmount = outstanding;
    if (credits != null) patch.unusedCreditsPayableAmount = credits;
    await ZohoVendor.updateOne({ zohoContactId: id }, { $set: patch });
}

function zohoContactRows(raw, vendor) {
    const people = Array.isArray(raw?.contact_persons) ? raw.contact_persons : [];
    const rows = people.map((person, index) => {
        const name = personName(person);
        const emails = [text(person?.email)].filter(Boolean);
        const phones = [text(person?.phone), text(person?.mobile)].filter(Boolean);
        if (!name && !emails.length && !phones.length) return null;
        return {
            id: `zoho-${person?.contact_person_id || index}`,
            name: name || vendor.primaryContact || 'Contact',
            designation: text(person?.designation || person?.department),
            emails,
            phones,
            isPrimary: Boolean(person?.is_primary_contact),
            brands: [],
            lines: [],
            source: 'zoho',
        };
    }).filter(Boolean);

    if (!rows.some((row) => row.isPrimary) && rows.length) {
        const match = vendor.primaryContact
            ? rows.find((row) => row.name.toLowerCase() === vendor.primaryContact.toLowerCase())
            : null;
        (match || rows[0]).isPrimary = true;
    }

    if (!rows.length && (vendor.primaryContact || vendor.email || vendor.phone)) {
        rows.push({
            id: 'zoho-vendor',
            name: vendor.primaryContact || 'Contact',
            designation: '',
            emails: vendor.email ? [vendor.email] : [],
            phones: vendor.phone ? [vendor.phone] : [],
            isPrimary: true,
            brands: [],
            lines: [],
            source: 'zoho',
        });
    }

    return rows;
}

function mergeContacts(localRows, zohoRows) {
    const extras = zohoRows.filter((zoho) => !localRows.some((local) => {
        const zohoEmails = zoho.emails.map((email) => email.toLowerCase());
        if (zohoEmails.length && local.emails.some((email) => zohoEmails.includes(email.toLowerCase()))) return true;
        return zoho.name && local.name && zoho.name.toLowerCase() === local.name.toLowerCase();
    }));
    return [...localRows, ...extras].sort((left, right) => {
        const rank = (row) => {
            if (row.isPrimary && row.source !== 'zoho') return 0;
            if (row.isPrimary) return 1;
            return 2;
        };
        return rank(left) - rank(right);
    });
}

function filled(values) {
    return [...new Set((values || []).map((value) => cleanName(value)).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

async function allocateVendorCode() {
    const rows = await InventoryVendor.find().select('vendorCode').lean();
    let max = 0;
    rows.forEach((row) => {
        const match = /^VEN-(\d+)$/i.exec(String(row.vendorCode || '').trim());
        if (match) max = Math.max(max, Number(match[1]));
    });
    return `VEN-${String(max + 1).padStart(3, '0')}`;
}

async function findZohoVendor(zohoContactId) {
    const id = text(zohoContactId);
    if (!id) throw httpError(400, 'Select a vendor.');
    let organizationId = '';
    try {
        organizationId = getZohoOrganizationId();
    } catch {
        organizationId = '';
    }
    const filter = { zohoContactId: id, isActive: true };
    if (organizationId) filter.organizationId = organizationId;
    const doc = await ZohoVendor.findOne(filter).lean();
    if (doc) return doc;
    if (!organizationId) return null;
    return ZohoVendor.findOne({ zohoContactId: id, isActive: true }).lean();
}

async function vendorFromZoho(zohoContactId) {
    const doc = await findZohoVendor(zohoContactId);
    if (!doc) throw httpError(404, 'That Zoho vendor was not found.');
    const existing = await InventoryVendor.findOne({ zohoContactId: doc.zohoContactId }).select('_id').lean();
    if (existing) throw httpError(400, 'This vendor is already added.');

    return fieldsFromZoho(await zohoSource(doc));
}

function brandList(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
    return filled(source);
}

function readVendorEdits(body, base) {
    const name = body && Object.prototype.hasOwnProperty.call(body, 'name') ? text(body.name) : text(base.name);
    if (!name) throw httpError(400, 'Vendor name is required.');
    const vendorCode = body && Object.prototype.hasOwnProperty.call(body, 'vendorCode')
        ? text(body.vendorCode)
        : text(base.vendorCode);
    if (!vendorCode) throw httpError(400, 'Vendor code is required.');
    if (vendorCode.length > 40) throw httpError(400, 'Vendor code must be 40 characters or less.');
    const email = text(body?.email);
    if (email && (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) {
        throw httpError(400, 'Enter a valid email address.');
    }
    const phone = text(body?.phone).replace(/[\s()-]/g, '');
    if (phone && !/^\+[1-9]\d{6,14}$/.test(phone)) {
        throw httpError(400, 'Enter a valid phone number with a country code.');
    }
    const status = STATUSES.includes(body?.status) ? body.status : (base.status || 'Active');
    let productCount = base.productCount == null ? null : base.productCount;
    if (body && Object.prototype.hasOwnProperty.call(body, 'products')) {
        if (body.products === '' || body.products == null) productCount = null;
        else {
            const count = Number(body.products);
            if (!Number.isInteger(count) || count < 0) {
                throw httpError(400, 'Products must be a whole number of zero or more.');
            }
            productCount = count;
        }
    }
    return {
        vendorCode,
        name,
        nameKey: nameKey(name),
        location: text(body?.location),
        address: text(base.address),
        primaryContact: text(body?.primaryContact),
        email,
        phone,
        website: text(base.website),
        taxRegNo: text(base.taxRegNo),
        paymentTerms: text(body?.paymentTerms),
        brands: body && Object.prototype.hasOwnProperty.call(body, 'brands')
            ? brandList(body.brands)
            : (Array.isArray(base.brands) ? base.brands : []),
        productCount,
        vendorType: text(base.vendorType),
        status,
    };
}

function duplicateVendorMessage(error) {
    const keys = Object.keys(error?.keyPattern || {});
    if (keys.includes('vendorCode')) return httpError(400, 'Vendor code was already used. Save again.');
    if (keys.includes('zohoContactId')) return httpError(400, 'This vendor is already added.');
    return httpError(400, 'This vendor is already added.');
}

export async function nextVendorCode(_req, res) {
    try {
        const [vendorCode, linkedZohoIds] = await Promise.all([
            allocateVendorCode(),
            InventoryVendor.distinct('zohoContactId'),
        ]);
        res.json({
            vendorCode,
            linkedZohoIds: linkedZohoIds.map((id) => String(id || '')).filter(Boolean),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function previewZohoVendor(req, res) {
    try {
        const fields = await vendorFromZoho(req.query.zohoContactId);
        const vendorCode = await allocateVendorCode();
        res.json({ vendorCode, ...presentVendor({ ...fields, vendorCode, _id: '' }) });
    } catch (error) {
        sendError(res, error);
    }
}

async function saveModalPrimaryContact(vendorId, edits) {
    const name = text(edits.primaryContact);
    const email = text(edits.email);
    const phone = text(edits.phone);
    const existing = await InventoryVendorContact.findOne({ vendorId, isPrimary: true });
    if (!existing && !name && !email && !phone) return;
    const patch = {
        name: name || text(existing?.name) || 'Contact',
        emails: email ? [email] : [],
        phones: phone ? [phone] : [],
        isPrimary: true,
    };
    if (existing) {
        await InventoryVendorContact.updateMany(
            { vendorId, _id: { $ne: existing._id } },
            { $set: { isPrimary: false } },
        );
        existing.name = patch.name;
        existing.emails = patch.emails;
        existing.phones = patch.phones;
        existing.isPrimary = true;
        await existing.save();
        return;
    }
    await InventoryVendorContact.create({
        vendorId,
        zohoPersonId: '',
        designation: '',
        lines: [],
        ...patch,
    });
}

export async function createVendor(req, res) {
    try {
        const fields = await vendorFromZoho(req.body?.zohoContactId);
        const vendorCode = await allocateVendorCode();
        const edits = readVendorEdits({ ...req.body, vendorCode }, { ...fields, vendorCode });
        const saved = await InventoryVendor.create({
            ...fields,
            ...edits,
            zohoContactId: fields.zohoContactId,
        });
        await saveModalPrimaryContact(saved._id, edits);
        res.status(201).json(presentVendor(saved));
    } catch (error) {
        if (error?.code === 11000) {
            sendError(res, duplicateVendorMessage(error));
            return;
        }
        sendError(res, error);
    }
}

export async function findVisibleZohoContact(vendorId, zohoId) {
    const row = await InventoryVendor.findById(vendorId).lean();
    if (!row) return null;
    const adopted = await InventoryVendorContact.findOne({ vendorId, zohoPersonId: zohoId }).select('_id').lean();
    if (adopted) return null;
    const hidden = new Set(row.suppressedZohoContactIds || []);
    if (hidden.has(zohoId)) return null;
    const zohoDoc = await storedZohoVendor(row.zohoContactId);
    return zohoContactRows(storedZohoRaw(zohoDoc), row).find((contact) => contact.id === zohoId) || null;
}

export async function suppressZohoContactId(vendorId, zohoId) {
    await InventoryVendor.updateOne(
        { _id: vendorId },
        { $addToSet: { suppressedZohoContactIds: zohoId } },
    );
}

export async function loadVendorDetail(row) {
    const zohoDoc = await storedZohoVendor(row?.zohoContactId);
    const zohoRaw = storedZohoRaw(zohoDoc);
    const outstanding = outstandingPaymentFromZoho(null, zohoDoc);
    const contacts = await InventoryVendorContact.find({ vendorId: row._id }).sort({ isPrimary: -1, createdAt: 1 }).lean();
    const localContacts = contacts.map((contact) => ({ ...presentContact(contact), source: 'local' }));
    const hidden = new Set([
        ...(row.suppressedZohoContactIds || []),
        ...contacts.map((contact) => contact.zohoPersonId).filter(Boolean),
    ]);
    const zohoContacts = zohoContactRows(zohoRaw, row).filter((contact) => !hidden.has(contact.id));
    const merged = withSinglePrimary(mergeContacts(localContacts, zohoContacts));
    return {
        ...presentVendor(row),
        ...outstanding,
        contacts: await withCatalogImages(merged),
    };
}

async function withCatalogImages(contacts) {
    const brandIds = [...new Set(contacts.flatMap((contact) => (
        (contact.lines || []).map((line) => line.brandId).filter((id) => mongoose.isValidObjectId(id))
    )))];
    const categoryIds = [...new Set(contacts.flatMap((contact) => (
        (contact.lines || []).map((line) => line.categoryId).filter((id) => mongoose.isValidObjectId(id))
    )))];
    const [brandRows, categoryRows] = await Promise.all([
        brandIds.length ? ItemBrand.find({ _id: { $in: brandIds } }).select('imageData').lean() : [],
        categoryIds.length ? ItemCategory.find({ _id: { $in: categoryIds } }).select('imageData').lean() : [],
    ]);
    const brandImages = new Map(brandRows.map((item) => [String(item._id), item.imageData || '']));
    const categoryImages = new Map(categoryRows.map((item) => [String(item._id), item.imageData || '']));
    return contacts.map((contact) => ({
        ...contact,
        lines: (contact.lines || []).map((line) => ({
            ...line,
            brandImage: brandImages.get(String(line.brandId)) || '',
            categoryImage: categoryImages.get(String(line.categoryId)) || '',
        })),
    }));
}

async function requireInventoryVendor(id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Vendor was not found.');
    const row = await InventoryVendor.findById(id).lean();
    if (!row) throw httpError(404, 'Vendor was not found.');
    return row;
}


export async function getVendor(req, res) {
    try {
        const row = await requireInventoryVendor(req.params.id);
        res.json(await loadVendorDetail(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function listVendorBills(req, res) {
    try {
        const row = await requireInventoryVendor(req.params.id);
        res.json({ bills: await listErpVendorZohoBills(row.zohoContactId) });
    } catch (error) {
        sendError(res, error);
    }
}

export async function syncVendorFromZoho(req, res) {
    try {
        const row = await requireInventoryVendor(req.params.id);
        if (!text(row.zohoContactId)) throw httpError(400, 'This vendor is not linked to Zoho.');
        await Promise.all([
            listErpVendorZohoBills(row.zohoContactId, { refresh: true }),
            persistLiveZohoVendor(row.zohoContactId),
        ]);
        const detail = await loadVendorDetail(row);
        const amounts = {};
        if (detail.outstandingPayment != null) amounts.outstandingPayableAmount = detail.outstandingPayment;
        if (detail.unusedCredits != null) amounts.unusedCreditsPayableAmount = detail.unusedCredits;
        if (Object.keys(amounts).length) {
            await ZohoVendor.updateOne(
                { zohoContactId: String(row.zohoContactId) },
                {
                    $set: {
                        ...amounts,
                        currencyCode: detail.currencyCode || 'AED',
                    },
                },
            );
        }
        res.json(detail);
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateVendor(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Vendor was not found.');
        const row = await InventoryVendor.findById(req.params.id).lean();
        if (!row) throw httpError(404, 'Vendor was not found.');
        let zohoContactId = text(req.body?.zohoContactId) || row.zohoContactId;
        if (!zohoContactId) throw httpError(400, 'Select a vendor.');
        let base = {
            vendorCode: row.vendorCode,
            name: row.name,
            location: row.location,
            address: row.address,
            primaryContact: row.primaryContact,
            email: row.email,
            phone: row.phone,
            website: row.website,
            taxRegNo: row.taxRegNo,
            paymentTerms: row.paymentTerms,
            brands: row.brands,
            productCount: row.productCount,
            vendorType: row.vendorType,
            status: row.status,
        };
        if (String(zohoContactId) !== String(row.zohoContactId)) {
            const doc = await findZohoVendor(zohoContactId);
            if (!doc) throw httpError(404, 'That Zoho vendor was not found.');
            const taken = await InventoryVendor.findOne({
                zohoContactId: doc.zohoContactId,
                _id: { $ne: row._id },
            }).select('_id').lean();
            if (taken) throw httpError(400, 'This vendor is already added.');
            const fields = fieldsFromZoho(await zohoSource(doc));
            zohoContactId = fields.zohoContactId;
            base = {
                ...base,
                name: fields.name,
                location: fields.location,
                address: fields.address,
                primaryContact: fields.primaryContact,
                email: fields.email,
                phone: fields.phone,
                website: fields.website,
                taxRegNo: fields.taxRegNo,
                paymentTerms: fields.paymentTerms,
                status: fields.status,
            };
        }
        const edits = readVendorEdits({ ...req.body, vendorCode: row.vendorCode }, base);
        const saved = await InventoryVendor.findByIdAndUpdate(row._id, {
            ...edits,
            zohoContactId,
        }, { new: true, runValidators: true }).lean();
        await saveModalPrimaryContact(saved._id, edits);
        res.json(presentVendor(saved));
    } catch (error) {
        if (error?.code === 11000) {
            sendError(res, duplicateVendorMessage(error));
            return;
        }
        sendError(res, error);
    }
}

export async function deleteVendor(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Vendor was not found.');
        const row = await InventoryVendor.findByIdAndDelete(req.params.id).lean();
        if (!row) throw httpError(404, 'Vendor was not found.');
        await InventoryVendorContact.deleteMany({ vendorId: row._id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

function outstandingForContact(docs, contactId) {
    const id = text(contactId);
    if (!id) return { outstandingPayment: null, currencyCode: 'AED' };
    const matches = (docs || []).filter((doc) => text(doc.zohoContactId) === id || text(doc.zohoVendorId) === id);
    if (!matches.length) return { outstandingPayment: null, currencyCode: 'AED' };
    matches.sort((left, right) => new Date(right.lastSyncedAt || 0) - new Date(left.lastSyncedAt || 0));
    const chosen = matches[0];
    const raw = chosen.zohoRaw && typeof chosen.zohoRaw === 'object' ? chosen.zohoRaw : null;
    const hasLive = raw && (
        raw.outstanding_payable_amount != null || raw.outstanding_payable_amount_bcy != null
    );
    return outstandingPaymentFromZoho(hasLive ? raw : null, chosen);
}

function openLposForContact(docs, contactId, counts) {
    const aliases = new Set([text(contactId)].filter(Boolean));
    (docs || []).forEach((doc) => {
        if (text(doc.zohoContactId) !== text(contactId) && text(doc.zohoVendorId) !== text(contactId)) return;
        aliases.add(text(doc.zohoContactId));
        aliases.add(text(doc.zohoVendorId));
    });
    aliases.delete('');
    let total = 0;
    aliases.forEach((alias) => {
        total += counts.get(alias) || 0;
    });
    return total;
}

const OPEN_LPO_TTL_MS = 3 * 60 * 1000;
const openLpoCache = { at: 0, counts: new Map(), pending: null };

function zohoOrganizationIds() {
    return [...new Set(
        [
            process.env.ZOHO_ORGANIZATION_ID,
            process.env.ZOHO_ORGANIZATION_ID_NNIT,
            process.env.ZOHO_ORGANIZATION_ID_VEGA,
        ].map((value) => text(value)).filter(Boolean),
    )];
}

async function loadOpenLpoCounts() {
    const counts = new Map();
    const seen = new Set();
    const orgs = zohoOrganizationIds();
    const targets = orgs.length ? orgs : [''];
    for (const orgId of targets) {
        try {
            await withZohoOrganization(orgId || null, async () => {
                const [openRows, partialRows] = await Promise.all([
                    fetchPurchaseOrdersByStatus('Status.Open'),
                    fetchPurchaseOrdersByStatus('Status.PartiallyBilled'),
                ]);
                [...openRows, ...partialRows].forEach((row) => {
                    const poId = text(row?.purchaseorder_id);
                    const vendorId = text(row?.vendor_id);
                    if (!poId || !vendorId || seen.has(poId)) return;
                    seen.add(poId);
                    counts.set(vendorId, (counts.get(vendorId) || 0) + 1);
                });
            });
        } catch (error) {
            console.warn('[VendorList] Open LPO count skipped', orgId || 'default', error?.message || error);
        }
    }
    return counts;
}

function openLpoCounts() {
    if (openLpoCache.at && Date.now() - openLpoCache.at < OPEN_LPO_TTL_MS) {
        return Promise.resolve(openLpoCache.counts);
    }
    if (!openLpoCache.pending) {
        openLpoCache.pending = loadOpenLpoCounts()
            .then((counts) => {
                openLpoCache.at = Date.now();
                openLpoCache.counts = counts;
                return counts;
            })
            .catch((error) => {
                console.warn('[VendorList] Open LPO count skipped', error?.message || error);
                openLpoCache.at = Date.now();
                return openLpoCache.counts;
            })
            .finally(() => {
                openLpoCache.pending = null;
            });
    }
    const giveUp = new Promise((resolve) => {
        setTimeout(() => resolve(openLpoCache.counts), 6000);
    });
    return Promise.race([openLpoCache.pending, giveUp]);
}

export async function listVendors(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = listLimit(req.query.limit);
        const filter = {};
        const product = cleanName(req.query.product);
        const brand = cleanName(req.query.brand);
        const paymentTerms = cleanName(req.query.paymentTerms);
        const search = cleanName(req.query.search);

        if (paymentTerms) filter.paymentTerms = paymentTerms;
        if (product) {
            const contactVendorIds = await InventoryVendorContact.distinct('vendorId', {
                'lines.categoryName': new RegExp(`^${escapeRegex(product)}$`, 'i'),
            });
            filter.$and = [
                ...(filter.$and || []),
                { _id: { $in: contactVendorIds } },
            ];
        }
        if (brand) {
            const contactVendorIds = await InventoryVendorContact.distinct('vendorId', {
                'lines.brandName': new RegExp(`^${escapeRegex(brand)}$`, 'i'),
            });
            filter.$and = [
                ...(filter.$and || []),
                { $or: [{ brands: brand }, { _id: { $in: contactVendorIds } }] },
            ];
        }
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            const contactVendorIds = await InventoryVendorContact.distinct('vendorId', {
                $or: [
                    { 'lines.brandName': regex },
                    { 'lines.categoryName': regex },
                ],
            });
            filter.$or = [
                { vendorCode: regex },
                { name: regex },
                { location: regex },
                { primaryContact: regex },
                { email: regex },
                { phone: regex },
                { brands: regex },
                { paymentTerms: regex },
                { _id: { $in: contactVendorIds } },
            ];
        }

        const vendorSortFields = {
            code: 'vendorCode',
            name: 'name',
            location: 'location',
            contact: 'primaryContact',
            status: 'status',
        };
        const vendorSortField = vendorSortFields[String(req.query.sort || '').trim()];
        const vendorSortDir = String(req.query.dir || '').toLowerCase() === 'desc' ? -1 : 1;
        const vendorQuery = InventoryVendor.find(filter).sort(
            vendorSortField ? { [vendorSortField]: vendorSortDir } : { vendorCode: 1 },
        );
        if (limit > 0) vendorQuery.skip((page - 1) * limit).limit(limit);
        const [rows, total, products, brands, contactBrands, terms] = await Promise.all([
            vendorQuery.lean(),
            InventoryVendor.countDocuments(filter),
            InventoryVendorContact.distinct('lines.categoryName'),
            InventoryVendor.distinct('brands'),
            InventoryVendorContact.distinct('lines.brandName'),
            InventoryVendor.distinct('paymentTerms'),
        ]);
        const vendorIds = rows.map((row) => row._id);
        const contactIds = rows.map((row) => text(row.zohoContactId)).filter(Boolean);
        const [catalog, zohoDocs, pendingCounts, openLpos] = await Promise.all([
            contactNamesFor(vendorIds),
            contactIds.length
                ? ZohoVendor.find({
                    $or: [{ zohoContactId: { $in: contactIds } }, { zohoVendorId: { $in: contactIds } }],
                }).select('zohoContactId zohoVendorId outstandingPayableAmount unusedCreditsPayableAmount currencyCode zohoRaw lastSyncedAt').lean()
                : [],
            pendingErpBillCounts(contactIds),
            openLpoCounts(),
        ]);

        res.json({
            vendors: rows.map((row) => {
                const names = catalog.get(String(row._id)) || { brands: [], categories: [] };
                const contactId = text(row.zohoContactId);
                const amounts = outstandingForContact(zohoDocs, contactId);
                return {
                    ...presentVendor(row),
                    ...amounts,
                    pendingBills: pendingCounts.get(contactId) || 0,
                    openLpos: openLposForContact(zohoDocs, contactId, openLpos),
                    listBrands: names.brands,
                    listCategories: names.categories,
                };
            }),
            total,
            page,
            limit,
            filters: {
                products: filled(products),
                brands: filled([...(brands || []), ...(contactBrands || [])]),
                paymentTerms: filled(terms),
            },
        });
    } catch (error) {
        sendError(res, error);
    }
}

import mongoose from 'mongoose';
import ZohoVendor from '../../models/ZohoVendor.js';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import ItemBrand from '../../models/inventory/ItemBrand.js';
import { fetchBillsChunk, fetchVendorContact, getZohoOrganizationId } from '../../services/zohoService.js';
import ZohoBill from '../../models/ZohoBill.js';
import { mapZohoBillToDoc, toZohoBillApiShape } from '../../utils/zohoPurchaseMappers.js';
import { presentContact } from './vendorContacts.js';
import { cleanName, httpError, nameKey, sendError } from './http.js';
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

function outstandingPaymentFromZoho(raw, stored) {
    const live = raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
    if (live) {
        const amount = Number(live.outstanding_payable_amount ?? live.outstanding_payable_amount_bcy);
        return {
            outstandingPayment: Number.isFinite(amount) ? amount : 0,
            currencyCode: text(live.currency_code) || stored?.currencyCode || 'AED',
        };
    }
    if (stored && stored.outstandingPayableAmount != null && stored.outstandingPayableAmount !== '') {
        const amount = Number(stored.outstandingPayableAmount);
        return {
            outstandingPayment: Number.isFinite(amount) ? amount : 0,
            currencyCode: text(stored.currencyCode) || 'AED',
        };
    }
    return { outstandingPayment: null, currencyCode: 'AED' };
}

function presentVendor(row, primary) {
    const brands = Array.isArray(row.brands) ? row.brands.filter(Boolean) : [];
    const primaryPhone = Array.isArray(primary?.phones) ? primary.phones.find(Boolean) : '';
    return {
        id: row._id,
        code: row.vendorCode,
        zohoContactId: row.zohoContactId || '',
        name: row.name,
        location: row.location || '',
        address: row.address || row.location || '',
        contact: primary?.name || row.primaryContact || '',
        email: row.email || '',
        phone: primaryPhone || row.phone || '',
        website: row.website || '',
        taxRegNo: row.taxRegNo || '',
        brands,
        products: row.productCount == null ? null : Number(row.productCount) || 0,
        vendorType: row.vendorType || '',
        paymentTerms: row.paymentTerms || '',
        status: row.status || 'Active',
    };
}

async function primaryContactsFor(vendorIds) {
    if (!vendorIds.length) return new Map();
    const rows = await InventoryVendorContact.find({ vendorId: { $in: vendorIds }, isPrimary: true })
        .select('vendorId name phones')
        .lean();
    return new Map(rows.map((row) => [String(row.vendorId), row]));
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

async function refreshVendorFromZoho(row) {
    if (!row?.zohoContactId) return { vendor: row, zohoRaw: {} };
    const source = await zohoSource({
        ...row,
        companyName: row.name,
        contactName: row.primaryContact,
        email: row.email,
        phone: row.phone,
        locationName: row.location,
        paymentTermsLabel: row.paymentTerms,
        isActive: row.status !== 'Inactive',
        zohoRaw: {},
    });
    const fresh = fieldsFromZoho(source);
    const patch = {};
    const fillBlank = (key, saved, incoming) => {
        if (!text(saved) && text(incoming)) patch[key] = text(incoming);
    };
    fillBlank('name', row.name, fresh.name);
    fillBlank('location', row.location, fresh.location);
    fillBlank('address', row.address, fresh.address);
    fillBlank('primaryContact', row.primaryContact, fresh.primaryContact);
    fillBlank('email', row.email, fresh.email);
    fillBlank('phone', row.phone, fresh.phone);
    fillBlank('website', row.website, fresh.website);
    fillBlank('taxRegNo', row.taxRegNo, fresh.taxRegNo);
    fillBlank('paymentTerms', row.paymentTerms, fresh.paymentTerms);
    if (patch.name) patch.nameKey = nameKey(patch.name);
    const updated = Object.keys(patch).length
        ? await InventoryVendor.findByIdAndUpdate(row._id, patch, { new: true }).lean()
        : row;
    return {
        vendor: updated || { ...row, ...patch },
        zohoRaw: source.zohoRaw && typeof source.zohoRaw === 'object' ? source.zohoRaw : {},
    };
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
            isPrimary: false,
            brands: [],
            lines: [],
            source: 'zoho',
        };
    }).filter(Boolean);

    if (!rows.length && (vendor.primaryContact || vendor.email || vendor.phone)) {
        rows.push({
            id: 'zoho-vendor',
            name: vendor.primaryContact || 'Contact',
            designation: '',
            emails: vendor.email ? [vendor.email] : [],
            phones: vendor.phone ? [vendor.phone] : [],
            isPrimary: false,
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
        brands: brandList(body?.brands),
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

export async function createVendor(req, res) {
    try {
        const fields = await vendorFromZoho(req.body?.zohoContactId);
        const vendorCode = text(req.body?.vendorCode) || await allocateVendorCode();
        const edits = readVendorEdits({ ...req.body, vendorCode }, { ...fields, vendorCode });
        const saved = await InventoryVendor.create({
            ...fields,
            ...edits,
            zohoContactId: fields.zohoContactId,
        });
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
    const { vendor, zohoRaw } = await refreshVendorFromZoho(row);
    return zohoContactRows(zohoRaw, vendor).find((contact) => contact.id === zohoId) || null;
}

export async function suppressZohoContactId(vendorId, zohoId) {
    await InventoryVendor.updateOne(
        { _id: vendorId },
        { $addToSet: { suppressedZohoContactIds: zohoId } },
    );
}

async function loadVendorDetail(row) {
    const { vendor: fresh, zohoRaw } = await refreshVendorFromZoho(row);
    const zohoDoc = fresh.zohoContactId
        ? await ZohoVendor.findOne({ zohoContactId: String(fresh.zohoContactId) })
            .select('outstandingPayableAmount currencyCode')
            .lean()
        : null;
    const outstanding = outstandingPaymentFromZoho(zohoRaw, zohoDoc);
    const [contacts, primaryMap] = await Promise.all([
        InventoryVendorContact.find({ vendorId: fresh._id }).sort({ isPrimary: -1, createdAt: 1 }).lean(),
        primaryContactsFor([fresh._id]),
    ]);
    const localContacts = contacts.map((contact) => ({ ...presentContact(contact), source: 'local' }));
    const hidden = new Set([
        ...(row.suppressedZohoContactIds || []),
        ...contacts.map((contact) => contact.zohoPersonId).filter(Boolean),
    ]);
    const zohoContacts = zohoContactRows(zohoRaw, fresh).filter((contact) => !hidden.has(contact.id));
    return {
        ...presentVendor(fresh, primaryMap.get(String(fresh._id))),
        ...outstanding,
        contacts: await withBrandImages(mergeContacts(localContacts, zohoContacts)),
    };
}

async function withBrandImages(contacts) {
    const ids = [...new Set(contacts.flatMap((contact) => (
        (contact.lines || []).map((line) => line.brandId).filter((id) => mongoose.isValidObjectId(id))
    )))];
    if (!ids.length) return contacts;
    const rows = await ItemBrand.find({ _id: { $in: ids } }).select('imageData').lean();
    const images = new Map(rows.map((row) => [String(row._id), row.imageData || '']));
    return contacts.map((contact) => ({
        ...contact,
        lines: (contact.lines || []).map((line) => ({
            ...line,
            brandImage: images.get(String(line.brandId)) || '',
        })),
    }));
}

async function requireInventoryVendor(id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Vendor was not found.');
    const row = await InventoryVendor.findById(id).lean();
    if (!row) throw httpError(404, 'Vendor was not found.');
    return row;
}

function removedBillStatus(status) {
    const value = String(status || '').trim().toLowerCase();
    return value === 'void' || value === 'deleted';
}

async function syncVendorBills(zohoContactId) {
    const organizationId = getZohoOrganizationId();
    const vendorId = String(zohoContactId);
    const seen = new Set();
    let page = 1;
    for (let guard = 0; guard < 40; guard += 1) {
        const chunk = await fetchBillsChunk({ vendor_id: vendorId }, { startPage: page, maxRows: 200 });
        const rows = Array.isArray(chunk?.rows) ? chunk.rows : [];
        const live = [];
        const removed = [];
        rows.forEach((row) => {
            const id = String(row?.bill_id || row?.id || '').trim();
            if (removedBillStatus(row?.status)) {
                if (id) removed.push(id);
                return;
            }
            if (id) seen.add(id);
            live.push(row);
        });
        if (removed.length) {
            await ZohoBill.deleteMany({ organizationId, zohoBillId: { $in: removed } });
        }
        if (live.length) {
            const syncedAt = new Date();
            const ops = live.map((row) => {
                const doc = mapZohoBillToDoc(row, organizationId, syncedAt);
                if (!doc) return null;
                return {
                    updateOne: {
                        filter: { organizationId, zohoBillId: doc.zohoBillId },
                        update: { $set: { ...doc, isActive: true } },
                        upsert: true,
                    },
                };
            }).filter(Boolean);
            if (ops.length) await ZohoBill.bulkWrite(ops, { ordered: false });
        }
        if (!chunk?.hasMore) break;
        const next = Number(chunk.nextPage);
        if (!next || next === page) break;
        page = next;
    }
    await ZohoBill.deleteMany({
        organizationId,
        vendorId,
        ...(seen.size ? { zohoBillId: { $nin: [...seen] } } : {}),
    });
}

async function billsForVendor(zohoContactId) {
    const vendorId = String(zohoContactId || '').trim();
    if (!vendorId) return [];
    const organizationId = getZohoOrganizationId();
    const docs = await ZohoBill.find({
        organizationId,
        vendorId,
        isActive: { $ne: false },
        status: { $not: /^(void|deleted)$/i },
    }).sort({ date: -1, billNumber: 1 }).lean();
    return docs.map((doc) => toZohoBillApiShape(doc)).filter(Boolean);
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
        res.json({ bills: await billsForVendor(row.zohoContactId) });
    } catch (error) {
        sendError(res, error);
    }
}

export async function syncVendorFromZoho(req, res) {
    try {
        const row = await requireInventoryVendor(req.params.id);
        if (!text(row.zohoContactId)) throw httpError(400, 'This vendor is not linked to Zoho.');
        await syncVendorBills(row.zohoContactId);
        const detail = await loadVendorDetail(row);
        if (detail.outstandingPayment != null) {
            await ZohoVendor.updateOne(
                { zohoContactId: String(row.zohoContactId) },
                {
                    $set: {
                        outstandingPayableAmount: detail.outstandingPayment,
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
        const edits = readVendorEdits(req.body, base);
        const saved = await InventoryVendor.findByIdAndUpdate(row._id, {
            ...edits,
            zohoContactId,
        }, { new: true, runValidators: true }).lean();
        const primaryMap = await primaryContactsFor([saved._id]);
        res.json(presentVendor(saved, primaryMap.get(String(saved._id))));
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

export async function listVendors(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 6));
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

        const [rows, total, products, brands, contactBrands, terms] = await Promise.all([
            InventoryVendor.find(filter)
                .sort({ vendorCode: 1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            InventoryVendor.countDocuments(filter),
            InventoryVendorContact.distinct('lines.categoryName'),
            InventoryVendor.distinct('brands'),
            InventoryVendorContact.distinct('lines.brandName'),
            InventoryVendor.distinct('paymentTerms'),
        ]);
        const vendorIds = rows.map((row) => row._id);
        const [primaryMap, catalog] = await Promise.all([
            primaryContactsFor(vendorIds),
            contactNamesFor(vendorIds),
        ]);

        res.json({
            vendors: rows.map((row) => {
                const names = catalog.get(String(row._id)) || { brands: [], categories: [] };
                return {
                    ...presentVendor(row, primaryMap.get(String(row._id))),
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

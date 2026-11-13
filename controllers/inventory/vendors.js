import mongoose from 'mongoose';
import ZohoVendor from '../../models/ZohoVendor.js';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import InventoryVendorContact from '../../models/inventory/InventoryVendorContact.js';
import { fetchVendorContact, getZohoOrganizationId } from '../../services/zohoService.js';
import { isReqUserSystemSuperUser } from '../../utils/systemSuperUser.js';
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

function kept(next, previous) {
    return next || previous || '';
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
    const patch = {
        name: kept(fresh.name, row.name),
        nameKey: nameKey(kept(fresh.name, row.name)),
        location: kept(fresh.location, row.location),
        address: kept(fresh.address, row.address),
        primaryContact: kept(fresh.primaryContact, row.primaryContact),
        email: kept(fresh.email, row.email),
        phone: kept(fresh.phone, row.phone),
        website: kept(fresh.website, row.website),
        taxRegNo: kept(fresh.taxRegNo, row.taxRegNo),
        paymentTerms: kept(fresh.paymentTerms, row.paymentTerms),
        status: fresh.status || row.status || 'Active',
    };
    const updated = await InventoryVendor.findByIdAndUpdate(row._id, patch, { new: true }).lean();
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
            id: 'zoho-primary',
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

    const primary = rows.find((row) => row.isPrimary);
    if (primary) {
        if (!primary.emails.length && vendor.email) primary.emails = [vendor.email];
        if (!primary.phones.length && vendor.phone) primary.phones = [vendor.phone];
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
        const vendorCode = await allocateVendorCode();
        const saved = await InventoryVendor.create({
            ...fields,
            vendorCode,
            nameKey: nameKey(fields.name),
        });
        res.status(201).json(presentVendor(saved));
    } catch (error) {
        if (error?.code === 11000) {
            const keys = Object.keys(error.keyPattern || {});
            if (keys.includes('zohoContactId')) {
                sendError(res, httpError(400, 'This vendor is already added.'));
                return;
            }
            sendError(res, httpError(400, 'Vendor code was already used. Save again.'));
            return;
        }
        sendError(res, error);
    }
}

export async function getVendor(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Vendor was not found.');
        const row = await InventoryVendor.findById(req.params.id).lean();
        if (!row) throw httpError(404, 'Vendor was not found.');
        const { vendor: fresh, zohoRaw } = await refreshVendorFromZoho(row);
        const [contacts, primaryMap] = await Promise.all([
            InventoryVendorContact.find({ vendorId: fresh._id }).sort({ isPrimary: -1, createdAt: 1 }).lean(),
            primaryContactsFor([fresh._id]),
        ]);
        const localContacts = contacts.map((contact) => ({ ...presentContact(contact), source: 'local' }));
        res.json({
            ...presentVendor(fresh, primaryMap.get(String(fresh._id))),
            contacts: mergeContacts(localContacts, zohoContactRows(zohoRaw, fresh)),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteVendor(req, res) {
    try {
        if (!(await isReqUserSystemSuperUser(req.user))) {
            throw httpError(403, 'Only an admin super user can delete a vendor.');
        }
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
        const vendorType = cleanName(req.query.vendorType);
        const brand = cleanName(req.query.brand);
        const paymentTerms = cleanName(req.query.paymentTerms);
        const status = STATUSES.includes(req.query.status) ? req.query.status : '';
        const search = cleanName(req.query.search);

        if (vendorType) filter.vendorType = vendorType;
        if (brand) filter.brands = brand;
        if (paymentTerms) filter.paymentTerms = paymentTerms;
        if (status) filter.status = status;
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            filter.$or = [
                { vendorCode: regex },
                { name: regex },
                { location: regex },
                { primaryContact: regex },
                { email: regex },
                { phone: regex },
                { brands: regex },
            ];
        }

        const [rows, total, vendorTypes, brands, terms, statuses] = await Promise.all([
            InventoryVendor.find(filter)
                .sort({ vendorCode: 1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            InventoryVendor.countDocuments(filter),
            InventoryVendor.distinct('vendorType'),
            InventoryVendor.distinct('brands'),
            InventoryVendor.distinct('paymentTerms'),
            InventoryVendor.distinct('status'),
        ]);
        const primaryMap = await primaryContactsFor(rows.map((row) => row._id));

        res.json({
            vendors: rows.map((row) => presentVendor(row, primaryMap.get(String(row._id)))),
            total,
            page,
            limit,
            filters: {
                vendorTypes: filled(vendorTypes),
                brands: filled(brands),
                paymentTerms: filled(terms),
                statuses: filled(statuses),
            },
        });
    } catch (error) {
        sendError(res, error);
    }
}

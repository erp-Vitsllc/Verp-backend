import mongoose from 'mongoose';
import CrmCustomer from '../../models/crm/CrmCustomer.js';
import CrmCustomerContact from '../../models/crm/CrmCustomerContact.js';
import { cleanName, httpError, requireName, sendError } from '../inventory/http.js';

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

export function presentCustomerContact(row) {
    return {
        id: row._id,
        name: row.name,
        designation: row.designation || '',
        emails: Array.isArray(row.emails) ? row.emails : [],
        phones: Array.isArray(row.phones) ? row.phones : [],
        isPrimary: Boolean(row.isPrimary),
        source: 'local',
    };
}

function readContactBody(body) {
    const name = requireName(body?.name, 'Name');
    const entries = Array.isArray(body?.entries) ? body.entries.slice(0, 20) : [];
    assertContactChannels(entries);
    return {
        name,
        designation: cleanName(body?.designation).slice(0, 120),
        emails: textList(entries, 'email'),
        phones: textList(entries, 'phone'),
    };
}

async function requireCustomer(id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Customer was not found.');
    const customer = await CrmCustomer.findById(id).select('_id').lean();
    if (!customer) throw httpError(404, 'Customer was not found.');
    return customer;
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

export function mergeCustomerContacts(localRows, zohoRows) {
    const extras = zohoRows.filter((zoho) => !localRows.some((local) => {
        const zohoEmails = (zoho.emails || []).map((email) => email.toLowerCase());
        if (zohoEmails.length && (local.emails || []).some((email) => zohoEmails.includes(email.toLowerCase()))) return true;
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

async function makeOnlyPrimary(customerId, contactId) {
    await CrmCustomerContact.updateMany(
        { customerId },
        { $set: { isPrimary: false } },
    );
    const updated = await CrmCustomerContact.updateOne(
        { _id: contactId, customerId },
        { $set: { isPrimary: true } },
    );
    if (!updated.matchedCount) throw httpError(404, 'Contact was not found.');
}

async function localCopyOfZoho(customerId, zohoId) {
    const existing = await CrmCustomerContact.findOne({ customerId, zohoPersonId: zohoId }).lean();
    if (existing) return existing;
    const { findVisibleZohoContact, suppressCustomerZohoContact } = await import('./customers.js');
    const snapshot = await findVisibleZohoContact(customerId, zohoId);
    if (!snapshot) throw httpError(404, 'Contact was not found.');
    const saved = await CrmCustomerContact.create({
        customerId,
        zohoPersonId: zohoId,
        name: snapshot.name || 'Contact',
        designation: snapshot.designation || '',
        emails: snapshot.emails || [],
        phones: snapshot.phones || [],
        isPrimary: false,
    });
    await suppressCustomerZohoContact(customerId, zohoId);
    return saved.toObject();
}

function isZohoContactId(value) {
    return String(value || '').startsWith('zoho-');
}

async function rememberPrimary(customerId, contact) {
    await CrmCustomer.updateOne(
        { _id: customerId },
        {
            $set: {
                primaryContact: contact?.name || '',
                email: contact?.emails?.[0] || '',
                phone: contact?.phones?.[0] || '',
            },
        },
    );
}

export async function createCustomerContact(req, res) {
    try {
        const customer = await requireCustomer(req.params.id);
        const payload = readContactBody(req.body);
        const saved = await CrmCustomerContact.create({ ...payload, customerId: customer._id, isPrimary: false });
        const row = await CrmCustomerContact.findById(saved._id).lean();
        res.status(201).json(presentCustomerContact(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateCustomerContact(req, res) {
    try {
        const customer = await requireCustomer(req.params.id);
        let contactId = req.params.contactId;
        if (isZohoContactId(contactId)) {
            const copied = await localCopyOfZoho(customer._id, contactId);
            contactId = copied._id;
        } else if (!mongoose.isValidObjectId(contactId)) {
            throw httpError(404, 'Contact was not found.');
        }
        const payload = readContactBody(req.body);
        const row = await CrmCustomerContact.findOneAndUpdate(
            { _id: contactId, customerId: customer._id },
            payload,
            { new: true },
        ).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        if (row.isPrimary) await rememberPrimary(customer._id, row);
        res.json(presentCustomerContact(row));
    } catch (error) {
        sendError(res, error);
    }
}

export async function deleteCustomerContact(req, res) {
    try {
        const customer = await requireCustomer(req.params.id);
        const contactId = req.params.contactId;
        if (isZohoContactId(contactId)) {
            const { suppressCustomerZohoContact } = await import('./customers.js');
            await CrmCustomerContact.deleteOne({ customerId: customer._id, zohoPersonId: contactId });
            await suppressCustomerZohoContact(customer._id, contactId);
            res.json({ ok: true });
            return;
        }
        if (!mongoose.isValidObjectId(contactId)) throw httpError(404, 'Contact was not found.');
        const row = await CrmCustomerContact.findOneAndDelete({ _id: contactId, customerId: customer._id }).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        if (row.isPrimary) {
            const next = await CrmCustomerContact.findOne({ customerId: customer._id }).sort({ createdAt: 1 }).lean();
            if (next) {
                await makeOnlyPrimary(customer._id, next._id);
                await rememberPrimary(customer._id, next);
            }
        }
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

export async function markCustomerContactPrimary(req, res) {
    try {
        const customer = await requireCustomer(req.params.id);
        let contactId = req.params.contactId;
        if (isZohoContactId(contactId)) {
            const copied = await localCopyOfZoho(customer._id, contactId);
            contactId = copied._id;
        } else if (!mongoose.isValidObjectId(contactId)) {
            throw httpError(404, 'Contact was not found.');
        }
        const row = await CrmCustomerContact.findOne({ _id: contactId, customerId: customer._id }).lean();
        if (!row) throw httpError(404, 'Contact was not found.');
        await makeOnlyPrimary(customer._id, row._id);
        await rememberPrimary(customer._id, row);
        const { loadCustomerDetail } = await import('./customers.js');
        const savedCustomer = await CrmCustomer.findById(customer._id).lean();
        res.json(await loadCustomerDetail(savedCustomer));
    } catch (error) {
        sendError(res, error);
    }
}

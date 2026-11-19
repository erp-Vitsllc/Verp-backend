import mongoose from 'mongoose';
import CrmCustomer from '../../models/crm/CrmCustomer.js';
import CrmCustomerContact from '../../models/crm/CrmCustomerContact.js';
import DeliveryOrder from '../../models/inventory/DeliveryOrder.js';
import WorkOrder from '../../models/WorkOrder.js';
import ZohoCustomer from '../../models/ZohoCustomer.js';
import { fetchCustomerInvoices, fetchVendorContact, getZohoOrganizationId } from '../../services/zohoService.js';
import { escapeRegex } from '../../utils/zohoListQuery.js';
import { cleanName, httpError, listLimit, nameKey, sendError } from '../inventory/http.js';
import {
    mergeCustomerContacts,
    presentCustomerContact,
    withSinglePrimary,
} from './customerContacts.js';

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
    const billing = raw?.billing_address || raw?.address || {};
    const cityLine = text([billing.city, billing.state, billing.country].filter(Boolean).join(', '));
    if (cityLine) return cityLine;
    return text(doc.placeOfContact || raw?.place_of_contact).replace(/[_-]+/g, ' ');
}

function paymentTermsText(raw) {
    const label = text(raw?.payment_terms_label);
    if (label) return label;
    const terms = raw?.payment_terms;
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

function finiteAmount(value) {
    if (value == null || value === '') return null;
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : null;
}

function fieldsFromZoho(doc) {
    const raw = doc.zohoRaw && typeof doc.zohoRaw === 'object' ? doc.zohoRaw : {};
    const name = text(doc.companyName) || text(doc.contactName) || text(raw.customer_name) || text(raw.contact_name) || 'Unnamed customer';
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
        paymentTerms: paymentTermsText(raw),
        brands: [],
        productCount: null,
        status: doc.isActive === false || String(raw.status || '').toLowerCase() === 'inactive' ? 'Inactive' : 'Active',
    };
}

function presentCustomer(row) {
    const brands = Array.isArray(row.brands) ? row.brands.filter(Boolean) : [];
    return {
        id: row._id,
        code: row.customerCode,
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
        paymentTerms: row.paymentTerms || '',
        status: row.status || 'Active',
        saved: true,
    };
}

function filled(values) {
    return [...new Set((values || []).map((value) => cleanName(value)).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right));
}

function brandList(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
    return filled(source);
}

async function allocateCustomerCode() {
    const rows = await CrmCustomer.find().select('customerCode').lean();
    let max = 0;
    rows.forEach((row) => {
        const match = /^CUS-(\d+)$/i.exec(String(row.customerCode || '').trim());
        if (match) max = Math.max(max, Number(match[1]));
    });
    return `CUS-${String(max + 1).padStart(3, '0')}`;
}

async function findZohoCustomer(zohoContactId) {
    const id = text(zohoContactId);
    if (!id) throw httpError(400, 'Select a customer.');
    let organizationId = '';
    try {
        organizationId = getZohoOrganizationId();
    } catch {
        organizationId = '';
    }
    const filter = {
        isActive: true,
        $or: [{ zohoContactId: id }, { zohoCustomerId: id }],
    };
    if (organizationId) filter.organizationId = organizationId;
    const doc = await ZohoCustomer.findOne(filter).lean();
    if (doc) return doc;
    if (!organizationId) return null;
    return ZohoCustomer.findOne({
        isActive: true,
        $or: [{ zohoContactId: id }, { zohoCustomerId: id }],
    }).lean();
}

async function zohoSource(doc) {
    let source = doc;
    try {
        const contact = await fetchVendorContact(doc.zohoContactId);
        if (contact) {
            source = {
                ...doc,
                companyName: text(contact.company_name) || doc.companyName,
                contactName: text(contact.contact_name || contact.customer_name) || doc.contactName,
                email: text(contact.email) || doc.email,
                phone: text(contact.phone) || doc.phone,
                mobile: text(contact.mobile) || doc.mobile,
                zohoRaw: contact,
            };
        }
    } catch {
        source = doc;
    }
    return source;
}

async function customerFromZoho(zohoContactId) {
    const doc = await findZohoCustomer(zohoContactId);
    if (!doc) throw httpError(404, 'That Zoho customer was not found. Refresh Zoho customers and try again.');
    const existing = await CrmCustomer.findOne({ zohoContactId: doc.zohoContactId }).select('_id').lean();
    if (existing) throw httpError(400, 'This customer is already added.');
    return fieldsFromZoho(await zohoSource(doc));
}

function readCustomerEdits(body, base) {
    const name = body && Object.prototype.hasOwnProperty.call(body, 'name') ? text(body.name) : text(base.name);
    if (!name) throw httpError(400, 'Customer name is required.');
    const customerCode = body && Object.prototype.hasOwnProperty.call(body, 'customerCode')
        ? text(body.customerCode)
        : text(base.customerCode);
    if (!customerCode) throw httpError(400, 'Customer code is required.');
    if (customerCode.length > 40) throw httpError(400, 'Customer code must be 40 characters or less.');
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
        customerCode,
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
        status,
    };
}

function duplicateCustomerMessage(error) {
    const keys = Object.keys(error?.keyPattern || {});
    if (keys.includes('customerCode')) return httpError(400, 'Customer code was already used. Save again.');
    if (keys.includes('zohoContactId')) return httpError(400, 'This customer is already added.');
    return httpError(400, 'This customer is already added.');
}

function contactRows(raw, customer) {
    const people = Array.isArray(raw?.contact_persons) ? raw.contact_persons : [];
    const rows = people.map((person, index) => {
        const name = personName(person);
        const emails = [text(person?.email)].filter(Boolean);
        const phones = [text(person?.phone), text(person?.mobile)].filter(Boolean);
        if (!name && !emails.length && !phones.length) return null;
        return {
            id: `zoho-${person?.contact_person_id || index}`,
            name: name || customer.primaryContact || 'Contact',
            designation: text(person?.designation || person?.department),
            emails,
            phones,
            isPrimary: Boolean(person?.is_primary_contact),
            brands: [],
            source: 'zoho',
        };
    }).filter(Boolean);

    if (!rows.some((row) => row.isPrimary) && rows.length) {
        const match = customer.primaryContact
            ? rows.find((row) => row.name.toLowerCase() === customer.primaryContact.toLowerCase())
            : null;
        (match || rows[0]).isPrimary = true;
    }

    if (!rows.length && (customer.primaryContact || customer.email || customer.phone)) {
        rows.push({
            id: 'zoho-customer',
            name: customer.primaryContact || 'Contact',
            designation: '',
            emails: customer.email ? [customer.email] : [],
            phones: customer.phone ? [customer.phone] : [],
            isPrimary: true,
            brands: [],
            source: 'zoho',
        });
    }
    return rows;
}

function firstAmount(...values) {
    for (const value of values) {
        const amount = finiteAmount(value);
        if (amount != null) return amount;
    }
    return null;
}

function amountsFromZoho(raw, stored) {
    const live = raw && typeof raw === 'object' && Object.keys(raw).length ? raw : null;
    const storedRaw = stored?.zohoRaw && typeof stored.zohoRaw === 'object' ? stored.zohoRaw : null;
    const source = live || storedRaw;
    const outstanding = firstAmount(
        live?.outstanding_receivable_amount,
        live?.outstanding_receivable_amount_bcy,
        stored?.outstandingReceivableAmount,
        storedRaw?.outstanding_receivable_amount,
        storedRaw?.outstanding_receivable_amount_bcy,
    );
    const credits = firstAmount(
        live?.unused_credits_receivable_amount,
        live?.unused_credits_receivable_amount_bcy,
        storedRaw?.unused_credits_receivable_amount,
        storedRaw?.unused_credits_receivable_amount_bcy,
        stored?.unusedCreditsReceivableAmount,
    );
    return {
        outstandingPayment: outstanding == null ? 0 : outstanding,
        unusedCredits: credits == null ? 0 : credits,
        currencyCode: text(source?.currency_code) || text(stored?.currencyCode) || 'AED',
    };
}

async function requireCustomer(id) {
    if (!mongoose.isValidObjectId(id)) throw httpError(404, 'Customer was not found.');
    const row = await CrmCustomer.findById(id).lean();
    if (!row) throw httpError(404, 'Customer was not found.');
    return row;
}

export async function findVisibleZohoContact(customerId, zohoId) {
    const row = await CrmCustomer.findById(customerId).lean();
    if (!row) return null;
    const adopted = await CrmCustomerContact.findOne({ customerId, zohoPersonId: zohoId }).select('_id').lean();
    if (adopted) return null;
    if ((row.suppressedZohoContactIds || []).map(String).includes(String(zohoId))) return null;
    const source = row.zohoContactId
        ? await zohoSource({
            zohoContactId: row.zohoContactId,
            companyName: row.name,
            contactName: row.primaryContact,
            email: row.email,
            phone: row.phone,
        })
        : { zohoRaw: {} };
    const zohoRaw = source.zohoRaw && typeof source.zohoRaw === 'object' ? source.zohoRaw : {};
    return contactRows(zohoRaw, row).find((contact) => contact.id === zohoId) || null;
}

export async function suppressCustomerZohoContact(customerId, zohoId) {
    await CrmCustomer.updateOne(
        { _id: customerId },
        { $addToSet: { suppressedZohoContactIds: String(zohoId) } },
    );
}

export async function loadCustomerDetail(row) {
    const zohoDoc = row.zohoContactId
        ? await ZohoCustomer.findOne({
            $or: [{ zohoContactId: String(row.zohoContactId) }, { zohoCustomerId: String(row.zohoContactId) }],
        }).lean()
        : null;
    const source = row.zohoContactId
        ? await zohoSource({
            ...(zohoDoc || {}),
            zohoContactId: row.zohoContactId,
            companyName: row.name,
            contactName: row.primaryContact,
            email: row.email,
            phone: row.phone,
        })
        : { zohoRaw: {} };
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
        ? await CrmCustomer.findByIdAndUpdate(row._id, patch, { new: true }).lean()
        : row;
    const current = updated || { ...row, ...patch };
    const zohoRaw = source.zohoRaw && typeof source.zohoRaw === 'object' ? source.zohoRaw : {};
    const localRows = await CrmCustomerContact.find({ customerId: current._id }).sort({ isPrimary: -1, createdAt: 1 }).lean();
    const hidden = new Set([
        ...(current.suppressedZohoContactIds || []).map((id) => String(id)),
        ...localRows.map((contact) => contact.zohoPersonId).filter(Boolean),
    ]);
    const contacts = withSinglePrimary(mergeCustomerContacts(
        localRows.map(presentCustomerContact),
        contactRows(zohoRaw, current).filter((contact) => !hidden.has(contact.id)),
    ));
    const primary = contacts.find((contact) => contact.isPrimary) || null;
    return {
        ...presentCustomer(current),
        ...amountsFromZoho(zohoRaw, zohoDoc),
        contact: primary?.name || current.primaryContact || '',
        phone: primary?.phones?.[0] || current.phone || '',
        email: primary?.emails?.[0] || current.email || '',
        contacts,
    };
}

export async function nextCustomerCode(_req, res) {
    try {
        const [customerCode, linkedZohoIds] = await Promise.all([
            allocateCustomerCode(),
            CrmCustomer.distinct('zohoContactId'),
        ]);
        res.json({
            customerCode,
            linkedZohoIds: linkedZohoIds.map((id) => String(id || '')).filter(Boolean),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function previewZohoCustomer(req, res) {
    try {
        const fields = await customerFromZoho(req.query.zohoContactId);
        const customerCode = await allocateCustomerCode();
        res.json({ customerCode, ...presentCustomer({ ...fields, customerCode, _id: '' }) });
    } catch (error) {
        sendError(res, error);
    }
}

export async function createCustomer(req, res) {
    try {
        const fields = await customerFromZoho(req.body?.zohoContactId);
        const customerCode = text(req.body?.customerCode) || await allocateCustomerCode();
        const edits = readCustomerEdits({ ...req.body, customerCode }, { ...fields, customerCode });
        const saved = await CrmCustomer.create({
            ...fields,
            ...edits,
            zohoContactId: fields.zohoContactId,
        });
        res.status(201).json(presentCustomer(saved));
    } catch (error) {
        if (error?.code === 11000) {
            sendError(res, duplicateCustomerMessage(error));
            return;
        }
        sendError(res, error);
    }
}

async function detailFromZohoDoc(doc) {
    const source = await zohoSource(doc);
    const fields = fieldsFromZoho(source);
    const zohoRaw = source.zohoRaw && typeof source.zohoRaw === 'object' ? source.zohoRaw : {};
    const contacts = contactRows(zohoRaw, fields);
    const primary = contacts.find((contact) => contact.isPrimary) || null;
    return {
        ...presentCustomer({ ...fields, customerCode: '', _id: doc.zohoContactId, brands: [], productCount: null }),
        id: String(doc.zohoContactId),
        saved: false,
        code: '',
        ...amountsFromZoho(zohoRaw, doc),
        contact: primary?.name || fields.primaryContact || '',
        phone: primary?.phones?.[0] || fields.phone || '',
        email: primary?.emails?.[0] || fields.email || '',
        contacts,
    };
}

async function customerDetailById(id) {
    if (mongoose.isValidObjectId(id)) {
        const row = await CrmCustomer.findById(id).lean();
        if (row) return loadCustomerDetail(row);
    }
    const doc = await findZohoCustomer(id);
    if (!doc) throw httpError(404, 'Customer was not found.');
    const local = await CrmCustomer.findOne({ zohoContactId: doc.zohoContactId }).lean();
    if (local) return loadCustomerDetail(local);
    return detailFromZohoDoc(doc);
}

export async function getCustomer(req, res) {
    try {
        res.json(await customerDetailById(req.params.id));
    } catch (error) {
        sendError(res, error);
    }
}

export async function syncCustomerFromZoho(req, res) {
    try {
        const id = String(req.params.id || '');
        let row = mongoose.isValidObjectId(id) ? await CrmCustomer.findById(id).lean() : null;
        if (!row) {
            const doc = await findZohoCustomer(id);
            if (!doc) throw httpError(404, 'Customer was not found.');
            row = await CrmCustomer.findOne({ zohoContactId: doc.zohoContactId }).lean();
            if (!row) {
                res.json(await detailFromZohoDoc(doc));
                return;
            }
        }
        if (!text(row.zohoContactId)) throw httpError(400, 'This customer is not linked to Zoho.');
        const detail = await loadCustomerDetail(row);
        const amounts = { currencyCode: detail.currencyCode || 'AED' };
        if (detail.outstandingPayment != null) amounts.outstandingReceivableAmount = detail.outstandingPayment;
        if (detail.unusedCredits != null) amounts.unusedCreditsReceivableAmount = detail.unusedCredits;
        await ZohoCustomer.updateOne(
            { zohoContactId: String(row.zohoContactId) },
            { $set: amounts },
        );
        res.json(detail);
    } catch (error) {
        sendError(res, error);
    }
}

export async function updateCustomer(req, res) {
    try {
        const row = await requireCustomer(req.params.id);
        let zohoContactId = text(req.body?.zohoContactId) || row.zohoContactId;
        if (!zohoContactId) throw httpError(400, 'Select a customer.');
        let base = {
            customerCode: row.customerCode,
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
            status: row.status,
        };
        if (String(zohoContactId) !== String(row.zohoContactId)) {
            const doc = await findZohoCustomer(zohoContactId);
            if (!doc) throw httpError(404, 'That Zoho customer was not found.');
            const taken = await CrmCustomer.findOne({
                zohoContactId: doc.zohoContactId,
                _id: { $ne: row._id },
            }).select('_id').lean();
            if (taken) throw httpError(400, 'This customer is already added.');
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
        const edits = readCustomerEdits(req.body, base);
        const saved = await CrmCustomer.findByIdAndUpdate(row._id, {
            ...edits,
            zohoContactId,
        }, { new: true, runValidators: true }).lean();
        res.json(presentCustomer(saved));
    } catch (error) {
        if (error?.code === 11000) {
            sendError(res, duplicateCustomerMessage(error));
            return;
        }
        sendError(res, error);
    }
}

export async function deleteCustomer(req, res) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, 'Customer was not found.');
        const row = await CrmCustomer.findByIdAndDelete(req.params.id).lean();
        if (!row) throw httpError(404, 'Customer was not found.');
        await CrmCustomerContact.deleteMany({ customerId: row._id });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error);
    }
}

function zohoBooksRecordUrl(organizationId, section, recordId) {
    const org = text(organizationId);
    const id = text(recordId);
    if (!org || !id) return '';
    const accounts = text(process.env.ZOHO_ACCOUNTS_BASE_URL) || 'https://accounts.zoho.com';
    let host = 'zoho.com';
    try {
        host = new URL(accounts).hostname.replace(/^accounts\./, '') || host;
    } catch {
        host = 'zoho.com';
    }
    return `https://books.${host}/app/${encodeURIComponent(org)}#/${section}/${encodeURIComponent(id)}`;
}

async function resolveCustomerRecord(id) {
    if (mongoose.isValidObjectId(id)) {
        const row = await CrmCustomer.findById(id).lean();
        if (row) return row;
    }
    const doc = await findZohoCustomer(id);
    if (!doc) throw httpError(404, 'Customer was not found.');
    const local = await CrmCustomer.findOne({ zohoContactId: doc.zohoContactId }).lean();
    if (local) return local;
    return {
        _id: null,
        name: text(doc.companyName) || text(doc.contactName),
        zohoContactId: text(doc.zohoContactId),
    };
}

async function customerMatchNames(row) {
    const names = [row.name];
    if (row.zohoContactId) {
        const doc = await ZohoCustomer.findOne({
            $or: [{ zohoContactId: String(row.zohoContactId) }, { zohoCustomerId: String(row.zohoContactId) }],
        }).select('companyName contactName').lean();
        if (doc) names.push(doc.companyName, doc.contactName);
    }
    return [...new Set(names.map((name) => text(name)).filter((name) => name.length >= 2))];
}

function exactNamePattern(value) {
    return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

export async function listCustomerInvoices(req, res) {
    try {
        const row = await resolveCustomerRecord(req.params.id);
        const zohoId = text(row.zohoContactId);
        if (!zohoId) {
            res.json({ invoices: [] });
            return;
        }
        const invoices = await fetchCustomerInvoices(zohoId);
        let organizationId = '';
        try {
            organizationId = getZohoOrganizationId();
        } catch {
            organizationId = '';
        }
        res.json({
            invoices: invoices.map((invoice) => ({
                id: text(invoice.invoice_id || invoice.invoice_number),
                date: text(invoice.date),
                number: text(invoice.invoice_number),
                reference: text(invoice.reference_number),
                status: text(invoice.status),
                dueDate: text(invoice.due_date),
                total: Number(invoice.total) || 0,
                balance: Number(invoice.balance) || 0,
                currencyCode: text(invoice.currency_code) || 'AED',
                zohoUrl: zohoBooksRecordUrl(organizationId, 'invoices', invoice.invoice_id),
            })).filter((invoice) => invoice.id),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function listCustomerDeliveries(req, res) {
    try {
        const row = await resolveCustomerRecord(req.params.id);
        const names = await customerMatchNames(row);
        const ids = [row._id ? String(row._id) : '', text(row.zohoContactId)].filter(Boolean);
        const or = [];
        if (ids.length) or.push({ customerId: { $in: ids } });
        names.forEach((name) => or.push({ customerName: exactNamePattern(name) }));
        const rows = or.length
            ? await DeliveryOrder.find({ $or: or })
                .sort({ createdAt: -1 })
                .limit(200)
                .select('deliveryNo deliveryType status doDate projectName customerName lines')
                .lean()
            : [];
        res.json({
            deliveries: rows.map((delivery) => ({
                id: String(delivery._id),
                deliveryNo: delivery.deliveryNo,
                deliveryType: delivery.deliveryType,
                status: delivery.status,
                doDate: delivery.doDate || '',
                projectName: delivery.projectName || '',
                customerName: delivery.customerName || '',
                itemCount: Array.isArray(delivery.lines) ? delivery.lines.length : 0,
                lines: (delivery.lines || []).map((line) => ({
                    itemName: line.itemName || '',
                    description: line.description || '',
                    quantity: line.quantity || 0,
                    unit: line.unit || '',
                })),
            })),
        });
    } catch (error) {
        sendError(res, error);
    }
}

export async function listCustomerProjects(req, res) {
    try {
        const row = await resolveCustomerRecord(req.params.id);
        const names = await customerMatchNames(row);
        const patterns = names.map(exactNamePattern);
        const rows = patterns.length
            ? await WorkOrder.find({ customer: { $in: patterns } })
                .sort({ createdAt: -1 })
                .limit(200)
                .select('workOrderNo createdOn status type value invoicedAmount projectName')
                .lean()
            : [];
        res.json({
            projects: rows.map((order) => ({
                id: String(order._id),
                workOrderNo: order.workOrderNo,
                projectName: order.projectName || '',
                status: order.status || '',
                type: order.type || '',
                value: Number(order.value) || 0,
                invoicedAmount: Number(order.invoicedAmount) || 0,
                createdOn: order.createdOn || '',
            })),
        });
    } catch (error) {
        sendError(res, error);
    }
}

function sameText(left, right) {
    return text(left).toLowerCase() === text(right).toLowerCase();
}

export async function listCustomers(req, res) {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = listLimit(req.query.limit);
        const product = cleanName(req.query.product);
        const brand = cleanName(req.query.brand);
        const paymentTerms = cleanName(req.query.paymentTerms);
        const search = cleanName(req.query.search).toLowerCase();
        const locals = await CrmCustomer.find().sort({ customerCode: 1 }).lean();
        const contactIds = locals.map((row) => text(row.zohoContactId)).filter(Boolean);
        const zohoDocs = contactIds.length
            ? await ZohoCustomer.find({
                $or: [{ zohoContactId: { $in: contactIds } }, { zohoCustomerId: { $in: contactIds } }],
            }).select('zohoContactId zohoCustomerId outstandingReceivableAmount unusedCreditsReceivableAmount currencyCode zohoRaw').lean()
            : [];
        const all = locals.map((row) => {
            const contactId = text(row.zohoContactId);
            const zoho = zohoDocs.find((doc) => text(doc.zohoContactId) === contactId || text(doc.zohoCustomerId) === contactId);
            return {
                ...presentCustomer(row),
                ...amountsFromZoho(zoho?.zohoRaw, zoho),
                listBrands: Array.isArray(row.brands) ? row.brands.filter(Boolean) : [],
            };
        });
        const filters = {
            products: filled(all.filter((row) => row.products != null).map((row) => String(row.products))),
            brands: filled(all.flatMap((row) => row.listBrands)),
            paymentTerms: filled(all.map((row) => row.paymentTerms)),
        };
        const rows = all.filter((row) => {
            if (paymentTerms && !sameText(row.paymentTerms, paymentTerms)) return false;
            if (brand && !(row.listBrands || []).some((item) => sameText(item, brand))) return false;
            if (product) {
                const count = Number(product);
                if (!Number.isInteger(count) || row.products !== count) return false;
            }
            if (!search) return true;
            return [
                row.code,
                row.name,
                row.location,
                row.contact,
                row.email,
                row.phone,
                row.paymentTerms,
                ...(row.listBrands || []),
            ].join(' ').toLowerCase().includes(search);
        });
        const total = rows.length;
        const customers = limit > 0 ? rows.slice((page - 1) * limit, (page - 1) * limit + limit) : rows;
        res.json({ customers, total, page, limit, filters });
    } catch (error) {
        sendError(res, error);
    }
}

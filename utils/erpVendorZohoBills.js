import AssetItem from '../models/AssetItem.js';
import Fine from '../models/Fine.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import SalaryMonthDmf from '../models/SalaryMonthDmf.js';
import UtilityBillPayment from '../models/UtilityBillPayment.js';
import ZohoBill from '../models/ZohoBill.js';
import ZohoVendor from '../models/ZohoVendor.js';
import { fetchBillByIdAcrossOrgs, getZohoOrganizationId } from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { toZohoBillApiShape } from './zohoPurchaseMappers.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { escapeRegex } from './regexHelper.js';

function text(value) {
    return String(value ?? '').trim();
}

function dateKey(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    const raw = text(value);
    const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
    return '';
}

function amountOf(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return 0;
}

function settled(status) {
    const value = text(status).toLowerCase();
    if (!value) return false;
    if (/unpaid|partial|open|draft|pending|overdue/.test(value)) return false;
    return value === 'paid' || value.includes('paid');
}

function removedStatus(status) {
    const value = text(status).toLowerCase();
    return value === 'void' || value === 'deleted';
}

export function isPendingVendorBill({ status, balance } = {}) {
    if (removedStatus(status)) return false;
    if (settled(status)) return false;
    if (balance != null && Number(balance) > 0.009) return true;
    return /unpaid|partial|open|draft|pending|overdue/.test(text(status).toLowerCase());
}

function fallbackOrganizationId() {
    try {
        return getZohoOrganizationId();
    } catch {
        return '';
    }
}

/** Zoho Books bill page for an ERP bill that was posted to Zoho. */
export function zohoBooksBillUrl(organizationId, billId) {
    const org = text(organizationId);
    const id = text(billId);
    if (!org || !id) return '';
    const accounts = text(process.env.ZOHO_ACCOUNTS_BASE_URL) || 'https://accounts.zoho.com';
    let host = 'zoho.com';
    try {
        host = new URL(accounts).hostname.replace(/^accounts\./, '') || host;
    } catch {
        host = 'zoho.com';
    }
    return `https://books.${host}/app/${encodeURIComponent(org)}#/bills/${encodeURIComponent(id)}`;
}

function remember(bills, entry) {
    const zohoBillId = text(entry?.zohoBillId);
    if (!zohoBillId || bills.has(zohoBillId)) return;
    const total = amountOf(entry.total);
    const status = text(entry.status);
    bills.set(zohoBillId, {
        zohoBillId,
        vendorId: text(entry.vendorId),
        organizationId: text(entry.organizationId),
        date: dateKey(entry.date),
        billNumber: text(entry.billNumber) || text(entry.referenceNumber) || zohoBillId,
        referenceNumber: text(entry.referenceNumber),
        status,
        dueDate: dateKey(entry.dueDate),
        total,
        balance: entry.balance == null ? (settled(status) ? 0 : total) : Number(entry.balance) || 0,
        currencyCode: text(entry.currencyCode) || 'AED',
        source: text(entry.source),
    });
}

function vendorMatches(vendorIds, value) {
    const id = text(value);
    return Boolean(id) && vendorIds.has(id);
}

export function billsFromServiceRemark(remarkValue, context = {}, vendorIds = new Set()) {
    const bills = new Map();
    let remark = remarkValue;
    if (typeof remarkValue === 'string') {
        try {
            remark = JSON.parse(remarkValue);
        } catch {
            return bills;
        }
    }
    if (!remark || typeof remark !== 'object') return bills;

    const multi = Array.isArray(remark.zohoBills) ? remark.zohoBills.filter(Boolean) : [];
    const rows = multi.length ? multi : [remark];
    rows.forEach((row) => {
        const zohoBillId = text(row.zohoBillId);
        const vendorId = text(row.zohoVendorId || remark.zohoVendorId);
        if (!zohoBillId || !vendorMatches(vendorIds, vendorId)) return;
        const erpNumber = text(row.billNumber || remark.billNumber || context.assetId);
        remember(bills, {
            zohoBillId,
            vendorId,
            organizationId: row.zohoOrganizationId || remark.zohoOrganizationId,
            date: row.billDate || remark.billDate || context.serviceDate,
            billNumber: text(row.zohoBillNumber || remark.zohoBillNumber) || erpNumber,
            referenceNumber: erpNumber,
            status: row.zohoBillStatus || remark.zohoBillStatus || row.zohoPaymentStatus || remark.zohoPaymentStatus,
            total: amountOf(
                row.billingTotalAmount,
                row.garageBillAmount,
                remark.billingTotalAmount,
                remark.garageBillAmount,
                context.serviceValue,
            ),
            source: 'Vehicle service',
        });
    });
    return bills;
}

async function vendorIdsFor(zohoContactId) {
    const id = text(zohoContactId);
    if (!id) return new Set();
    const ids = new Set([id]);
    const doc = await ZohoVendor.findOne({
        $or: [{ zohoContactId: id }, { zohoVendorId: id }],
    }).select('zohoContactId zohoVendorId').lean();
    if (doc?.zohoContactId) ids.add(text(doc.zohoContactId));
    if (doc?.zohoVendorId) ids.add(text(doc.zohoVendorId));
    ids.delete('');
    return ids;
}

async function collectErpBills(vendorIds) {
    const bills = new Map();
    const idList = [...vendorIds];
    const salaryVendorId = text(process.env.ZOHO_SALARY_VENDOR_ID);
    const includeSalary = salaryVendorId && vendorIds.has(salaryVendorId);

    const vendorPattern = idList.map((id) => escapeRegex(id)).filter(Boolean).join('|');
    const [fines, utilities, assets, salaryMonths, salaryProfiles] = await Promise.all([
        Fine.find({
            zohoVendorId: { $in: idList },
            zohoBillId: { $gt: '' },
        }).select('fineId zohoBillId zohoBillNumber billNumber billDate awardedDate zohoOrganizationId vendorBillStatus companyAmount totalFineAmount fineAmount').lean(),
        UtilityBillPayment.find({
            zohoVendorId: { $in: idList },
            $or: [
                { zohoBillId: { $gt: '' } },
                { zohoBillIds: { $elemMatch: { $gt: '' } } },
                { 'zohoLineItems.zohoBillId': { $gt: '' } },
            ],
        }).select('billNumber billDate zohoVendorId zohoBillId zohoBillIds zohoBillNumber zohoBillStatus zohoOrganizationId amount zohoLineItems.zohoBillId zohoLineItems.amount createdAt').lean(),
        vendorPattern
            ? AssetItem.find({
                'services.remark': { $regex: `"zohoVendorId"\\s*:\\s*"(${vendorPattern})"` },
            }).select('assetId services.remark services.serviceType services.date services.value').lean()
            : [],
        includeSalary
            ? SalaryMonthDmf.find({ 'dmfApproval.zohoBillId': { $gt: '' } })
                .select('monthKey dmfApproval').lean()
            : [],
        includeSalary
            ? SalaryHistoricalProfile.find({ 'dmfApproval.zohoBillId': { $gt: '' } })
                .select('employeeId dmfApproval').lean()
            : [],
    ]);

    fines.forEach((fine) => {
        const erpNumber = text(fine.billNumber || fine.fineId);
        remember(bills, {
            zohoBillId: fine.zohoBillId,
            organizationId: fine.zohoOrganizationId,
            date: fine.billDate || fine.awardedDate,
            billNumber: text(fine.zohoBillNumber) || erpNumber,
            referenceNumber: erpNumber,
            status: fine.vendorBillStatus,
            total: amountOf(fine.companyAmount, fine.totalFineAmount, fine.fineAmount),
            source: 'Fine',
        });
    });

    utilities.forEach((bill) => {
        const ids = new Set([
            text(bill.zohoBillId),
            ...(Array.isArray(bill.zohoBillIds) ? bill.zohoBillIds.map(text) : []),
            ...(Array.isArray(bill.zohoLineItems) ? bill.zohoLineItems.map((line) => text(line?.zohoBillId)) : []),
        ].filter(Boolean));
        ids.forEach((zohoBillId) => {
            const line = (bill.zohoLineItems || []).find((row) => text(row?.zohoBillId) === zohoBillId);
            const erpNumber = text(bill.billNumber);
            remember(bills, {
                zohoBillId,
                organizationId: bill.zohoOrganizationId,
                date: bill.billDate || bill.createdAt,
                billNumber: text(bill.zohoBillNumber) || erpNumber,
                referenceNumber: erpNumber,
                status: bill.zohoBillStatus,
                total: ids.size > 1 ? amountOf(line?.amount, bill.amount) : amountOf(bill.amount, line?.amount),
                source: 'Utility',
            });
        });
    });

    assets.forEach((asset) => {
        (asset.services || []).forEach((service) => {
            const found = billsFromServiceRemark(service?.remark, {
                assetId: asset.assetId,
                serviceDate: service?.date,
                serviceValue: service?.value,
            }, vendorIds);
            found.forEach((entry, id) => {
                if (!bills.has(id)) bills.set(id, entry);
            });
        });
    });

    const salaryRows = [
        ...salaryMonths.map((row) => ({ label: row.monthKey, dmf: row.dmfApproval })),
        ...salaryProfiles.map((row) => ({ label: row.employeeId, dmf: row.dmfApproval })),
    ];
    salaryRows.forEach(({ label, dmf }) => {
        if (!dmf) return;
        const erpNumber = text(dmf.billLabel || label);
        remember(bills, {
            zohoBillId: dmf.zohoBillId,
            organizationId: dmf.zohoOrganizationId,
            date: dmf.zohoSyncedAt,
            billNumber: text(dmf.zohoBillNumber) || erpNumber,
            referenceNumber: erpNumber,
            status: dmf.zohoBillStatus,
            total: dmf.amount,
            source: 'Salary',
        });
    });

    return [...bills.values()];
}

async function refreshLinkedBills(stubs) {
    const size = 3;
    for (let index = 0; index < stubs.length; index += size) {
        const chunk = stubs.slice(index, index + size);
        await Promise.all(chunk.map(async (stub) => {
            try {
                const live = await fetchBillByIdAcrossOrgs(stub.zohoBillId, stub.organizationId);
                if (!live) return;
                const organizationId = text(stub.organizationId) || fallbackOrganizationId();
                await withZohoOrganization(organizationId, () => upsertZohoBillFromApi(live));
            } catch (error) {
                console.warn(
                    '[VendorBills] Could not refresh Zoho bill',
                    stub.zohoBillId,
                    error?.message || error,
                );
            }
        }));
    }
}

function mergeStub(stub, doc) {
    const shape = doc ? toZohoBillApiShape(doc) : null;
    const status = text(shape?.status || stub.status);
    if (removedStatus(status)) return null;
    const total = shape ? Number(shape.total) || 0 : stub.total;
    const balance = shape ? Number(shape.balance) || 0 : stub.balance;
    return {
        bill_id: stub.zohoBillId,
        date: text(shape?.date) || stub.date,
        bill_number: text(shape?.bill_number) || stub.billNumber,
        reference_number: text(shape?.reference_number) || stub.referenceNumber,
        vendor_id: text(shape?.vendor_id),
        vendor_name: text(shape?.vendor_name),
        status,
        due_date: text(shape?.due_date) || stub.dueDate,
        location_name: text(shape?.location_name),
        total,
        balance,
        currency_code: text(shape?.currency_code) || stub.currencyCode || 'AED',
        erp_source: stub.source,
        zoho_url: zohoBooksBillUrl(
            text(doc?.organizationId) || stub.organizationId || fallbackOrganizationId(),
            stub.zohoBillId,
        ),
    };
}

/**
 * Bills this ERP created and posted to Zoho for one vendor.
 * Does not include other bills that exist only in Zoho.
 */
export async function listErpVendorZohoBills(zohoContactId, { refresh = false } = {}) {
    const vendorIds = await vendorIdsFor(zohoContactId);
    if (!vendorIds.size) return [];
    const stubs = await collectErpBills(vendorIds);
    if (!stubs.length) return [];
    if (refresh) await refreshLinkedBills(stubs);

    const docs = await ZohoBill.find({
        zohoBillId: { $in: stubs.map((stub) => stub.zohoBillId) },
        isActive: { $ne: false },
    }).lean();
    const byId = new Map();
    docs.forEach((doc) => {
        const id = text(doc.zohoBillId);
        const rows = byId.get(id);
        if (rows) rows.push(doc);
        else byId.set(id, [doc]);
    });

    return stubs
        .map((stub) => {
            const rows = byId.get(stub.zohoBillId) || [];
            const doc = rows.find((row) => text(row.organizationId) === text(stub.organizationId)) || rows[0] || null;
            return mergeStub(stub, doc);
        })
        .filter(Boolean)
        .sort((left, right) => {
            const byDate = text(right.date).localeCompare(text(left.date));
            if (byDate) return byDate;
            return text(left.bill_number).localeCompare(text(right.bill_number));
        });
}

function linkAlias(ownersByAlias, alias, owner) {
    const key = text(alias);
    const who = text(owner);
    if (!key || !who) return;
    const set = ownersByAlias.get(key) || new Set();
    set.add(who);
    ownersByAlias.set(key, set);
}

/**
 * Unpaid ERP bills posted to Zoho, counted once per inventory vendor contact id.
 */
export async function pendingErpBillCounts(contactIds) {
    const requested = [...new Set((contactIds || []).map(text).filter(Boolean))];
    const counts = new Map(requested.map((id) => [id, 0]));
    if (!requested.length) return counts;

    const docs = await ZohoVendor.find({
        $or: [{ zohoContactId: { $in: requested } }, { zohoVendorId: { $in: requested } }],
    }).select('zohoContactId zohoVendorId').lean();

    const ownersByAlias = new Map();
    requested.forEach((id) => linkAlias(ownersByAlias, id, id));
    docs.forEach((doc) => {
        const owners = [doc.zohoContactId, doc.zohoVendorId].map(text).filter((id) => counts.has(id));
        owners.forEach((owner) => {
            linkAlias(ownersByAlias, doc.zohoContactId, owner);
            linkAlias(ownersByAlias, doc.zohoVendorId, owner);
        });
    });

    const allIds = [...ownersByAlias.keys()];
    const salaryVendorId = text(process.env.ZOHO_SALARY_VENDOR_ID);
    const includeSalary = Boolean(salaryVendorId && ownersByAlias.has(salaryVendorId));
    const vendorPattern = allIds.map((id) => escapeRegex(id)).filter(Boolean).join('|');
    const [fines, utilities, assets, salaryMonths, salaryProfiles] = await Promise.all([
        Fine.find({
            zohoVendorId: { $in: allIds },
            zohoBillId: { $gt: '' },
        }).select('zohoBillId zohoOrganizationId zohoVendorId vendorBillStatus companyAmount totalFineAmount fineAmount').lean(),
        UtilityBillPayment.find({
            zohoVendorId: { $in: allIds },
            $or: [
                { zohoBillId: { $gt: '' } },
                { zohoBillIds: { $elemMatch: { $gt: '' } } },
                { 'zohoLineItems.zohoBillId': { $gt: '' } },
            ],
        }).select('zohoVendorId zohoBillId zohoBillIds zohoBillStatus zohoOrganizationId amount zohoLineItems.zohoBillId zohoLineItems.amount').lean(),
        vendorPattern
            ? AssetItem.find({
                'services.remark': { $regex: `"zohoVendorId"\\s*:\\s*"(${vendorPattern})"` },
            }).select('assetId services.remark services.date services.value').lean()
            : [],
        includeSalary
            ? SalaryMonthDmf.find({ 'dmfApproval.zohoBillId': { $gt: '' } }).select('dmfApproval').lean()
            : [],
        includeSalary
            ? SalaryHistoricalProfile.find({ 'dmfApproval.zohoBillId': { $gt: '' } }).select('dmfApproval').lean()
            : [],
    ]);

    const stubs = new Map();
    const addStub = (alias, entry) => {
        const owners = ownersByAlias.get(text(alias));
        const zohoBillId = text(entry?.zohoBillId);
        if (!owners?.size || !zohoBillId) return;
        const current = stubs.get(zohoBillId) || {
            zohoBillId,
            organizationId: text(entry.organizationId),
            status: text(entry.status),
            balance: entry.balance == null ? null : Number(entry.balance) || 0,
            owners: new Set(),
        };
        owners.forEach((owner) => current.owners.add(owner));
        stubs.set(zohoBillId, current);
    };

    fines.forEach((fine) => {
        addStub(fine.zohoVendorId, {
            zohoBillId: fine.zohoBillId,
            organizationId: fine.zohoOrganizationId,
            status: fine.vendorBillStatus,
        });
    });
    utilities.forEach((bill) => {
        const ids = new Set([
            text(bill.zohoBillId),
            ...(Array.isArray(bill.zohoBillIds) ? bill.zohoBillIds.map(text) : []),
            ...(Array.isArray(bill.zohoLineItems) ? bill.zohoLineItems.map((line) => text(line?.zohoBillId)) : []),
        ].filter(Boolean));
        ids.forEach((zohoBillId) => {
            addStub(bill.zohoVendorId, {
                zohoBillId,
                organizationId: bill.zohoOrganizationId,
                status: bill.zohoBillStatus,
            });
        });
    });
    const aliasIds = new Set(allIds);
    assets.forEach((asset) => {
        (asset.services || []).forEach((service) => {
            const found = billsFromServiceRemark(service?.remark, {
                assetId: asset.assetId,
                serviceDate: service?.date,
                serviceValue: service?.value,
            }, aliasIds);
            found.forEach((entry) => addStub(entry.vendorId, entry));
        });
    });
    if (includeSalary) {
        [...salaryMonths, ...salaryProfiles].forEach((row) => {
            const dmf = row?.dmfApproval;
            if (!dmf) return;
            addStub(salaryVendorId, {
                zohoBillId: dmf.zohoBillId,
                organizationId: dmf.zohoOrganizationId,
                status: dmf.zohoBillStatus,
            });
        });
    }

    if (!stubs.size) return counts;
    const docsByBill = await ZohoBill.find({
        zohoBillId: { $in: [...stubs.keys()] },
        isActive: { $ne: false },
    }).select('zohoBillId organizationId status balance').lean();
    const byId = new Map();
    docsByBill.forEach((doc) => {
        const id = text(doc.zohoBillId);
        const rows = byId.get(id);
        if (rows) rows.push(doc);
        else byId.set(id, [doc]);
    });

    stubs.forEach((stub) => {
        const rows = byId.get(stub.zohoBillId) || [];
        const doc = rows.find((row) => text(row.organizationId) === text(stub.organizationId)) || rows[0] || null;
        const status = text(doc?.status || stub.status);
        const balance = doc ? Number(doc.balance) || 0 : stub.balance;
        if (!isPendingVendorBill({ status, balance })) return;
        stub.owners.forEach((owner) => {
            if (!counts.has(owner)) return;
            counts.set(owner, counts.get(owner) + 1);
        });
    });
    return counts;
}

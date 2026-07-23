import ZohoVendor from '../models/ZohoVendor.js';
import UtilityEntry from '../models/UtilityEntry.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import {
    createBill,
    markBillAsOpen,
    fetchBillById,
    fetchZohoCurrencies,
    getZohoOrganizationId,
    uploadBillAttachment,
} from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';
import { buildUtilityBillZohoLineItems, collectUtilityZohoBillIds } from './upsertUtilityBalancePartyExpense.js';

function utilityZohoBillExtras(billDoc, line, lineIndex, parentBillNumber) {
    return {
        utilityBillPaymentId: String(billDoc?._id || ''),
        utilityParentBillNumber: String(parentBillNumber || billDoc?.billNumber || ''),
        utilityLineIndex: lineIndex,
        utilityDebitAccountId: String(line?.account_id || line?.accountId || ''),
        utilityDebitAccountName: String(line?.accountName || ''),
        utilityItemDescription: String(line?.description || line?.item || ''),
    };
}

function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Turn stored utility attachment (data URL / base64) into a Zoho upload payload. */
function parseUtilityBillAttachment(attachment = {}) {
    const dataUrl = String(attachment?.dataUrl || '').trim();
    if (!dataUrl) return null;

    let mimeType = String(attachment?.mime || '').trim();
    let base64 = dataUrl;

    const dataMatch = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
    if (dataMatch) {
        if (!mimeType && dataMatch[1]) mimeType = String(dataMatch[1]).trim();
        base64 = dataMatch[2];
    } else {
        const idx = dataUrl.toLowerCase().indexOf('base64,');
        if (idx >= 0) base64 = dataUrl.slice(idx + 7);
    }

    let buffer;
    try {
        buffer = Buffer.from(String(base64 || '').replace(/\s/g, ''), 'base64');
    } catch {
        return null;
    }
    if (!buffer.length) return null;

    let filename = String(attachment?.name || '').trim() || 'bill-attachment.pdf';
    if (!/\.(pdf|png|jpe?g|gif|bmp)$/i.test(filename)) {
        const stem = filename.replace(/\.[^.]+$/, '').trim() || 'bill-attachment';
        const ext =
            /png/i.test(mimeType)
                ? 'png'
                : /jpe?g/i.test(mimeType)
                  ? 'jpg'
                  : /gif/i.test(mimeType)
                    ? 'gif'
                    : /bmp/i.test(mimeType)
                      ? 'bmp'
                      : 'pdf';
        filename = `${stem}.${ext}`;
    }

    return {
        buffer,
        filename: filename.slice(0, 200),
        mimeType: mimeType || 'application/pdf',
    };
}

/**
 * Upload the shared utility bill attachment onto the Zoho bill (if not already synced).
 * Non-blocking for bill create/open — records a soft error when upload fails.
 */
async function syncUtilityBillAttachmentToZoho(billDoc, zohoBillId) {
    const id = String(zohoBillId || billDoc?.zohoBillId || '').trim();
    if (!id) return { ok: true, skipped: true };
    if (billDoc?.zohoAttachmentSyncedAt) return { ok: true, skipped: true };

    const file = parseUtilityBillAttachment(billDoc?.attachment);
    if (!file) return { ok: true, skipped: true };

    try {
        await uploadBillAttachment(id, file);
        billDoc.zohoAttachmentSyncedAt = new Date();
        billDoc.zohoAttachmentName = file.filename;
        console.log(
            `[UtilityBillZoho] Attached ${file.filename} (${file.buffer.length} bytes) to Zoho bill ${id}`,
        );
        return { ok: true, filename: file.filename };
    } catch (err) {
        const message = err?.message || 'Failed to upload bill attachment to Zoho';
        console.warn('[UtilityBillZoho] Attachment upload failed:', message);
        return { ok: false, message };
    }
}

/** Bill month "YYYY-MM" + payment day (1–31) → Zoho bill date. Clamps to last day of month. */
export function utilityBillDateFromMonth(billMonth, paymentDay = 16) {
    const month = String(billMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(month)) return '';

    const [yearStr, monthStr] = month.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;
    if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return '';

    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    let day = Number(paymentDay);
    if (!Number.isInteger(day) || day < 1) day = 16;
    day = Math.min(day, lastDay);

    return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * Prefer exact / whole-word vendor match before loose substring (avoids "Du" → "Dubai …").
 * Pass organizationId (or run inside withZohoOrganization) so VEGA/NNIT vendor caches stay separate.
 */
export async function resolveZohoVendorIdByProvider(providerName, organizationIdArg = '') {
    const name = String(providerName || '').trim();
    if (!name) return '';

    const organizationId =
        String(organizationIdArg || '').trim() || getZohoOrganizationId();
    const exact = new RegExp(`^${escapeRegex(name)}$`, 'i');
    const word = new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}([^a-z0-9]|$)`, 'i');

    const select = 'zohoContactId zohoVendorId contactName companyName';
    const baseFilter = { organizationId, isActive: true };

    let doc = await ZohoVendor.findOne({
        ...baseFilter,
        $or: [{ contactName: exact }, { companyName: exact }],
    })
        .select(select)
        .lean();

    if (!doc) {
        doc = await ZohoVendor.findOne({
            ...baseFilter,
            $or: [{ contactName: word }, { companyName: word }],
        })
            .select(select)
            .lean();
    }

    if (!doc && name.length >= 4) {
        const contains = new RegExp(escapeRegex(name), 'i');
        doc = await ZohoVendor.findOne({
            ...baseFilter,
            $or: [{ contactName: contains }, { companyName: contains }],
        })
            .select(select)
            .lean();
    }

    if (!doc) {
        const needle = name.toLowerCase();
        const candidates = await ZohoVendor.find(baseFilter).select(select).limit(500).lean();
        doc =
            candidates.find((row) => {
                const contact = String(row.contactName || '').toLowerCase();
                const company = String(row.companyName || '').toLowerCase();
                return (
                    (contact && contact === needle) ||
                    (company && company === needle) ||
                    (contact && needle.length >= 4 && contact.includes(needle)) ||
                    (company && needle.length >= 4 && company.includes(needle))
                );
            }) || null;
    }

    return String(doc?.zohoContactId || doc?.zohoVendorId || '').trim();
}

const AED_CURRENCY_CODE = 'AED';

/**
 * Resolve AED currency_id for the bill payload.
 * Do not change the vendor contact currency — Zoho accepts currency_id on the bill itself.
 */
async function resolveAedCurrencyId() {
    try {
        const currencies = await fetchZohoCurrencies();
        const aed = currencies.find(
            (row) =>
                String(row?.currency_code || '').trim().toUpperCase() === AED_CURRENCY_CODE,
        );
        const currencyId = String(aed?.currency_id || '').trim();
        if (!currencyId) {
            return {
                ok: false,
                message:
                    'AED is not in this Zoho organization\u2019s currency list. Enable AED under Zoho Books Settings → Currencies, then Retry Zoho sync.',
            };
        }
        return { ok: true, currencyId };
    } catch (err) {
        return {
            ok: false,
            message:
                err?.message ||
                'Could not load Zoho currencies to post the bill in AED. Reconnect Zoho, then Retry Zoho sync.',
        };
    }
}

async function backfillUtilityBillZohoFields(billDoc) {
    const entryId = String(billDoc?.entryId || '').trim();
    let entry = null;
    if (entryId) {
        entry = await UtilityEntry.findById(entryId).lean();
    }
    const values = entry?.values && typeof entry.values === 'object' ? entry.values : {};

    if (!String(billDoc.provider || '').trim()) {
        const fromEntry = String(values.provider || '').trim();
        if (fromEntry) billDoc.provider = fromEntry;
    }
    if (!String(billDoc.accountNo || '').trim()) {
        const fromEntry = String(values.accountNumber || values.accountNo || '').trim();
        if (fromEntry) billDoc.accountNo = fromEntry;
    }
    if (!Number.isInteger(billDoc.paymentDay) || billDoc.paymentDay < 1) {
        const dayRaw = Number(values.paymentDay ?? values.paymentDate);
        if (Number.isInteger(dayRaw) && dayRaw >= 1 && dayRaw <= 31) {
            billDoc.paymentDay = dayRaw;
        }
    }
    if (!String(billDoc.billNumber || '').trim()) {
        const account = String(billDoc.accountNo || values.accountNumber || 'NA').trim();
        const month = String(billDoc.billMonth || '').trim() || 'NA';
        billDoc.billNumber = `UB-${account}-${month}`.slice(0, 50);
    }
    if (!String(billDoc.billDate || '').trim()) {
        billDoc.billDate = utilityBillDateFromMonth(billDoc.billMonth, billDoc.paymentDay ?? 16);
    }
}

async function resolveOrganizationIdForUtilityBill(billDoc) {
    const fromBill = String(billDoc?.zohoOrganizationId || '').trim();
    if (fromBill) return fromBill;

    // Prefer Pay By company → Zoho org (VEGA / NNIT), then employee company.
    const companyRef = String(billDoc?.payByCompanyId || '').trim();
    if (companyRef && /^[0-9a-fA-F]{24}$/.test(companyRef)) {
        const fromCompany = await resolveZohoOrganizationIdForCompany(companyRef);
        if (fromCompany) return fromCompany;
    }

    const employeeRef = String(
        billDoc?.payByEmployeeId || billDoc?.requestedBy || billDoc?.actionedBy || '',
    ).trim();
    if (employeeRef) {
        const empQuery = /^[0-9a-fA-F]{24}$/.test(employeeRef)
            ? { _id: employeeRef }
            : { employeeId: employeeRef };
        const emp = await EmployeeBasic.findOne(empQuery).select('company').lean();
        if (emp?.company) {
            return resolveZohoOrganizationIdForCompany(emp.company);
        }
    }

    return getZohoOrganizationId();
}

/**
 * Acc2 (difference party COA) — only when already chosen on the bill.
 * Do not match Company/Employee id (e.g. EST-001) to Zoho account_code.
 * Zoho bill debit always uses the Account from Add more / line prices.
 */
async function resolveUtilityPartyAccount(billDoc) {
    const selectedId = String(billDoc?.partyAccountId || '').trim();
    if (selectedId) {
        return {
            ok: true,
            id: selectedId,
            name: String(billDoc?.partyAccountName || '').trim(),
            code: String(billDoc?.partyAccountCode || '').trim(),
        };
    }

    // Never block approve on employeeId/companyId account_code lookup.
    return {
        ok: true,
        skipped: true,
        id: '',
        name: '',
        code: '',
    };
}

/**
 * Create the utility row as a Zoho Books bill after HR Draft / Approve.
 * @param {object} billDoc
 * @param {{ markAsOpen?: boolean }} [options] — false = leave Zoho Draft (not payable); true = Open.
 * Does not throw — stores zohoSyncError on the bill document when Zoho fails.
 */
export async function syncApprovedUtilityBillToZoho(billDoc, { markAsOpen = true } = {}) {
    if (!billDoc) return { ok: false, message: 'Bill missing' };

    const organizationId = await resolveOrganizationIdForUtilityBill(billDoc);
    return withZohoOrganization(organizationId, () =>
        syncApprovedUtilityBillToZohoInner(billDoc, { markAsOpen }),
    );
}

async function openExistingZohoBill(billDoc) {
    const zohoBillIds = collectUtilityZohoBillIds(billDoc);
    if (!zohoBillIds.length) return { ok: false, message: 'No Zoho bill id' };

    try {
        let lastAttach = { ok: true, skipped: true };
        for (const zohoBillId of zohoBillIds) {
            await markBillAsOpen(zohoBillId);
            let zohoBillForUpsert = null;
            try {
                zohoBillForUpsert = await fetchBillById(zohoBillId);
            } catch {
                zohoBillForUpsert = null;
            }
            if (zohoBillForUpsert) {
                try {
                    await upsertZohoBillFromApi(zohoBillForUpsert);
                } catch {
                    /* ignore local cache */
                }
            }
            lastAttach = await syncUtilityBillAttachmentToZoho(billDoc, zohoBillId);
        }
        billDoc.zohoBillStatus = 'open';
        billDoc.zohoSyncedAt = new Date();
        billDoc.zohoSyncError = '';
        if (!lastAttach.ok && lastAttach.message) {
            billDoc.zohoSyncError = `Zoho bill(s) Open; attachment not uploaded: ${lastAttach.message}`;
        }
        await billDoc.save();
        console.log(
            `[UtilityBillZoho] Opened ${zohoBillIds.length} Zoho bill(s): ${zohoBillIds.join(', ')}`,
        );
        return {
            ok: true,
            zohoBillId: zohoBillIds[0],
            zohoBillIds,
            opened: true,
            attachment: lastAttach,
        };
    } catch (err) {
        const message = err?.message || 'Failed to mark Zoho bill as Open';
        billDoc.zohoSyncError = message;
        await billDoc.save();
        return { ok: false, message };
    }
}

async function syncApprovedUtilityBillToZohoInner(billDoc, { markAsOpen = true } = {}) {
    let partyAccount;
    try {
        partyAccount = await resolveUtilityPartyAccount(billDoc);
    } catch (err) {
        partyAccount = {
            ok: true,
            skipped: true,
            id: '',
            name: '',
            code: '',
            message: err?.message || '',
        };
    }
    // Acc2 is optional. Zoho bill debit uses Add more Account (line prices), not Salary Payable by code.
    if (partyAccount?.id) {
        billDoc.partyAccountId = partyAccount.id;
        billDoc.partyAccountName = partyAccount.name || billDoc.partyAccountName || '';
        billDoc.partyAccountCode = partyAccount.code || billDoc.partyAccountCode || '';
    }

    const existingIds = collectUtilityZohoBillIds(billDoc);
    // One ERP utility row → one Zoho bill (all Add-more lines are line_items inside it).
    if (existingIds.length > 0) {
        const current = String(billDoc.zohoBillStatus || '').toLowerCase();
        if (markAsOpen && current !== 'open') {
            return openExistingZohoBill(billDoc);
        }
        const attachResult = await syncUtilityBillAttachmentToZoho(
            billDoc,
            existingIds[0],
        );
        if (!attachResult.ok && attachResult.message) {
            billDoc.zohoSyncError = `Attachment not uploaded: ${attachResult.message}`;
        }
        await billDoc.save();
        return {
            ok: true,
            skipped: true,
            zohoBillId: existingIds[0],
            zohoBillIds: existingIds,
            attachment: attachResult,
        };
    }

    try {
        await backfillUtilityBillZohoFields(billDoc);
    } catch (backfillErr) {
        console.warn(
            '[UtilityBillZoho] Entry backfill failed:',
            backfillErr?.message || backfillErr,
        );
    }

    const amount = Number(billDoc.amount);
    const billNumber = String(billDoc.billNumber || '').trim();
    const billDate =
        String(billDoc.billDate || '').trim() ||
        utilityBillDateFromMonth(billDoc.billMonth, billDoc.paymentDay);
    const provider = String(billDoc.provider || '').trim();

    if (!billNumber) {
        billDoc.zohoSyncError = 'Bill number is required for Zoho.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    if (!billDate) {
        billDoc.zohoSyncError = 'Bill date is required for Zoho (use bill month).';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        billDoc.zohoSyncError = 'Actual amount must be greater than zero for Zoho.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }

    const { lineItems, actual, diff } = buildUtilityBillZohoLineItems(billDoc);
    if (!lineItems.length) {
        billDoc.zohoSyncError =
            'Item account(s) and Actual amount are required for Zoho bill(s). Use Add more to set Accounts.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }

    // Keep parent Acc1 as first line account for difference journal / legacy fields.
    if (!String(billDoc.expenseAccountId || '').trim() && lineItems[0]?.account_id) {
        billDoc.expenseAccountId = lineItems[0].account_id;
        billDoc.expenseAccountName = lineItems[0].accountName || billDoc.expenseAccountName || '';
    }

    const activeOrgId = getZohoOrganizationId();
    let vendorId = String(billDoc.zohoVendorId || '').trim();
    if (!vendorId) {
        try {
            vendorId = await resolveZohoVendorIdByProvider(provider, activeOrgId);
            if (vendorId) billDoc.zohoVendorId = vendorId;
        } catch (err) {
            billDoc.zohoSyncError = err?.message || 'Failed to resolve Zoho vendor.';
            await billDoc.save();
            return { ok: false, message: billDoc.zohoSyncError };
        }
    }

    if (!vendorId) {
        billDoc.zohoSyncError = `No Zoho vendor matched provider "${provider || '—'}". Sync Vendors in Accounts, then retry Zoho sync.`;
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }

    // Post the bill in AED via currency_id — no need to edit the vendor's default currency.
    const currencyResult = await resolveAedCurrencyId();
    if (!currencyResult.ok) {
        billDoc.zohoSyncError = currencyResult.message;
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }

    console.log(
        '[UtilityBillZoho] Creating one Zoho bill with line items:',
        JSON.stringify({
            erpBillId: String(billDoc._id),
            zohoOrg: activeOrgId,
            vendorId,
            provider,
            billNumber,
            billDate,
            actual,
            difference: diff,
            lineCount: lineItems.length,
            markAsOpen: Boolean(markAsOpen),
            lineItems: lineItems.map((line) => ({
                account_id: line.account_id,
                quantity: line.quantity,
                rate: line.rate,
                amount: line.amount,
                description: line.description,
            })),
        }),
    );

    try {
        let zohoStatus = 'draft';
        let lastAttach = { ok: true, skipped: true };
        const lineDocs = Array.isArray(billDoc.zohoLineItems)
            ? billDoc.zohoLineItems.map((line) =>
                  typeof line?.toObject === 'function' ? line.toObject() : { ...line },
              )
            : [];

        const zohoBill = await createBill({
            vendor_id: vendorId,
            bill_number: billNumber,
            date: billDate,
            reference_number: String(billDoc.accountNo || '').trim() || undefined,
            notes:
                String(billDoc.notes || '').trim() ||
                `Utility Actual ${Number(actual).toFixed(2)}${
                    lineItems.length > 1 ? ` · ${lineItems.length} lines` : ''
                }${diff > 0.009 ? ` · Diff ${Number(diff).toFixed(2)}` : ''}` ||
                undefined,
            currency_id: currencyResult.currencyId,
            exchange_rate: 1,
            // One Zoho bill containing every Add-more row as a line item (like standard Zoho bills).
            line_items: lineItems.map((line) => ({
                account_id: line.account_id,
                quantity: line.quantity,
                rate: line.rate,
                description: line.description,
            })),
        });

        const zohoBillId = String(zohoBill?.bill_id || zohoBill?.billId || '').trim();
        if (!zohoBillId) {
            throw new Error('Zoho did not return a bill id.');
        }

        for (let i = 0; i < lineDocs.length; i++) {
            lineDocs[i].zohoBillId = zohoBillId;
        }
        if (Array.isArray(billDoc.zohoLineItems)) {
            billDoc.zohoLineItems.forEach((line) => {
                if (line && typeof line === 'object') line.zohoBillId = zohoBillId;
            });
        }

        let zohoBillForUpsert = zohoBill;
        if (markAsOpen) {
            try {
                await markBillAsOpen(zohoBillId);
                zohoBillForUpsert = (await fetchBillById(zohoBillId)) || zohoBill;
                zohoStatus = 'open';
            } catch (openErr) {
                const openMsg = openErr?.message || 'Could not mark Zoho bill as Open';
                console.warn('[UtilityBillZoho] Bill created but still Draft:', openMsg);
                zohoStatus = 'draft';
                billDoc.billDate = billDate;
                billDoc.zohoVendorId = vendorId;
                billDoc.zohoBillId = zohoBillId;
                billDoc.zohoBillIds = [zohoBillId];
                if (lineDocs.length) billDoc.zohoLineItems = lineDocs;
                try {
                    billDoc.zohoOrganizationId = getZohoOrganizationId();
                } catch {
                    /* ignore */
                }
                billDoc.zohoSyncedAt = new Date();
                lastAttach = await syncUtilityBillAttachmentToZoho(billDoc, zohoBillId);
                billDoc.zohoSyncError = lastAttach.ok
                    ? openMsg
                    : `${openMsg}; attachment: ${lastAttach.message || 'upload failed'}`;
                await billDoc.save();
                try {
                    await upsertZohoBillFromApi(
                        zohoBill,
                        utilityZohoBillExtras(billDoc, lineItems[0], 0, billNumber),
                    );
                } catch {
                    /* ignore */
                }
                return {
                    ok: false,
                    message: `Zoho bill created as Draft but not Open: ${openMsg}`,
                    zohoBillId,
                    zohoBillIds: [zohoBillId],
                    zohoBillStatus: 'draft',
                    attachment: lastAttach,
                };
            }
        }

        try {
            await upsertZohoBillFromApi(
                zohoBillForUpsert,
                utilityZohoBillExtras(billDoc, lineItems[0], 0, billNumber),
            );
        } catch (upsertErr) {
            console.warn(
                '[UtilityBillZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        lastAttach = await syncUtilityBillAttachmentToZoho(billDoc, zohoBillId);

        billDoc.billDate = billDate;
        billDoc.zohoVendorId = vendorId;
        billDoc.zohoBillId = zohoBillId;
        billDoc.zohoBillIds = [zohoBillId];
        if (lineDocs.length) {
            billDoc.zohoLineItems = lineDocs;
        }
        billDoc.zohoBillStatus = zohoStatus;
        try {
            billDoc.zohoOrganizationId = getZohoOrganizationId();
        } catch {
            /* ignore */
        }
        billDoc.zohoSyncedAt = new Date();
        billDoc.zohoSyncError = '';
        if (!lastAttach.ok && lastAttach.message) {
            billDoc.zohoSyncError = `Zoho bill synced; attachment not uploaded: ${lastAttach.message}`;
        }
        await billDoc.save();

        console.log(`[UtilityBillZoho] Created Zoho bill ${zohoBillId} with ${lineItems.length} line(s)`);

        return {
            ok: true,
            zohoBillId,
            zohoBillIds: [zohoBillId],
            zohoBillStatus: zohoStatus,
            attachment: lastAttach,
        };
    } catch (err) {
        let message = err?.message || 'Failed to create Zoho bill';
        console.error('[UtilityBillZoho] Failed:', message);
        // Stale vendor id from wrong org / deleted contact — clear and keep error for retry.
        if (/vendor|contact|invalid/i.test(message) && billDoc.zohoVendorId) {
            billDoc.zohoVendorId = '';
        }
        // Zoho's generic auth message — usually OAuth scope / user role / wrong org token.
        if (/not authorized to perform this operation/i.test(message)) {
            message =
                'Zoho refused to create the bill (not authorized). Reconnect Zoho for the correct org (Accounts → Zoho) with a user who can create Bills, then Retry Zoho sync.';
        }
        billDoc.zohoSyncError = message;
        await billDoc.save();
        return { ok: false, message };
    }
}

export async function syncApprovedUtilityBillsToZoho(bills = [], options = {}) {
    const results = [];
    for (const bill of bills) {
        results.push(await syncApprovedUtilityBillToZoho(bill, options));
    }
    return results;
}

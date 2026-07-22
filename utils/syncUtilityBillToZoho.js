import ZohoVendor from '../models/ZohoVendor.js';
import UtilityEntry from '../models/UtilityEntry.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import {
    createBill,
    markBillAsOpen,
    fetchBillById,
    fetchPaymentAccounts,
    fetchZohoCurrencies,
    getZohoOrganizationId,
    uploadBillAttachment,
} from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';

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

function zohoAccountCode(account) {
    return String(
        account?.account_code ||
            account?.accountCode ||
            account?.code ||
            '',
    ).trim();
}

async function resolveUtilityPartyAccount(billDoc) {
    // Prefer account chosen on Add Bills (difference pay account).
    const selectedId = String(billDoc?.partyAccountId || '').trim();
    if (selectedId) {
        return {
            ok: true,
            id: selectedId,
            name: String(billDoc?.partyAccountName || '').trim(),
            code: String(billDoc?.partyAccountCode || '').trim(),
        };
    }

    const paymentBy = String(billDoc?.paymentBy || '').trim().toLowerCase();
    let partyCode = '';

    if (paymentBy === 'employee' || paymentBy === 'employee_balance') {
        const employeeRef = String(billDoc?.payByEmployeeId || '').trim();
        if (employeeRef) {
            const query = /^[0-9a-fA-F]{24}$/.test(employeeRef)
                ? { _id: employeeRef }
                : { employeeId: employeeRef };
            const employee = await EmployeeBasic.findOne(query).select('employeeId').lean();
            partyCode = String(employee?.employeeId || employeeRef).trim();
        }
    } else if (paymentBy === 'company') {
        const companyRef = String(billDoc?.payByCompanyId || '').trim();
        const companyQuery = /^[0-9a-fA-F]{24}$/.test(companyRef)
            ? { _id: companyRef }
            : {
                  $or: [
                      { companyId: companyRef },
                      ...(billDoc?.payByCompanyName
                          ? [{ name: String(billDoc.payByCompanyName).trim() }]
                          : []),
                  ],
              };
        const company = companyRef
            ? await Company.findOne(companyQuery).select('companyId').lean()
            : null;
        partyCode = String(company?.companyId || companyRef).trim();
    }

    if (!partyCode) {
        return { ok: false, message: 'Contract Paid By party id is required.' };
    }

    const accounts = await fetchPaymentAccounts();
    const codeMatches = accounts.filter(
        (account) => zohoAccountCode(account).toLowerCase() === partyCode.toLowerCase(),
    );
    const account =
        codeMatches.find((row) =>
            /salary\s*payable/i.test(
                `${row?.account_name || row?.name || ''} ${row?.account_type_formatted || row?.account_type || ''}`,
            ),
        ) || codeMatches[0];

    if (!account) {
        return {
            ok: false,
            message: `No Zoho Salary Payable account has account code "${partyCode}". Create or update that Chart of Accounts row, then approve again.`,
        };
    }

    return {
        ok: true,
        id: String(account.account_id || account.id || '').trim(),
        name: String(account.account_name || account.name || '').trim(),
        code: zohoAccountCode(account) || partyCode,
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
    const zohoBillId = String(billDoc.zohoBillId || '').trim();
    if (!zohoBillId) return { ok: false, message: 'No Zoho bill id' };

    try {
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
        billDoc.zohoBillStatus = 'open';
        billDoc.zohoSyncedAt = new Date();
        billDoc.zohoSyncError = '';
        const attachResult = await syncUtilityBillAttachmentToZoho(billDoc, zohoBillId);
        if (!attachResult.ok && attachResult.message) {
            billDoc.zohoSyncError = `Zoho bill Open; attachment not uploaded: ${attachResult.message}`;
        }
        await billDoc.save();
        console.log(`[UtilityBillZoho] Bill ${zohoBillId} marked as Open in Zoho.`);
        return { ok: true, zohoBillId, opened: true, attachment: attachResult };
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
            ok: false,
            message: err?.message || 'Failed to resolve the Contract Paid By Chart of Accounts row.',
        };
    }
    if (!partyAccount.ok || !partyAccount.id) {
        billDoc.zohoSyncError = partyAccount.message;
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    billDoc.partyAccountId = partyAccount.id;
    billDoc.partyAccountName = partyAccount.name;
    billDoc.partyAccountCode = partyAccount.code;

    const existingId = String(billDoc.zohoBillId || '').trim();
    if (existingId) {
        const current = String(billDoc.zohoBillStatus || '').toLowerCase();
        if (markAsOpen && current !== 'open') {
            return openExistingZohoBill(billDoc);
        }
        const attachResult = await syncUtilityBillAttachmentToZoho(billDoc, existingId);
        if (!attachResult.ok && attachResult.message) {
            billDoc.zohoSyncError = `Attachment not uploaded: ${attachResult.message}`;
        }
        await billDoc.save();
        return {
            ok: true,
            skipped: true,
            zohoBillId: existingId,
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
    const expenseAccountId = String(billDoc.expenseAccountId || '').trim();
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
    if (!expenseAccountId) {
        billDoc.zohoSyncError =
            'Expense account is required for Zoho. Re-submit the bill with an expense Chart of Accounts line, then Retry Zoho sync.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        billDoc.zohoSyncError = 'Actual amount must be greater than zero for Zoho.';
        await billDoc.save();
        return { ok: false, message: billDoc.zohoSyncError };
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

    const descriptionParts = [
        billDoc.utilityType ? String(billDoc.utilityType) : '',
        billDoc.accountNo ? `Acc ${billDoc.accountNo}` : '',
        billDoc.billMonth ? String(billDoc.billMonth) : '',
    ].filter(Boolean);

    console.log(
        '[UtilityBillZoho] Creating Zoho bill:',
        JSON.stringify({
            erpBillId: String(billDoc._id),
            zohoOrg: activeOrgId,
            vendorId,
            provider,
            billNumber,
            billDate,
            expenseAccountId,
            debitPartyAccountId: partyAccount.id,
            debitPartyAccountCode: partyAccount.code,
            amount,
            currencyId: currencyResult.currencyId,
            markAsOpen: Boolean(markAsOpen),
        }),
    );

    try {
        const zohoBill = await createBill({
            vendor_id: vendorId,
            bill_number: billNumber,
            date: billDate,
            reference_number: String(billDoc.accountNo || '').trim() || undefined,
            notes: String(billDoc.notes || '').trim() || undefined,
            currency_id: currencyResult.currencyId,
            exchange_rate: 1,
            line_items: [
                {
                    account_id: expenseAccountId,
                    quantity: 1,
                    rate: Number(amount.toFixed(2)),
                    description: descriptionParts.join(' · ') || undefined,
                },
            ],
        });

        const zohoBillId = String(zohoBill?.bill_id || zohoBill?.billId || '').trim();

        // API creates Draft by default. Approve → Open so Accounts can pay; Draft stays Draft.
        let zohoBillForUpsert = zohoBill;
        let zohoStatus = 'draft';
        if (zohoBillId && markAsOpen) {
            try {
                await markBillAsOpen(zohoBillId);
                zohoBillForUpsert = (await fetchBillById(zohoBillId)) || zohoBill;
                zohoStatus = 'open';
                console.log(`[UtilityBillZoho] Bill ${zohoBillId} marked as Open in Zoho.`);
            } catch (openErr) {
                const openMsg = openErr?.message || 'Could not mark Zoho bill as Open';
                console.warn('[UtilityBillZoho] Bill created but still Draft:', openMsg);
                billDoc.billDate = billDate;
                billDoc.zohoVendorId = vendorId;
                billDoc.zohoBillId = zohoBillId;
                billDoc.zohoBillStatus = 'draft';
                try {
                    billDoc.zohoOrganizationId = getZohoOrganizationId();
                } catch {
                    /* ignore */
                }
                billDoc.zohoSyncedAt = new Date();
                const attachResult = await syncUtilityBillAttachmentToZoho(billDoc, zohoBillId);
                billDoc.zohoSyncError = attachResult.ok
                    ? openMsg
                    : `${openMsg}; attachment: ${attachResult.message || 'upload failed'}`;
                await billDoc.save();
                try {
                    await upsertZohoBillFromApi(zohoBill);
                } catch {
                    /* ignore */
                }
                return {
                    ok: false,
                    message: `Zoho bill created as Draft but not Open: ${openMsg}`,
                    zohoBillId,
                    zohoBillStatus: 'draft',
                    attachment: attachResult,
                };
            }
        } else if (zohoBillId) {
            console.log(`[UtilityBillZoho] Bill ${zohoBillId} left as Draft in Zoho (not payable yet).`);
        }

        try {
            await upsertZohoBillFromApi(zohoBillForUpsert);
        } catch (upsertErr) {
            console.warn(
                '[UtilityBillZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        billDoc.billDate = billDate;
        billDoc.zohoVendorId = vendorId;
        billDoc.zohoBillId = zohoBillId;
        billDoc.zohoBillStatus = zohoStatus;
        try {
            billDoc.zohoOrganizationId = getZohoOrganizationId();
        } catch {
            /* ignore */
        }
        billDoc.zohoSyncedAt = new Date();
        billDoc.zohoSyncError = '';
        const attachResult = zohoBillId
            ? await syncUtilityBillAttachmentToZoho(billDoc, zohoBillId)
            : { ok: true, skipped: true };
        if (!attachResult.ok && attachResult.message) {
            billDoc.zohoSyncError = `Zoho bill synced; attachment not uploaded: ${attachResult.message}`;
        }
        await billDoc.save();

        return {
            ok: true,
            zohoBillId,
            zohoBillStatus: zohoStatus,
            attachment: attachResult,
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

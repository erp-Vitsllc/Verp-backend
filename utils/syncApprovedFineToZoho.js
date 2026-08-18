import axios from 'axios';
import {
    createBillWithZohoSerial,
    getZohoOrganizationId,
    markBillAsOpen,
    fetchBillById,
    uploadBillAttachment,
    updateBill,
} from '../services/zohoService.js';
import { upsertZohoBillFromApi } from '../services/zohoPurchaseSyncService.js';
import { withZohoOrganization } from './zohoOrgContext.js';
import { resolveZohoOrganizationIdForCompany } from './resolveZohoOrganization.js';
import { resolveZohoBillSerialNumber } from './zohoPurchaseMappers.js';
import { downloadS3ObjectBytes } from './s3Upload.js';
import {
    resolveCompanyFinePayableAmount,
    resolveEmployeeFinePayableAmount,
    resolvePrimaryEmployeeId,
    resolveFineNetTotal,
} from './finePayableAmount.js';

function sanitizeBillNumber(fineId) {
    return String(fineId || '')
        .trim()
        .replace(/[^\w-]/g, '-')
        .slice(0, 45);
}

function getFineBaseId(fineId) {
    const fid = String(fineId || '');
    const parts = fid.split('-');
    if (parts.length > 3) return parts.slice(0, 3).join('-');
    return fid;
}

async function resolveOrganizationIdForFine(fineDoc) {
    const fromFine = String(fineDoc?.zohoOrganizationId || '').trim();
    if (fromFine) return fromFine;
    if (fineDoc?.company) {
        return resolveZohoOrganizationIdForCompany(fineDoc.company);
    }
    return getZohoOrganizationId();
}

/** Bill line rate = party net payable (base + service charge − discount share). */
function resolveFineBillLineAmount(fineDoc) {
    const party = fineDoc.assignedEmployees?.[0];
    const isCompany =
        party?.employeeId === 'VEGA-HR-0000' ||
        party?.employeeId === 'VEGA_INTERNAL';

    const empAmt = Number(fineDoc.employeeAmount || 0) || 0;
    const compAmt = Number(fineDoc.companyAmount || 0) || 0;
    const servCharge = Number(fineDoc.serviceCharge || 0) || 0;
    const discount = Number(fineDoc.discount || 0) || 0;
    const fromParts = Math.max(0, empAmt + compAmt + servCharge - discount);

    let payable = 0;
    if (isCompany) {
        payable = resolveCompanyFinePayableAmount(fineDoc, party);
    } else {
        const empId = party?.employeeId || resolvePrimaryEmployeeId(fineDoc);
        payable = empId ? resolveEmployeeFinePayableAmount(fineDoc, empId) : 0;
    }

    const netStored = resolveFineNetTotal(fineDoc);
    const amount = Math.max(0, fromParts, payable, netStored);
    return Number(amount.toFixed(2));
}

function buildLineItemFromFine(fineDoc) {
    const amount = resolveFineBillLineAmount(fineDoc);
    const expenseAccountId = String(fineDoc.expenseAccountId || '').trim();
    if (!expenseAccountId || !Number.isFinite(amount) || amount <= 0) return null;

    const party = fineDoc.assignedEmployees?.[0];
    const isCompany =
        party?.employeeId === 'VEGA-HR-0000' ||
        party?.employeeId === 'VEGA_INTERNAL';
    const partyName =
        party?.employeeName ||
        (isCompany ? fineDoc.companyName || 'Company' : '') ||
        fineDoc.companyName ||
        '';
    // Zoho Bill Item Table: Item Details = party + fine ref; Account = Payable COA
    const descriptionParts = [
        partyName,
        fineDoc.fineType ? String(fineDoc.fineType) : 'Fine',
        fineDoc.fineId ? String(fineDoc.fineId) : '',
        fineDoc.description ? String(fineDoc.description).slice(0, 80) : '',
    ].filter(Boolean);

    return {
        account_id: expenseAccountId,
        name: partyName || String(fineDoc.fineId || 'Fine party'),
        quantity: 1,
        rate: amount,
        description: descriptionParts.join(' · ') || undefined,
    };
}

/** Zoho bill attachments allow: gif, png, jpeg, jpg, bmp, pdf. */
function ensureZohoSafeFilename(name, mimeType) {
    let filename = String(name || '').trim() || 'fine-attachment.pdf';
    if (/\.(pdf|png|jpe?g|gif|bmp)$/i.test(filename)) {
        return filename.slice(0, 200);
    }
    const stem = filename.replace(/\.[^.]+$/, '').trim() || 'fine-attachment';
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
    return `${stem}.${ext}`.slice(0, 200);
}

function bufferFromBase64(data) {
    const raw = String(data || '').trim();
    if (!raw) return null;
    let base64 = raw;
    let mimeType = '';
    const dataMatch = raw.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/is);
    if (dataMatch) {
        if (dataMatch[1]) mimeType = String(dataMatch[1]).trim();
        base64 = dataMatch[2];
    } else if (raw.includes(',')) {
        base64 = raw.split(',').pop();
    }
    try {
        const buffer = Buffer.from(String(base64 || '').replace(/\s/g, ''), 'base64');
        if (!buffer.length) return null;
        return { buffer, mimeType };
    } catch {
        return null;
    }
}

/**
 * Collect candidate attachment objects from the fine group
 * (primary `attachment`, then `attachments[]` on any sibling).
 */
function collectFineAttachmentCandidates(group = []) {
    const candidates = [];
    const seen = new Set();

    const push = (att) => {
        if (!att || typeof att !== 'object') return;
        const key =
            String(att.publicId || '').trim() ||
            String(att.url || '').trim() ||
            String(att.name || '').trim() ||
            (att.data ? `data:${String(att.data).slice(0, 48)}` : '');
        if (!key || seen.has(key)) return;
        if (!att.publicId && !att.url && !att.data && !att.name) return;
        seen.add(key);
        candidates.push(att);
    };

    for (const f of group) {
        push(f?.attachment);
    }
    for (const f of group) {
        if (!Array.isArray(f?.attachments)) continue;
        for (const item of f.attachments) push(item);
    }
    return candidates;
}

/**
 * Resolve the Add Fine modal supporting file into a Zoho upload payload.
 * Prefers S3 bytes, then inline base64, then HTTP URL download.
 */
async function resolveFineAttachmentFile(attachment = {}) {
    const mimeHint = String(attachment?.mimeType || attachment?.mime || '').trim();
    const nameHint = String(attachment?.name || '').trim();

    let buffer = null;
    let mimeType = mimeHint;

    const s3Key = String(attachment?.publicId || attachment?.url || '').trim();
    if (s3Key) {
        buffer = await downloadS3ObjectBytes(s3Key);
    }

    if (!buffer?.length && attachment?.data) {
        const parsed = bufferFromBase64(attachment.data);
        if (parsed?.buffer?.length) {
            buffer = parsed.buffer;
            if (!mimeType && parsed.mimeType) mimeType = parsed.mimeType;
        }
    }

    if (!buffer?.length && attachment?.url && /^https?:\/\//i.test(String(attachment.url))) {
        try {
            const response = await axios.get(String(attachment.url), {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxContentLength: 25 * 1024 * 1024,
            });
            buffer = Buffer.from(response.data);
            if (!mimeType && response.headers?.['content-type']) {
                mimeType = String(response.headers['content-type']).split(';')[0].trim();
            }
        } catch (err) {
            console.warn(
                '[FineZoho] Could not download attachment URL:',
                err?.message || err,
            );
        }
    }

    if (!buffer?.length) return null;

    const filename = ensureZohoSafeFilename(nameHint || 'fine-attachment.pdf', mimeType);
    return {
        buffer,
        filename,
        mimeType: mimeType || 'application/pdf',
    };
}

/**
 * Upload the fine supporting attachment onto the Zoho bill (one file — Zoho bill limit).
 * Soft-fails: bill create/open still succeeds if upload fails.
 */
async function syncFineAttachmentToZoho(group, zohoBillId) {
    const id = String(zohoBillId || '').trim();
    if (!id) return { ok: true, skipped: true };
    if (group.every((f) => f?.zohoAttachmentSyncedAt)) {
        return { ok: true, skipped: true };
    }

    const candidates = collectFineAttachmentCandidates(group);
    if (!candidates.length) return { ok: true, skipped: true };

    let file = null;
    for (const candidate of candidates) {
        file = await resolveFineAttachmentFile(candidate);
        if (file) break;
    }
    if (!file) return { ok: true, skipped: true };

    try {
        await uploadBillAttachment(id, file);
        const syncedAt = new Date();
        for (const f of group) {
            f.zohoAttachmentSyncedAt = syncedAt;
            f.zohoAttachmentName = file.filename;
            await f.save();
        }
        console.log(
            `[FineZoho] Attached ${file.filename} (${file.buffer.length} bytes) to Zoho bill ${id}`,
        );
        return { ok: true, filename: file.filename };
    } catch (err) {
        const message = err?.message || 'Failed to upload fine attachment to Zoho bill';
        console.warn('[FineZoho] Attachment upload failed:', message);
        return { ok: false, message };
    }
}

/**
 * Create one Zoho Books bill for approved fine(s) after Management approval.
 * Group fines: a single bill — Vendor = Fine Source; Item Table rows = each party (Payable COA + amount).
 * Also uploads the Add Fine supporting attachment onto that Zoho bill.
 */
export async function syncApprovedFineToZoho(fineDoc, siblingFines = null) {
    if (!fineDoc) return { ok: false, message: 'Fine missing' };

    const group = Array.isArray(siblingFines) && siblingFines.length > 0
        ? siblingFines
        : [fineDoc];

    if (group.every((f) => f.zohoBillId)) {
        const existingId = String(group[0].zohoBillId || '').trim();
        const organizationId = await resolveOrganizationIdForFine(fineDoc);
        const attachResult = await withZohoOrganization(organizationId, () =>
            syncFineAttachmentToZoho(group, existingId),
        );
        return {
            ok: true,
            skipped: true,
            zohoBillId: existingId,
            attachment: attachResult,
            warning:
                attachResult?.ok === false
                    ? attachResult.message
                    : undefined,
        };
    }

    const organizationId = await resolveOrganizationIdForFine(fineDoc);
    return withZohoOrganization(organizationId, () => syncApprovedFineToZohoInner(fineDoc, group));
}

async function syncApprovedFineToZohoInner(fineDoc, group) {
    const primary = group.find((f) => !f.zohoBillId) || fineDoc;
    const baseId = getFineBaseId(primary.fineId);
    const billNumber =
        String(primary.billNumber || '').trim() || sanitizeBillNumber(baseId) || '';
    const billDate =
        String(primary.billDate || '').trim() ||
        (primary.approvedDate
            ? new Date(primary.approvedDate).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10));
    const vendorId = String(primary.zohoVendorId || fineDoc.zohoVendorId || '').trim();

    if (!vendorId) {
        const message = 'Zoho vendor is required for the fine bill (use Fine Source / vendor).';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }

    const lineItems = group.map(buildLineItemFromFine).filter(Boolean);
    if (!lineItems.length) {
        const message =
            'Each party needs a Payable (Chart of Accounts) and amount greater than zero for the Zoho bill.';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }

    const vendorLabel =
        String(primary.zohoVendorName || fineDoc.zohoVendorName || fineDoc.fineSource || '').trim();
    const notesParts = [
        fineDoc.description ? String(fineDoc.description).trim() : '',
        vendorLabel ? `Vendor (Fine Source): ${vendorLabel}` : '',
        `Parties: ${lineItems.length}`,
    ].filter(Boolean);

    try {
        const zohoBill = await createBillWithZohoSerial({
            vendor_id: vendorId,
            date: billDate,
            notes: notesParts.join('\n') || undefined,
            line_items: lineItems,
        });

        const zohoBillId = String(zohoBill?.bill_id || zohoBill?.billId || '').trim();
        if (!zohoBillId) {
            throw new Error('Zoho did not return a bill id.');
        }

        // Management-approved fine bills must be Open (payable), not left as Draft
        let zohoBillForUpsert = zohoBill;
        let openWarning = '';
        try {
            await markBillAsOpen(zohoBillId);
            zohoBillForUpsert = (await fetchBillById(zohoBillId)) || zohoBill;
        } catch (openErr) {
            openWarning = openErr?.message || 'Could not mark Zoho bill as Open';
            console.warn('[FineZoho] Bill created but still Draft:', openWarning);
        }

        try {
            await upsertZohoBillFromApi(zohoBillForUpsert);
        } catch (upsertErr) {
            console.warn(
                '[FineZoho] Zoho create ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        let orgId = '';
        try {
            orgId = getZohoOrganizationId();
        } catch {
            /* ignore */
        }

        const zohoBillNumber = resolveZohoBillSerialNumber(zohoBillForUpsert || zohoBill);

        for (const f of group) {
            f.billDate = billDate;
            f.billNumber = billNumber;
            f.zohoBillNumber = zohoBillNumber;
            f.zohoBillId = zohoBillId;
            if (orgId) f.zohoOrganizationId = orgId;
            f.zohoSyncedAt = new Date();
            f.zohoSyncError = openWarning || '';
            f.vendorBillStatus = f.vendorBillStatus || 'Pending';
            if (!f.zohoVendorId) f.zohoVendorId = vendorId;
            if (!f.zohoVendorName && vendorLabel) f.zohoVendorName = vendorLabel;
            await f.save();
        }

        const attachResult = await syncFineAttachmentToZoho(group, zohoBillId);
        if (attachResult?.ok === false && attachResult.message) {
            const attachWarning = `Zoho bill synced; attachment not uploaded: ${attachResult.message}`;
            for (const f of group) {
                f.zohoSyncError = openWarning
                    ? `${openWarning}; ${attachWarning}`
                    : attachWarning;
                await f.save();
            }
        }

        return {
            ok: true,
            zohoBillId,
            lineItemCount: lineItems.length,
            zohoStatus: openWarning ? 'draft' : 'open',
            attachment: attachResult,
            warning:
                openWarning ||
                (attachResult?.ok === false ? attachResult.message : undefined) ||
                undefined,
        };
    } catch (err) {
        const message = err?.message || 'Failed to create Zoho bill for fine';
        console.error('[FineZoho] Failed:', message);
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }
}

function matchExistingLineItem(existingLines, newLine, index) {
    const lines = Array.isArray(existingLines) ? existingLines : [];
    const accountId = String(newLine?.account_id || '').trim();
    const byAccount = lines.find((row) => String(row?.account_id || '').trim() === accountId);
    const byIndex = lines[index];
    const existing = byAccount || byIndex || null;
    const lineItemId = String(existing?.line_item_id || existing?.lineItemId || '').trim();
    return lineItemId || '';
}

/**
 * Update an existing Zoho Books bill when an approved fine is edited (amount/discount/vendor).
 * Triggered when the client sends updateZoho: true on PUT /Fine/:id.
 */
export async function updateApprovedFineInZoho(fineDoc, siblingFines = null) {
    if (!fineDoc) return { ok: false, message: 'Fine missing' };

    const group = Array.isArray(siblingFines) && siblingFines.length > 0
        ? siblingFines
        : [fineDoc];

    const zohoBillId = String(group.find((f) => f?.zohoBillId)?.zohoBillId || fineDoc.zohoBillId || '').trim();
    if (!zohoBillId) {
        return { ok: false, message: 'No Zoho bill is linked to this fine.' };
    }

    const organizationId = await resolveOrganizationIdForFine(fineDoc);
    return withZohoOrganization(organizationId, () =>
        updateApprovedFineInZohoInner(fineDoc, group, zohoBillId),
    );
}

async function updateApprovedFineInZohoInner(fineDoc, group, zohoBillId) {
    const existingBill = await fetchBillById(zohoBillId);
    if (!existingBill) {
        const message = 'Linked Zoho bill could not be loaded.';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }

    const newLineItems = group.map(buildLineItemFromFine).filter(Boolean);
    if (!newLineItems.length) {
        const message =
            'Each party needs a Payable (Chart of Accounts) and amount greater than zero for the Zoho bill update.';
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }

    const existingLines = existingBill.line_items || existingBill.lineItems || [];
    const line_items = newLineItems.map((line, index) => {
        const lineItemId = matchExistingLineItem(existingLines, line, index);
        const row = {
            account_id: line.account_id,
            name: line.name,
            quantity: line.quantity,
            rate: line.rate,
            description: line.description,
        };
        if (lineItemId) row.line_item_id = lineItemId;
        return row;
    });

    const primary = group[0] || fineDoc;
    const vendorId = String(
        primary.zohoVendorId ||
            fineDoc.zohoVendorId ||
            existingBill.vendor_id ||
            existingBill.vendorId ||
            '',
    ).trim();

    try {
        const payload = {
            vendor_id: vendorId || existingBill.vendor_id || existingBill.vendorId,
            bill_number: existingBill.bill_number || existingBill.billNumber,
            date: existingBill.date,
            line_items,
        };
        if (existingBill.due_date || existingBill.dueDate) {
            payload.due_date = existingBill.due_date || existingBill.dueDate;
        }

        const zohoBill = await updateBill(zohoBillId, payload);
        const zohoBillForUpsert = (await fetchBillById(zohoBillId)) || zohoBill;

        try {
            await upsertZohoBillFromApi(zohoBillForUpsert);
        } catch (upsertErr) {
            console.warn(
                '[FineZoho] Bill update ok; ERP ZohoBill upsert failed:',
                upsertErr?.message || upsertErr,
            );
        }

        const zohoBillNumber = String(
            zohoBillForUpsert?.bill_number || zohoBill?.bill_number || zohoBill?.billNumber || '',
        ).trim();

        for (const f of group) {
            f.zohoBillNumber = zohoBillNumber || f.zohoBillNumber;
            f.zohoSyncedAt = new Date();
            f.zohoSyncError = '';
            if (vendorId && !f.zohoVendorId) f.zohoVendorId = vendorId;
            await f.save();
        }

        const attachResult = await syncFineAttachmentToZoho(group, zohoBillId);

        return {
            ok: true,
            zohoBillId,
            lineItemCount: line_items.length,
            attachment: attachResult,
            warning:
                attachResult?.ok === false ? attachResult.message : undefined,
        };
    } catch (err) {
        const message = err?.message || 'Failed to update Zoho bill for fine';
        console.error('[FineZoho] Update failed:', message);
        for (const f of group) {
            f.zohoSyncError = message;
            await f.save();
        }
        return { ok: false, message };
    }
}

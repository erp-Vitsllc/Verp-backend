import multer from 'multer';
import Fine from '../../models/Fine.js';
import { isUserInFlowchart } from '../../utils/getDepartmentHOD.js';
import { withZohoOrganization } from '../../utils/zohoOrgContext.js';
import { closeAccountsPaymentInbox } from '../../utils/fineAccountsPaymentFlow.js';
import { createZohoJournal, uploadJournalAttachment } from '../../services/zohoService.js';

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

export const uploadFineJournalAttachments = upload.array('attachments', 5);

async function isAccountsActor(req) {
    if (req.user?.isAdmin === true) return true;
    const inAccounts =
        (await isUserInFlowchart(req.user, 'accounts').catch(() => false)) ||
        (await isUserInFlowchart(req.user, 'finance').catch(() => false));
    if (inAccounts) return true;
    const dept = String(req.user?.department || '').toLowerCase();
    return dept === 'finance' || dept === 'account' || dept === 'accounts';
}

async function loadFineGroup(id) {
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);
    let fines = [];

    if (isValidObjectId) {
        const targetFine = await Fine.findById(id);
        if (targetFine) {
            const baseId =
                targetFine.fineId.split('-').length > 3
                    ? targetFine.fineId.split('-').slice(0, 3).join('-')
                    : targetFine.fineId;
            const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
            fines = await Fine.find({ fineId: baseIdRegex });
        }
    }

    if (fines.length === 0) {
        const baseId = String(id).split('-').length > 3 ? String(id).split('-').slice(0, 3).join('-') : id;
        const baseIdRegex = new RegExp(`^${baseId}(-[A-Z0-9]+)?$`, 'i');
        fines = await Fine.find({ fineId: baseIdRegex });
    }

    return fines;
}

function journalTypeFromReporting(method) {
    const value = String(method || '').trim().toLowerCase();
    if (value === 'accrual' || value === 'accrual only') return 'accrual';
    if (value === 'cash' || value === 'cash only') return 'cash';
    return 'both';
}

function buildJournalPayload(body) {
    const journalDate = String(body.journalDate || body.journal_date || '').trim();
    const notes = String(body.notes || '').trim();
    const lines = Array.isArray(body.lineItems) ? body.lineItems : [];

    if (!journalDate) {
        const error = new Error('Date is required.');
        error.statusCode = 400;
        throw error;
    }
    if (!notes) {
        const error = new Error('Notes are required.');
        error.statusCode = 400;
        throw error;
    }
    if (notes.length > 500) {
        const error = new Error('Notes must be 500 characters or less.');
        error.statusCode = 400;
        throw error;
    }

    let debitTotal = 0;
    let creditTotal = 0;
    const line_items = [];

    for (const line of lines) {
        const accountId = String(line?.accountId || line?.account_id || '').trim();
        const debit = Number(line?.debit || 0) || 0;
        const credit = Number(line?.credit || 0) || 0;
        const description = String(line?.description || '').trim();
        const contactId = String(line?.contactId || line?.customer_id || '').trim();

        if (!accountId && debit <= 0 && credit <= 0 && !description && !contactId) continue;
        if (!accountId) {
            const error = new Error('Each journal row needs an account.');
            error.statusCode = 400;
            throw error;
        }
        if (debit > 0 && credit > 0) {
            const error = new Error('A journal row cannot have both a debit and a credit.');
            error.statusCode = 400;
            throw error;
        }
        if (debit <= 0 && credit <= 0) {
            const error = new Error('Each journal row needs a debit or a credit amount.');
            error.statusCode = 400;
            throw error;
        }

        const amount = Number((debit > 0 ? debit : credit).toFixed(2));
        debitTotal += debit > 0 ? amount : 0;
        creditTotal += credit > 0 ? amount : 0;

        const item = {
            account_id: accountId,
            amount,
            debit_or_credit: debit > 0 ? 'debit' : 'credit',
        };
        if (description) item.description = description;
        if (contactId) item.customer_id = contactId;
        line_items.push(item);
    }

    if (line_items.length < 2) {
        const error = new Error('A journal needs at least two lines.');
        error.statusCode = 400;
        throw error;
    }

    const difference = Number((debitTotal - creditTotal).toFixed(2));
    if (Math.abs(difference) > 0.009) {
        const error = new Error('Debits and credits must balance before the journal can be added.');
        error.statusCode = 400;
        throw error;
    }

    const status = String(body.status || 'published').trim().toLowerCase() === 'draft'
        ? 'draft'
        : 'published';

    const payload = {
        journal_date: journalDate,
        notes,
        journal_type: journalTypeFromReporting(body.reportingMethod),
        line_items,
        status,
    };

    const reference = String(body.referenceNumber || body.reference_number || '').trim();
    if (reference) payload.reference_number = reference;

    const entryNumber = String(body.journalNumber || body.entry_number || '').trim();
    if (entryNumber) payload.entry_number = entryNumber;

    const currencyId = String(body.currencyId || body.currency_id || '').trim();
    if (currencyId) payload.currency_id = currencyId;

    const locationId = String(body.locationId || body.location_id || '').trim();
    if (locationId) payload.location_id = locationId;

    const reversalDate = String(body.reverseJournalDate || body.reversal_date || '').trim();
    if (reversalDate) payload.reversal_date = reversalDate;

    return { payload, status };
}

/**
 * Accounts → Make Payment → My Journal.
 * Creates the Zoho Books manual journal (fields + attachments) and, when published,
 * completes Make Payment and stores the Zoho Journal# on the fine.
 */
export async function postFineMyJournal(req, res) {
    let { id } = req.params;
    if (id && typeof id === 'string' && id.includes(':')) {
        id = id.split(':')[0].trim();
    }

    try {
        if (!(await isAccountsActor(req))) {
            return res.status(403).json({ message: 'Only Accounts can add a journal for this fine.' });
        }

        const fines = await loadFineGroup(id);
        if (!fines.length) {
            return res.status(404).json({ message: 'Fine(s) not found' });
        }

        const fine = fines[0];
        const status = String(fine.fineStatus || '');
        if (!['Approved', 'Active'].includes(status)) {
            return res.status(400).json({
                message: `Fine must be Approved before a journal can be added (status: ${status}).`,
            });
        }
        if (fines.some((f) => String(f.accountsPaymentPath || '').trim())) {
            return res.status(400).json({
                message: 'Accounts has already settled this fine.',
            });
        }

        let body = req.body?.payload ?? req.body ?? {};
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                return res.status(400).json({ message: 'Journal details are not valid JSON.' });
            }
        }

        const { payload, status: journalStatus } = buildJournalPayload(body);
        const orgId = String(body.organizationId || fine.zohoOrganizationId || '').trim();

        const run = async () => {
            const journal = await createZohoJournal(payload);
            const journalId = String(journal?.journal_id || journal?.journalId || '').trim();
            const journalNumber = String(
                journal?.entry_number || journal?.journal_number || '',
            ).trim();

            const files = Array.isArray(req.files) ? req.files.slice(0, 5) : [];
            const attachmentErrors = [];
            if (journalId && files.length) {
                for (const file of files) {
                    try {
                        await uploadJournalAttachment(journalId, {
                            buffer: file.buffer,
                            filename: file.originalname || 'attachment',
                            mimeType: file.mimetype || 'application/octet-stream',
                        });
                    } catch (err) {
                        attachmentErrors.push(
                            `${file.originalname || 'file'}: ${err?.message || 'upload failed'}`,
                        );
                    }
                }
            }

            return { journal, journalId, journalNumber, attachmentErrors };
        };

        const result = orgId ? await withZohoOrganization(orgId, run) : await run();

        if (journalStatus === 'published') {
            for (const f of fines) {
                f.accountsPaymentPath = 'journal';
                f.accountsPaymentAt = new Date();
                f.accountsPaymentBy = req.user._id;
                f.zohoJournalId = result.journalId;
                f.zohoJournalNumber = result.journalNumber;
                f.zohoJournalStatus = 'published';
                if (orgId) f.zohoOrganizationId = orgId;
                await f.save();
            }
            await closeAccountsPaymentInbox(fine, fines);
        }

        const fresh = await Fine.findById(fines[0]._id);
        return res.status(200).json({
            message: result.attachmentErrors.length
                ? `Journal ${result.journalNumber || ''} saved in Zoho. Some attachments failed: ${result.attachmentErrors.join('; ')}`
                : journalStatus === 'published'
                  ? `Journal ${result.journalNumber || ''} added in Zoho. Make Payment is completed.`
                  : `Journal ${result.journalNumber || ''} saved as draft in Zoho.`,
            fine: fresh,
            journalNumber: result.journalNumber,
            journalId: result.journalId,
            attachmentErrors: result.attachmentErrors,
        });
    } catch (error) {
        console.error('postFineMyJournal:', error);
        const statusCode = error.statusCode || 500;
        return res.status(statusCode).json({
            message: error?.message || 'Failed to add the journal in Zoho.',
        });
    }
}

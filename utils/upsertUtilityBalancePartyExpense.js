import PartyExpense from '../models/PartyExpense.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { createZohoJournal, getZohoOrganizationId } from '../services/zohoService.js';
import { withZohoOrganization } from './zohoOrgContext.js';

const COMPANY_PARTY_ID = 'VEGA-HR-0000';

function clean(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

/** Zoho journals require a full YYYY-MM-DD date. */
function zohoJournalDate(bill) {
    const billDate = clean(bill?.billDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(billDate)) return billDate;

    const month = clean(bill?.billMonth);
    if (/^\d{4}-\d{2}$/.test(month)) {
        const dayRaw = Number(bill?.paymentDay);
        const [y, m] = month.split('-').map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        const day =
            Number.isInteger(dayRaw) && dayRaw >= 1 ? Math.min(dayRaw, lastDay) : Math.min(16, lastDay);
        return `${month}-${String(day).padStart(2, '0')}`;
    }

    return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve business employeeId (VEGA-HR-…) from Mongo _id or already-business id.
 */
export async function resolveBusinessEmployeeId(payByEmployeeId) {
    const raw = clean(payByEmployeeId);
    if (!raw) return '';
    if (!/^[0-9a-fA-F]{24}$/.test(raw)) return raw;

    const emp = await EmployeeBasic.findById(raw).select('employeeId').lean();
    return clean(emp?.employeeId, raw);
}

/** Employee + Mongo id variants for querying payByEmployeeId / PartyExpense.employeeId. */
export async function employeeIdQueryVariants(employeeId) {
    const raw = clean(employeeId);
    if (!raw) return [];

    const ids = new Set([raw]);
    const emp = await EmployeeBasic.findOne({
        $or: [
            { employeeId: raw },
            ...(/^[0-9a-fA-F]{24}$/.test(raw) ? [{ _id: raw }] : []),
        ],
    })
        .select('_id employeeId')
        .lean();

    if (emp) {
        ids.add(String(emp._id));
        ids.add(clean(emp.employeeId));
    }
    return [...ids].filter(Boolean);
}

/**
 * Absolute difference |Contract − Actual|.
 * Only non-zero difference creates payable + Account 2 debit.
 */
function differenceBalanceAmount(bill) {
    const fromField = Number(bill?.differenceAmount);
    if (Number.isFinite(fromField) && Math.abs(fromField) > 0.009) {
        return money(Math.abs(fromField));
    }

    const empDiff = Number(bill?.employeeDiffAmount);
    const companyDiff = Number(bill?.companyDiffAmount);
    if (Number.isFinite(empDiff) && empDiff > 0.009) return money(empDiff);
    if (Number.isFinite(companyDiff) && companyDiff > 0.009) return money(companyDiff);

    const actual = money(bill?.amount);
    const contract = money(bill?.monthlyRental);
    const abs = Math.abs(contract - actual);
    return abs > 0.009 ? money(abs) : 0;
}

async function resolveBusinessCompanyId(payByCompanyId) {
    const raw = clean(payByCompanyId);
    if (!raw) return '';
    const query = /^[0-9a-fA-F]{24}$/.test(raw) ? { _id: raw } : { companyId: raw };
    const company = await Company.findOne(query).select('companyId').lean();
    return clean(company?.companyId, raw);
}

/**
 * Chart of Accounts on HR Approve (difference only):
 *   Acc2 (balance / salary payable)  → Debit
 *   Acc1 (to vendor / expense)       → Credit
 * Never Debit both.
 */
export async function postDifferenceDebitJournalToZoho(bill, amount) {
    const partyAccountId = clean(bill?.partyAccountId);
    const expenseAccountId = clean(bill?.expenseAccountId);
    const existingJournalId = clean(bill?.zohoDifferenceJournalId);

    if (existingJournalId) {
        return { ok: true, skipped: true, journalId: existingJournalId };
    }
    if (amount <= 0 || !partyAccountId) {
        return { ok: false, skipped: true, message: 'No difference account to debit.' };
    }
    if (!expenseAccountId) {
        return {
            ok: false,
            message: 'Expense account (to vendor) is required to post the difference debit journal.',
        };
    }
    if (partyAccountId === expenseAccountId) {
        return {
            ok: false,
            message: 'Difference account and vendor account must be different Chart of Accounts rows.',
        };
    }

    const orgId = clean(bill?.zohoOrganizationId) || getZohoOrganizationId();
    const journalDate = zohoJournalDate(bill);
    const reference = clean(bill?.billNumber || bill?.accountNo || bill?._id);

    try {
        const journal = await withZohoOrganization(orgId, () =>
            createZohoJournal({
                journal_date: journalDate,
                reference_number: reference || undefined,
                notes: `Utility difference debit · ${clean(bill?.utilityType)} ${clean(bill?.billMonth)} · Acc ${clean(bill?.accountNo)}`,
                line_items: [
                    {
                        account_id: partyAccountId,
                        amount,
                        debit_or_credit: 'debit',
                        description:
                            clean(bill?.partyAccountName, bill?.partyAccountCode) ||
                            'Difference pay account',
                    },
                    {
                        account_id: expenseAccountId,
                        amount,
                        debit_or_credit: 'credit',
                        description:
                            clean(bill?.expenseAccountName) || 'Utility expense (to vendor)',
                    },
                ],
            }),
        );

        const journalId = clean(journal?.journal_id || journal?.journalId || journal?.id);
        if (!journalId) {
            return { ok: false, message: 'Zoho journal created but no journal id returned.' };
        }

        if (bill && typeof bill.save === 'function') {
            bill.zohoDifferenceJournalId = journalId;
            await bill.save();
        }

        return { ok: true, journalId, organizationId: orgId };
    } catch (err) {
        const message = err?.message || 'Failed to post difference debit journal to Zoho.';
        console.error('[UtilityDifferenceZoho]', message);
        if (bill && typeof bill.save === 'function') {
            const prev = clean(bill.zohoSyncError);
            bill.zohoSyncError = prev
                ? `${prev} · Difference Debit failed: ${message}`
                : `Difference Debit failed: ${message}`;
            try {
                await bill.save();
            } catch {
                /* ignore */
            }
        }
        return { ok: false, message, organizationId: orgId };
    }
}

/**
 * After HR approve: if Difference ≠ 0 only —
 * 1) upsert Not Paid PartyExpense on payable party (employee/company profile)
 * 2) post Chart of Accounts Debit on Account 2 (difference pay here)
 */
export async function upsertUtilityBalancePartyExpensesFromBills(bills = [], userId = null) {
    const results = [];
    for (const bill of bills || []) {
        const paymentBy = clean(bill?.paymentBy).toLowerCase();
        const isCompany = paymentBy === 'company';
        const isEmployee = paymentBy === 'employee' || paymentBy === 'employee_balance';
        // Difference pay is separate from main vendor bill — only when a party is set.
        if (!isCompany && !isEmployee) {
            results.push({ ok: true, skipped: true, reason: 'no_payable_party' });
            continue;
        }

        const amount = differenceBalanceAmount(bill);
        if (amount <= 0) {
            results.push({ ok: true, skipped: true, reason: 'no_difference' });
            continue;
        }

        const utilityBillId = clean(bill?._id || bill?.id);
        if (!utilityBillId) continue;

        const businessEmployeeId = isCompany
            ? COMPANY_PARTY_ID
            : await resolveBusinessEmployeeId(bill.payByEmployeeId);
        const businessCompanyId = isCompany
            ? await resolveBusinessCompanyId(bill.payByCompanyId)
            : '';
        if ((!isCompany && !businessEmployeeId) || (isCompany && !businessCompanyId)) {
            results.push({
                ok: false,
                message: isCompany
                    ? 'Company name is required for difference payable.'
                    : 'Employee is required for difference payable.',
            });
            continue;
        }

        // Chart of Accounts Debit on difference account (Account 2) at HR approve.
        const journalResult = await postDifferenceDebitJournalToZoho(bill, amount);
        if (!journalResult.ok && !journalResult.skipped) {
            console.warn(
                '[UtilityDifferenceZoho] Journal failed for bill',
                utilityBillId,
                journalResult.message,
            );
        } else if (journalResult.ok) {
            console.log(
                '[UtilityDifferenceZoho] Debit posted:',
                JSON.stringify({
                    utilityBillId,
                    amount,
                    journalId: journalResult.journalId,
                    partyAccountId: clean(bill.partyAccountId),
                    skipped: Boolean(journalResult.skipped),
                }),
            );
        }

        let doc = await PartyExpense.findOne({
            utilityBillId,
            kind: 'balance',
            partyType: isCompany ? 'company' : 'employee',
            ...(isCompany ? {} : { employeeId: businessEmployeeId }),
        });

        if (!doc) {
            doc = new PartyExpense({
                partyType: isCompany ? 'company' : 'employee',
                kind: 'balance',
                employeeId: businessEmployeeId,
                employeeName: isCompany
                    ? clean(bill.payByCompanyName)
                    : clean(bill.payByEmployeeName),
                companyId: businessCompanyId,
                companyName: isCompany ? clean(bill.payByCompanyName) : '',
                utilityBillId,
                status: 'Not Paid',
                createdBy: userId || null,
                ledger: [],
            });
        }

        // Do not overwrite Paid rows from a later approve/retry.
        if (doc.status === 'Paid') {
            results.push({
                ok: true,
                skipped: true,
                expenseId: String(doc._id),
                journalId: journalResult.journalId || '',
            });
            continue;
        }

        doc.status = 'Not Paid';
        doc.amount = amount;
        doc.employeeName = clean(
            isCompany ? bill.payByCompanyName : bill.payByEmployeeName,
            doc.employeeName,
        );
        if (isCompany) {
            doc.companyId = businessCompanyId;
            doc.companyName = clean(bill.payByCompanyName, doc.companyName);
        }
        doc.utilityBatchId = clean(bill.batchId, doc.utilityBatchId);
        doc.accountNo = clean(bill.accountNo, doc.accountNo);
        doc.utilityType = clean(bill.utilityType, doc.utilityType);
        doc.billMonth = clean(bill.billMonth, doc.billMonth);
        doc.entryId = clean(bill.entryId, doc.entryId);
        doc.zohoBillId = clean(bill.zohoBillId, doc.zohoBillId);
        doc.zohoOrganizationId = clean(bill.zohoOrganizationId, doc.zohoOrganizationId);
        doc.partyAccountId = clean(bill.partyAccountId, doc.partyAccountId);
        doc.partyAccountName = clean(bill.partyAccountName, doc.partyAccountName);
        doc.partyAccountCode = clean(bill.partyAccountCode, doc.partyAccountCode);
        if (journalResult.journalId) {
            doc.zohoJournalId = clean(journalResult.journalId, doc.zohoJournalId);
        }
        doc.description = clean(
            `Difference amount · ${clean(bill.utilityType)} ${clean(bill.billMonth)} · Acc ${clean(bill.accountNo)}`,
        );

        const debitAccountId = clean(bill.partyAccountId);
        const creditAccountId = clean(bill.expenseAccountId);
        const already =
            debitAccountId &&
            (doc.ledger || []).some(
                (line) =>
                    line.side === 'debit' &&
                    clean(line.accountId) === debitAccountId &&
                    money(line.amount) === amount,
            );
        if (debitAccountId && !already) {
            // Acc2 (balance) Debit · Acc1 (to vendor) Credit — never both Debit.
            doc.ledger.push({
                side: 'debit',
                accountId: debitAccountId,
                accountName: clean(bill.partyAccountName, bill.partyAccountCode),
                amount,
                notes: `Debit Acc2 balance (${clean(bill.partyAccountCode, isCompany ? businessCompanyId : businessEmployeeId)})`,
                locked: true,
                createdAt: new Date(),
            });
            if (creditAccountId && creditAccountId !== debitAccountId) {
                doc.ledger.push({
                    side: 'credit',
                    accountId: creditAccountId,
                    accountName: clean(bill.expenseAccountName, 'Account 1'),
                    amount,
                    notes: `Credit Acc1 (to vendor) · difference ${amount}`,
                    locked: true,
                    createdAt: new Date(),
                });
            }
        }
        await doc.save();
        const journalFailed = !journalResult.ok && !journalResult.skipped;
        results.push({
            ok: !journalFailed,
            expenseId: String(doc._id),
            amount,
            journalId: journalResult.journalId || '',
            journalOk: Boolean(journalResult.ok),
            journalMessage: journalResult.message || '',
            message: journalFailed
                ? journalResult.message ||
                  'Zoho Chart of Accounts Difference Debit failed. Re-connect Zoho with accountants.CREATE, then Retry Zoho sync.'
                : '',
        });
    }
    return results;
}

/**
 * Mark utility balance PartyExpense Paid after Accounts → Payments Made (difference pay).
 */
export async function markUtilityBalancePartyExpensePaid({
    utilityBillId = '',
    employeeId = '',
    amount = 0,
    payment = null,
    zohoResult = {},
    expenseAccountId = '',
    expenseAccountName = '',
    paidThroughAccountId = '',
    paidThroughAccountName = '',
    userId = null,
} = {}) {
    const billId = clean(utilityBillId);
    const businessEmployeeId = await resolveBusinessEmployeeId(employeeId);
    if (!billId || !businessEmployeeId) {
        return { ok: false, message: 'utilityBillId and employeeId are required.' };
    }

    let doc = await PartyExpense.findOne({
        utilityBillId: billId,
        kind: 'balance',
        partyType: 'employee',
        employeeId: businessEmployeeId,
    });

    if (!doc) {
        doc = new PartyExpense({
            partyType: 'employee',
            kind: 'balance',
            employeeId: businessEmployeeId,
            utilityBillId: billId,
            createdBy: userId || null,
            ledger: [],
        });
    }

    const payAmt = money(amount || payment?.amount || doc.amount);
    const creditId = clean(paidThroughAccountId || payment?.paidThroughAccountId);
    const creditName = clean(paidThroughAccountName || payment?.paidThroughAccountName, 'Paid Through');
    const debitId = clean(doc.partyAccountId || expenseAccountId || payment?.expenseAccountId);
    const debitName = clean(
        doc.partyAccountName || expenseAccountName || payment?.expenseAccountName,
        'Party payable',
    );

    if (payAmt > 0 && creditId && debitId) {
        const already = (doc.ledger || []).some(
            (row) =>
                row.locked &&
                String(row.accountId) === creditId &&
                row.side === 'credit' &&
                Number(row.amount) === payAmt,
        );
        if (!already) {
            doc.ledger.push(
                {
                    side: 'debit',
                    accountId: debitId,
                    accountName: debitName,
                    amount: payAmt,
                    notes: 'Debit (difference settle)',
                    locked: true,
                    createdAt: new Date(),
                },
                {
                    side: 'credit',
                    accountId: creditId,
                    accountName: creditName,
                    amount: payAmt,
                    notes: 'Credit (Paid Through)',
                    locked: true,
                    createdAt: new Date(),
                },
            );
        }
    }

    doc.status = 'Paid';
    doc.amount = payAmt > 0 ? payAmt : doc.amount;
    doc.zohoOrganizationId = clean(
        zohoResult.organizationId || payment?.zohoOrganizationId,
        doc.zohoOrganizationId,
    );
    doc.zohoJournalId = clean(zohoResult.journalId || payment?.zohoJournalId, doc.zohoJournalId);
    doc.paidThroughAccountId = creditId || doc.paidThroughAccountId;
    doc.paidThroughAccountName = creditName || doc.paidThroughAccountName;
    doc.paidAt = new Date();
    doc.erpPaymentId = clean(payment?._id, doc.erpPaymentId);
    doc.paymentMode = clean(payment?.paymentSource, doc.paymentMode);
    await doc.save();

    return { ok: true, expense: doc.toObject() };
}

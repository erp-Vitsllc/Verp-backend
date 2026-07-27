import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import { resolveEmployeeEmail } from './resolveEmployeeEmail.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';

function createTransport() {
    const emailUser = process.env.EMAIL_USER;
    const emailPass = process.env.EMAIL_PASS;
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
}

async function resolveRecipient(person) {
    if (!person) return null;
    if (person._id) {
        const fresh = await EmployeeBasic.findById(person._id)
            .select(
                'firstName lastName companyEmail workEmail personalEmail email employeeId profileStatus status primaryReportee',
            )
            .populate(
                'primaryReportee',
                'firstName lastName companyEmail workEmail personalEmail email employeeId',
            )
            .lean();
        if (fresh) return fresh;
    }
    return person;
}

function uniqueEmails(list = []) {
    const seen = new Set();
    const out = [];
    (list || []).forEach((email) => {
        const e = String(email || '')
            .trim()
            .toLowerCase();
        if (!e || seen.has(e)) return;
        seen.add(e);
        out.push(e);
    });
    return out;
}

/**
 * Utility bill workflow emails (Accounts / HR / Pay / requester updates).
 * kind: pending_accounts | pending_hr | pending_pay | approved | rejected |
 *       returned_accounts | returned_creator | paid | partially_paid | zoho_payable
 */
export async function sendUtilityBillPaymentEmail({
    recipient,
    bill,
    kind = 'pending_accounts',
    batchMeta = null,
    cc = [],
}) {
    try {
        const transporter = createTransport();
        const to = await resolveRecipient(recipient);
        const { email: recipientEmail } = resolveEmployeeEmail(to || {});
        if (!transporter || !to || !recipientEmail) {
            console.warn('[UtilityBillPaymentEmail] Missing SMTP or recipient email.');
            return;
        }

        const frontendUrl = emailFrontendUrl();
        const path =
            batchMeta?.reviewPath ||
            (bill.batchId
                ? `/HRM/Asset/UtilityBills?batchId=${encodeURIComponent(String(bill.batchId))}&review=1`
                : `/HRM/Asset/UtilityBills/details/${encodeURIComponent(bill.entryId)}?billId=${encodeURIComponent(String(bill._id))}`);
        const buttonUrl = `${frontendUrl}${path}`;
        const amountTxt = `AED ${Number(bill.amount || 0).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        })}`;
        const countTxt = batchMeta?.billCount ? `${batchMeta.billCount} account(s)` : '1 account';
        const remainingTxt =
            batchMeta?.remaining != null ? ` (${batchMeta.remaining} still pending pay)` : '';
        const payableLines = Array.isArray(batchMeta?.payableLines)
            ? batchMeta.payableLines
            : [];
        const rejectComment = String(batchMeta?.comment || bill?.comment || '').trim();

        const titles = {
            pending_accounts: 'Utility Bill — Accounts Approval Required',
            pending_hr: 'Utility Bill — HR Approval Required',
            pending_pay: 'Utility Bill — Ready to Pay',
            approved: 'Utility Bill Approved',
            rejected: 'Utility Bill Rejected',
            returned_accounts: 'Utility Bill — Returned to Accounts',
            returned_creator: 'Utility Bill — Returned to Creator',
            paid: 'Utility Bill Paid',
            partially_paid: 'Utility Bill — Partially Paid',
            zoho_payable: 'Utility Bill — Entered in Zoho (Payable Notice)',
            pending: 'Utility Bill — Approval Required',
        };
        const colors = {
            pending_accounts: '#0d9488',
            pending_hr: '#2563eb',
            pending_pay: '#d97706',
            approved: '#16a34a',
            rejected: '#dc2626',
            returned_accounts: '#ea580c',
            returned_creator: '#dc2626',
            paid: '#16a34a',
            partially_paid: '#d97706',
            zoho_payable: '#0f766e',
            pending: '#0d9488',
        };
        const bodies = {
            pending_accounts: 'New utility bills were submitted and need Accounts review/approval.',
            pending_hr: 'Accounts approved these utility bills. HR review/approval is required.',
            pending_pay:
                'HR approved these utility bills. Please open the batch and Pay the selected amounts.',
            approved: 'Your utility bill batch was approved and is awaiting Accounts payment.',
            rejected: 'Your utility bill batch was rejected.',
            returned_accounts:
                'HR rejected this utility bill batch. It was returned to Accounts for re-review.',
            returned_creator:
                'Accounts rejected this utility bill batch. It was returned to you (the creator) for correction.',
            paid: 'Your utility bill batch has been marked Paid by Accounts.',
            partially_paid: `Accounts paid some bills in this batch${remainingTxt}. Remaining bills are still awaiting payment.`,
            zoho_payable:
                'A utility bill has been created in Zoho Books. You are listed as Payable to on one or more lines.',
            pending: 'A utility bill requires your approval.',
        };

        const payableHtml = payableLines.length
            ? `<div style="margin-top:14px; background:#ecfdf5; border:1px solid #a7f3d0; border-radius:10px; padding:14px;">
                    <p style="margin:0 0 8px; font-weight:700; color:#065f46;">Payable to</p>
                    ${payableLines
                        .map(
                            (line) =>
                                `<p style="margin:0 0 4px;"><strong>${line.name || '—'}</strong>${
                                    line.amount != null
                                        ? ` — AED ${Number(line.amount || 0).toLocaleString(undefined, {
                                              minimumFractionDigits: 2,
                                              maximumFractionDigits: 2,
                                          })}`
                                        : ''
                                }${line.item ? ` · ${line.item}` : ''}</p>`,
                        )
                        .join('')}
               </div>`
            : '';

        const html = `
            <div style="font-family: Segoe UI, Tahoma, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background:${colors[kind] || colors.pending}; color:#fff; padding:24px; text-align:center;">
                    <h1 style="margin:0; font-size:22px;">${titles[kind] || titles.pending}</h1>
                </div>
                <div style="padding:28px;">
                    <p>Hello <strong>${to.firstName || ''} ${to.lastName || ''}</strong>,</p>
                    <p style="margin:12px 0 20px;">${bodies[kind] || bodies.pending}</p>
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:10px; padding:18px;">
                        <p style="margin:0 0 8px;"><strong>Type:</strong> ${bill.utilityType || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Month:</strong> ${bill.billMonth || '—'}</p>
                        <p style="margin:0 0 8px;"><strong>Accounts:</strong> ${countTxt}</p>
                        <p style="margin:0;"><strong>Total amount:</strong> ${amountTxt}</p>
                    </div>
                    ${payableHtml}
                    ${
                        rejectComment
                            ? `<div style="margin-top:14px; background:#fef2f2; border:1px solid #fecaca; border-radius:10px; padding:14px;">
                                    <p style="margin:0 0 4px; font-weight:700; color:#991b1b;">Comment</p>
                                    <p style="margin:0; color:#7f1d1d;">${rejectComment}</p>
                               </div>`
                            : ''
                    }
                    <div style="text-align:center; margin-top:28px;">
                        <a href="${buttonUrl}" style="background:${colors[kind] || colors.pending}; color:#fff; padding:12px 28px; text-decoration:none; border-radius:8px; font-weight:700; display:inline-block;">
                            Open Utility Bills
                        </a>
                    </div>
                </div>
            </div>
        `;

        const ccList = uniqueEmails(cc).filter(
            (e) => e !== String(recipientEmail || '').trim().toLowerCase(),
        );

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            cc: ccList.length ? ccList.join(', ') : undefined,
            subject: `${titles[kind] || titles.pending}: ${bill.utilityType || 'Utility'} — ${amountTxt}`,
            html,
        });
    } catch (err) {
        console.error('[UtilityBillPaymentEmail] Failed:', err?.message || err);
    }
}

function collectPayableEmployeeIds(bills = []) {
    const ids = new Set();
    (bills || []).forEach((bill) => {
        const rowId = String(bill?.payByEmployeeId || '').trim();
        if (rowId) ids.add(rowId);
        (Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : []).forEach((line) => {
            const lineId = String(line?.payByEmployeeId || '').trim();
            if (lineId) ids.add(lineId);
        });
    });
    return [...ids];
}

function payableLinesForEmployee(bills = [], employeeId) {
    const lines = [];
    const eid = String(employeeId || '');
    (bills || []).forEach((bill) => {
        const rowItems = Array.isArray(bill?.zohoLineItems) ? bill.zohoLineItems : [];
        if (rowItems.length) {
            rowItems.forEach((line) => {
                if (String(line?.payByEmployeeId || '') !== eid) return;
                lines.push({
                    name: String(line.payByEmployeeName || '').trim(),
                    amount: Number(line.amount) || 0,
                    item: String(line.item || line.description || '').trim(),
                });
            });
            return;
        }
        if (String(bill?.payByEmployeeId || '') === eid) {
            lines.push({
                name: String(bill.payByEmployeeName || '').trim(),
                amount: Number(bill.employeePayAmount) || Number(bill.amount) || 0,
                item: String(bill.utilityType || '').trim(),
            });
        }
    });
    return lines;
}

/**
 * After Zoho bill create/open: email each Payable-to employee,
 * CC their primary reportees (HODs) and flowchart HR.
 */
export async function notifyUtilityBillZohoPayableParties({
    bills = [],
    batchMeta = null,
} = {}) {
    try {
        const list = (bills || []).map((b) =>
            typeof b?.toObject === 'function' ? b.toObject() : b,
        );
        if (!list.length) return;

        const ids = collectPayableEmployeeIds(list);
        if (!ids.length) {
            console.warn(
                '[notifyUtilityBillZohoPayableParties] No Payable-to employees on bills.',
            );
            return;
        }

        const objectIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
        const employees = await EmployeeBasic.find({
            $or: [
                ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
                { employeeId: { $in: ids } },
            ],
        })
            .select(
                'firstName lastName companyEmail workEmail personalEmail email employeeId primaryReportee',
            )
            .populate(
                'primaryReportee',
                'firstName lastName companyEmail workEmail personalEmail email employeeId',
            )
            .lean();

        if (!employees.length) return;

        const hr = await getDepartmentHOD('hr');
        const { email: hrEmail } = resolveEmployeeEmail(hr || {});

        const first = list[0] || {};
        const totalAmount = list.reduce((s, b) => s + (Number(b.amount) || 0), 0);

        for (const emp of employees) {
            const empKey = String(emp._id);
            const payableLines = payableLinesForEmployee(list, empKey);
            const cc = [];
            const hod = emp.primaryReportee;
            if (hod) {
                const { email: hodEmail } = resolveEmployeeEmail(hod);
                if (hodEmail) cc.push(hodEmail);
            }
            if (hrEmail) cc.push(hrEmail);

            // Also CC other Payable-to employees on the same batch
            employees.forEach((other) => {
                if (String(other._id) === empKey) return;
                const { email: otherEmail } = resolveEmployeeEmail(other);
                if (otherEmail) cc.push(otherEmail);
            });

            await sendUtilityBillPaymentEmail({
                recipient: emp,
                bill: {
                    ...first,
                    amount: totalAmount,
                },
                kind: 'zoho_payable',
                cc,
                batchMeta: {
                    ...(batchMeta || {}),
                    billCount: list.length,
                    payableLines:
                        payableLines.length > 0
                            ? payableLines
                            : [
                                  {
                                      name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim(),
                                      amount: null,
                                      item: '',
                                  },
                              ],
                },
            });
        }
    } catch (err) {
        console.error(
            '[notifyUtilityBillZohoPayableParties] Failed:',
            err?.message || err,
        );
    }
}

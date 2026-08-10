import nodemailer from 'nodemailer';
import { resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import axios from 'axios';
import { resolveEmployeeEmail, addEmployeeEmailToSet, getFallbackEmailNote } from './resolveEmployeeEmail.js';
import { buildFineFormSummary } from './buildFineFormSummary.js';
import { buildFineConfirmedEmailHtml } from './buildFineConfirmedEmailHtml.js';
import { generateFineApprovedReportPdfBuffer } from './generateFineApprovedReportPdfBuffer.js';
import { isLossDamageFineType } from './buildAssetLossFineEmailFields.js';
import { isCompanyFineParty } from './fineGroupClassification.js';
import { resolveCompanyFineAdminRecipient } from './resolveCompanyFineAdminRecipient.js';

/**
 * Sends a confirmation email to assigned employees when a fine is fully approved.
 * TO: each assigned employee; CC: all other assigned employees + HR + Admin (+ stakeholders).
 * Email body is a short message; the fine report PDF is attached when available.
 *
 * @param {object} [options]
 * @param {Array} [options.ccAssignedEmployees] Extra assignees to CC (e.g. garage bill group parties).
 */
export const sendFineConfirmedEmail = async (fine, assignedEmployees, req = null, options = {}) => {
    try {
        console.log(`[FineConfirmedEmail] Preparing email for Fine #${fine.fineId}`);

        const fineAssignees = Array.isArray(fine?.assignedEmployees) ? fine.assignedEmployees : [];
        const extraCcAssignees = Array.isArray(options?.ccAssignedEmployees)
            ? options.ccAssignedEmployees
            : [];
        const allAssigneeRows = [...(assignedEmployees || []), ...fineAssignees, ...extraCcAssignees];

        const employeeIds = [
            ...new Set(
                allAssigneeRows
                    .map((e) => e?.employeeId)
                    .filter((id) => id && !['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(String(id))),
            ),
        ];
        const fullEmployees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId firstName lastName companyEmail workEmail personalEmail primaryReportee secondaryReportee reportingAuthority')
            .populate('primaryReportee', 'companyEmail workEmail firstName lastName employeeId')
            .populate('secondaryReportee', 'companyEmail workEmail')
            .populate('reportingAuthority', 'companyEmail workEmail');

        const User = await import('../models/User.js').then((m) => m.default);
        const creator = await User.findById(fine.createdBy).select('email companyEmail').lean();

        const ccEmails = new Set();

        // CC every employee assigned on the fine (and any group co-assignees).
        fullEmployees.forEach((emp) => {
            addEmployeeEmailToSet(ccEmails, emp);
            addEmployeeEmailToSet(ccEmails, emp.primaryReportee);
            addEmployeeEmailToSet(ccEmails, emp.secondaryReportee);
            addEmployeeEmailToSet(ccEmails, emp.reportingAuthority);
        });

        if (creator?.companyEmail) {
            const creatorMail = String(creator.companyEmail).trim();
            if (creatorMail) ccEmails.add(creatorMail);
        }

        let hrHOD = null;
        let accountsHOD = null;
        let hrHODName = '';
        let accountsHODName = '';
        let ceoName = '';

        if (employeeIds.length > 0) {
            try {
                const { getDepartmentHOD } = await import('./getDepartmentHOD.js');
                const { getManagementHOD } = await import('./getManagementHOD.js');
                const { resolveAssetControllerEmployee } = await import('./assetApprovalHelpers.js');

                hrHOD = await getDepartmentHOD('hr');
                addEmployeeEmailToSet(ccEmails, hrHOD);

                const adminHOD = await getDepartmentHOD('admincontroller');
                addEmployeeEmailToSet(ccEmails, adminHOD);

                accountsHOD = await getDepartmentHOD('finance');
                addEmployeeEmailToSet(ccEmails, accountsHOD);

                const managementHOD = await getManagementHOD(employeeIds[0]);
                addEmployeeEmailToSet(ccEmails, managementHOD);

                hrHODName = hrHOD ? `${hrHOD.firstName || ''} ${hrHOD.lastName || ''}`.trim() : '';
                accountsHODName = accountsHOD ? `${accountsHOD.firstName || ''} ${accountsHOD.lastName || ''}`.trim() : '';
                ceoName = managementHOD ? `${managementHOD.firstName || ''} ${managementHOD.lastName || ''}`.trim() : '';

                const ft = String(fine.fineType || '').toLowerCase();
                const isLossDamageAssetFine =
                    !!(fine.assetId && String(fine.assetId).trim()) &&
                    (fine.category === 'Loss' ||
                        fine.category === 'Damage' ||
                        ft.includes('loss & damage') ||
                        ft.includes('loss and damage'));
                if (isLossDamageAssetFine) {
                    const acRaw = await getDepartmentHOD('assetcontroller');
                    const acEmp = acRaw ? await resolveAssetControllerEmployee(acRaw) : null;
                    addEmployeeEmailToSet(ccEmails, acEmp || acRaw);
                }
            } catch (err) {
                console.warn('[FineConfirmedEmail] Could not fetch HOD emails for CC', err.message);
            }
        }

        const buildCcForRecipient = (toMail) => {
            const skip = String(toMail || '').trim().toLowerCase();
            return Array.from(ccEmails).filter((email) => String(email).trim().toLowerCase() !== skip);
        };

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: process.env.SMTP_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const sharedAttachments = [];

        if (fine.attachment && (fine.attachment.url || fine.attachment.data)) {
            try {
                let buffer = null;
                const filename = fine.attachment.name || `Attachment-${fine.fineId || fine._id}`;
                const contentType = fine.attachment.mimeType || 'application/octet-stream';

                if (fine.attachment.url) {
                    const response = await axios.get(fine.attachment.url, { responseType: 'arraybuffer' });
                    buffer = Buffer.from(response.data);
                } else if (fine.attachment.data) {
                    let base64Data = fine.attachment.data;
                    if (base64Data.includes(',')) base64Data = base64Data.split(',')[1];
                    buffer = Buffer.from(base64Data, 'base64');
                }

                if (buffer?.length > 0) {
                    sharedAttachments.push({ filename, content: buffer, contentType });
                }
            } catch (attachErr) {
                console.warn('[FineConfirmedEmail] Could not attach external file:', attachErr.message);
            }
        }

        async function buildFallbackPrintPdf() {
            if (!req) return null;
            try {
                const { generatePdf } = await import('./generatePdf.js');
                if (req.body?.finePdf) {
                    let base64Data = req.body.finePdf;
                    if (base64Data.includes(',')) base64Data = base64Data.split(',')[1];
                    return Buffer.from(base64Data, 'base64');
                }
                const baseUrl = resolveFrontendBaseUrl(req);
                const printUrl = `${baseUrl}/print/fine/${fine._id || fine.fineId}`;
                const token = req.headers.authorization?.split(' ')[1] || '';
                const requestingUserId = req.user?.id || req.user?._id;
                const userPayload = {
                    id: requestingUserId,
                    role: req.user?.role || 'Admin',
                    isAdmin: req.user?.isAdmin || false,
                };
                const permissions = { hrm_fine: { isView: true, isActive: true } };
                return await generatePdf(printUrl, token, userPayload, permissions, '#fine-form-container');
            } catch (pdfErr) {
                console.error('[FineConfirmedEmail] Fallback PDF error:', pdfErr.message);
                return null;
            }
        }

        for (const assigned of assignedEmployees) {
            if (isCompanyFineParty(assigned)) {
                const adminRecipient = await resolveCompanyFineAdminRecipient();
                if (!adminRecipient?.email) {
                    console.warn('[FineConfirmedEmail] No admin email for company fine share, skipping.');
                    continue;
                }

                const companyName =
                    assigned.employeeName ||
                    fine.companyName ||
                    fine.company?.name ||
                    'Company';

                const formSummary = await buildFineFormSummary(fine, {
                    employeeId: 'VEGA-HR-0000',
                    hrHODName,
                    accountsHODName,
                    ceoName,
                });

                const html = buildFineConfirmedEmailHtml({
                    greetingName: adminRecipient.name,
                    fineId: fine.fineId,
                    fallbackNote: '',
                });

                const emailAttachments = [...sharedAttachments];
                let pdfBuffer = null;
                if (isLossDamageFineType(fine)) {
                    pdfBuffer = await generateFineApprovedReportPdfBuffer(fine, {
                        employeeId: 'VEGA-HR-0000',
                    });
                }
                if (!pdfBuffer) {
                    pdfBuffer = await buildFallbackPrintPdf();
                }
                if (pdfBuffer?.length > 500) {
                    emailAttachments.push({
                        filename: `FineReport-Company-${fine.fineId || fine._id}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf',
                    });
                }

                await transporter.sendMail({
                    fromName: req?.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'VERP System',
                    to: adminRecipient.email,
                    cc: buildCcForRecipient(adminRecipient.email),
                    subject: `Company Fine Notification: #${fine.fineId} Approved`,
                    html,
                    attachments: emailAttachments,
                });
                console.log(`[FineConfirmedEmail] Company share sent to admin ${adminRecipient.email}`);
                continue;
            }

            const empDetails = fullEmployees.find((e) => e.employeeId === assigned.employeeId);
            if (!empDetails) continue;

            const { email: toMail, isFallbackToReportee, employeeName, reporteeName } = resolveEmployeeEmail(empDetails);
            if (!toMail) continue;

            const greetingName = isFallbackToReportee ? reporteeName : (assigned.employeeName || empDetails.firstName);
            const fallbackNote = isFallbackToReportee ? getFallbackEmailNote(employeeName, reporteeName) : '';

            const displayEmployeeName =
                `${empDetails.firstName || ''} ${empDetails.lastName || ''}`.trim() ||
                assigned.employeeName ||
                employeeName;

            const formSummary = await buildFineFormSummary(fine, {
                employeeId: assigned.employeeId,
                hrHODName,
                accountsHODName,
                ceoName,
            });

            const hodName =
                formSummary?.employeeStats?.hodName ||
                (empDetails.primaryReportee
                    ? `${empDetails.primaryReportee.firstName || ''} ${empDetails.primaryReportee.lastName || ''}`.trim()
                    : 'Manager');

            const html = buildFineConfirmedEmailHtml({
                greetingName,
                fineId: fine.fineId,
                fallbackNote,
            });

            const emailAttachments = [...sharedAttachments];

            let pdfBuffer = null;
            if (isLossDamageFineType(fine)) {
                pdfBuffer = await generateFineApprovedReportPdfBuffer(fine, {
                    employeeId: assigned.employeeId,
                });
            }
            if (!pdfBuffer) {
                pdfBuffer = await buildFallbackPrintPdf();
            }
            if (pdfBuffer?.length > 500) {
                emailAttachments.push({
                    filename: `AssetLossFineReport-${fine.fineId || fine._id}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                });
            }

            await transporter.sendMail({
                fromName: req?.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'VERP System',
                to: toMail,
                cc: buildCcForRecipient(toMail),
                subject: `Fine Notification: #${fine.fineId} Approved`,
                html,
                attachments: emailAttachments,
            });
            console.log(`[FineConfirmedEmail] Sent to ${toMail}`);
        }

        console.log('[FineConfirmedEmail] All individual emails sent successfully.');
    } catch (error) {
        console.error('[FineConfirmedEmail] Error sending email:', error);
    }
};

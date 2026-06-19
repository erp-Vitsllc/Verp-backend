import nodemailer from 'nodemailer';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetItem from '../models/AssetItem.js';
import { buildFineFormSummary } from './buildFineFormSummary.js';
import { generateAssetLossFineReportPdf } from './generateAssetLossFineReportPdf.js';
import { loadFineRecordForAssetLossPdf } from './loadFineRecordForAssetLossPdf.js';
import { buildAssetLossFineReportEmailHtml } from './buildAssetLossFineReportEmailHtml.js';
import {
    resolveEmployeeEmail,
    addEmployeeEmailToSet,
    getFallbackEmailNote,
    employeeDisplayName,
} from './resolveEmployeeEmail.js';
import { isCompanyFineParty } from './fineGroupClassification.js';
import { resolveCompanyFineAdminRecipient } from './resolveCompanyFineAdminRecipient.js';

/**
 * Loss & Damage asset fines that should use the Asset Loss Fine Report PDF + stakeholder emails.
 */
export function isAssetLossFineReportApplicable(fine) {
    if (!fine) return false;
    const ft = String(fine.fineType || '').toLowerCase();
    const hasAsset = !!(fine.assetId && String(fine.assetId).trim()) || !!fine.assetObjectId;
    if (!hasAsset) return false;
    return (
        fine.category === 'Loss' ||
        fine.category === 'Damage' ||
        ft.includes('loss & damage') ||
        ft.includes('loss and damage') ||
        (ft.includes('loss') && ft.includes('damage'))
    );
}

async function loadStakeholders(fine, employeeIds) {
    const { getDepartmentHOD } = await import('./getDepartmentHOD.js');
    const { getManagementHOD } = await import('./getManagementHOD.js');
    const { resolveAssetControllerEmployee } = await import('./assetApprovalHelpers.js');

    const hrHOD = await getDepartmentHOD('hr');
    const accountsHOD = await getDepartmentHOD('finance');
    const managementHOD = employeeIds.length > 0 ? await getManagementHOD(employeeIds[0]) : null;
    const acRaw = await getDepartmentHOD('assetcontroller');
    const assetController = acRaw ? await resolveAssetControllerEmployee(acRaw) : null;

    return {
        hrHOD,
        accountsHOD,
        managementHOD,
        assetController,
        hrHODName: hrHOD ? employeeDisplayName(hrHOD) : '',
        accountsHODName: accountsHOD ? employeeDisplayName(accountsHOD) : '',
        ceoName: managementHOD ? employeeDisplayName(managementHOD) : '',
    };
}

async function resolveAssetOwnerEmployee(fine, assignedEmployees) {
    if (fine.assetObjectId) {
        const asset = await AssetItem.findById(fine.assetObjectId)
            .select('assignedTo')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId companyEmail workEmail primaryReportee',
                populate: { path: 'primaryReportee', select: 'firstName lastName companyEmail workEmail' },
            })
            .lean();
        if (asset?.assignedTo) return asset.assignedTo;
    }

    if (fine.assetId) {
        const asset = await AssetItem.findOne({ assetId: fine.assetId })
            .select('assignedTo')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId companyEmail workEmail primaryReportee',
                populate: { path: 'primaryReportee', select: 'firstName lastName companyEmail workEmail' },
            })
            .lean();
        if (asset?.assignedTo) return asset.assignedTo;
    }

    const firstAssignedId = assignedEmployees?.find(
        (e) => e.employeeId && !['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(e.employeeId),
    )?.employeeId;
    if (!firstAssignedId) return null;

    return EmployeeBasic.findOne({ employeeId: firstAssignedId })
        .select('firstName lastName employeeId companyEmail workEmail primaryReportee')
        .populate('primaryReportee', 'firstName lastName companyEmail workEmail')
        .lean();
}

function buildCcEmails(stakeholders, assetOwner, skipEmail) {
    const cc = new Set();
    const skip = String(skipEmail || '').toLowerCase();

    const add = (emp) => {
        const { email } = resolveEmployeeEmail(emp);
        if (email && email.toLowerCase() !== skip) cc.add(email);
    };

    add(stakeholders.hrHOD);
    add(stakeholders.accountsHOD);
    add(stakeholders.managementHOD);
    add(stakeholders.assetController);
    add(assetOwner);

    return Array.from(cc);
}

/**
 * Sends Asset Loss Fine Report PDF when management fully approves a Loss & Damage asset fine.
 * Recipients: fined employee (or primary reportee), Asset Controller, asset owner, Management, HR, Accounts.
 */
export async function sendAssetLossFineReportEmail(fine, assignedEmployees, req = null) {
    if (!isAssetLossFineReportApplicable(fine)) return;

    try {
        console.log(`[AssetLossFineReportEmail] Preparing for Fine #${fine.fineId}`);

        const employeeIds = (assignedEmployees || [])
            .map((e) => e.employeeId)
            .filter((id) => id && !['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(id));

        const fullEmployees = await EmployeeBasic.find({ employeeId: { $in: employeeIds } })
            .select('employeeId firstName lastName companyEmail workEmail primaryReportee')
            .populate('primaryReportee', 'companyEmail workEmail firstName lastName employeeId');

        const stakeholders = await loadStakeholders(fine, employeeIds);
        const assetOwner = await resolveAssetOwnerEmployee(fine, assignedEmployees);

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.office365.com',
            port: process.env.SMTP_PORT || 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const fromName = req?.user
            ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'VeRP System'
            : 'VeRP System';

        for (const assigned of assignedEmployees || []) {
            if (!assigned.employeeId || ['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(assigned.employeeId)) {
                continue;
            }

            const empDetails = fullEmployees.find((e) => e.employeeId === assigned.employeeId);
            if (!empDetails) continue;

            const { email: toMail, isFallbackToReportee, employeeName, reporteeName } =
                resolveEmployeeEmail(empDetails);
            if (!toMail) {
                console.warn(`[AssetLossFineReportEmail] No email for ${assigned.employeeId}, skipping.`);
                continue;
            }

            const displayEmployeeName =
                `${empDetails.firstName || ''} ${empDetails.lastName || ''}`.trim() ||
                assigned.employeeName ||
                employeeName;

            const fineForPdf = await loadFineRecordForAssetLossPdf(fine, assigned.employeeId);

            const formSummary = await buildFineFormSummary(fineForPdf, {
                employeeId: assigned.employeeId,
                hrHODName: stakeholders.hrHODName,
                accountsHODName: stakeholders.accountsHODName,
                ceoName: stakeholders.ceoName,
            });

            const hodName =
                formSummary?.employeeStats?.hodName ||
                (empDetails.primaryReportee
                    ? `${empDetails.primaryReportee.firstName || ''} ${empDetails.primaryReportee.lastName || ''}`.trim()
                    : 'Manager');

            const pdfBuffer = await generateAssetLossFineReportPdf({
                fine: fineForPdf,
                assigned,
                formSummary,
                employeeName: displayEmployeeName,
                hodName,
                hrEmployee: stakeholders.hrHOD,
                accountsEmployee: stakeholders.accountsHOD,
            });

            if (!pdfBuffer) {
                console.error(`[AssetLossFineReportEmail] PDF generation failed for ${assigned.employeeId}`);
                continue;
            }

            const greetingName = isFallbackToReportee ? reporteeName : displayEmployeeName;
            const fallbackNote = isFallbackToReportee
                ? getFallbackEmailNote(employeeName, reporteeName)
                : '';

            const html = buildAssetLossFineReportEmailHtml({
                greetingName,
                fineId: fineForPdf.fineId,
                employeeName: displayEmployeeName,
                fallbackNote,
            });

            const ccRecipients = buildCcEmails(stakeholders, assetOwner, toMail);

            await transporter.sendMail({
                fromName,
                to: toMail,
                cc: ccRecipients,
                subject: `Asset Loss Fine Report — #${fineForPdf.fineId} Approved`,
                html,
                attachments: [
                    {
                        filename: `AssetLossFineReport-${fineForPdf.fineId}-${assigned.employeeId}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf',
                    },
                ],
            });

            console.log(`[AssetLossFineReportEmail] Sent to ${toMail} (cc: ${ccRecipients.join(', ') || 'none'})`);
        }

        for (const assigned of assignedEmployees || []) {
            if (!isCompanyFineParty(assigned)) continue;

            const adminRecipient = await resolveCompanyFineAdminRecipient();
            if (!adminRecipient?.email) {
                console.warn('[AssetLossFineReportEmail] No admin email for company fine share, skipping.');
                continue;
            }

            const companyName =
                assigned.employeeName ||
                fine.companyName ||
                fine.company?.name ||
                'Company';

            const fineForPdf = await loadFineRecordForAssetLossPdf(fine, 'VEGA-HR-0000');
            const formSummary = await buildFineFormSummary(fineForPdf, {
                employeeId: 'VEGA-HR-0000',
                hrHODName: stakeholders.hrHODName,
                accountsHODName: stakeholders.accountsHODName,
                ceoName: stakeholders.ceoName,
            });

            const pdfBuffer = await generateAssetLossFineReportPdf({
                fine: fineForPdf,
                assigned: {
                    ...assigned,
                    employeeId: 'VEGA-HR-0000',
                    employeeName: companyName,
                },
                formSummary,
                employeeName: companyName,
                hodName: stakeholders.hrHODName || 'HR',
                hrEmployee: stakeholders.hrHOD,
                accountsEmployee: stakeholders.accountsHOD,
            });

            if (!pdfBuffer) {
                console.error('[AssetLossFineReportEmail] Company PDF generation failed');
                continue;
            }

            const ccRecipients = buildCcEmails(stakeholders, assetOwner, adminRecipient.email);

            await transporter.sendMail({
                fromName,
                to: adminRecipient.email,
                cc: ccRecipients,
                subject: `Company Asset Loss Fine Report — #${fineForPdf.fineId} Approved`,
                html: buildAssetLossFineReportEmailHtml({
                    greetingName: adminRecipient.name,
                    fineId: fineForPdf.fineId,
                    employeeName: companyName,
                    fallbackNote: '',
                }),
                attachments: [
                    {
                        filename: `AssetLossFineReport-Company-${fineForPdf.fineId}.pdf`,
                        content: pdfBuffer,
                        contentType: 'application/pdf',
                    },
                ],
            });
            console.log(`[AssetLossFineReportEmail] Company share sent to admin ${adminRecipient.email}`);
        }

        const ownerResolved = resolveEmployeeEmail(assetOwner);
        const finedEmails = new Set();
        for (const assigned of assignedEmployees || []) {
            const emp = fullEmployees.find((e) => e.employeeId === assigned.employeeId);
            const { email } = resolveEmployeeEmail(emp);
            if (email) finedEmails.add(email.toLowerCase());
        }

        if (
            ownerResolved.email &&
            !finedEmails.has(ownerResolved.email.toLowerCase()) &&
            assetOwner
        ) {
            const firstAssigned = assignedEmployees?.find(
                (e) => e.employeeId && !['VEGA-HR-0000', 'VEGA_INTERNAL'].includes(e.employeeId),
            );
            if (firstAssigned) {
                const ownerFineForPdf = await loadFineRecordForAssetLossPdf(fine, firstAssigned.employeeId);
                const formSummary = await buildFineFormSummary(ownerFineForPdf, {
                    employeeId: firstAssigned.employeeId,
                    hrHODName: stakeholders.hrHODName,
                    accountsHODName: stakeholders.accountsHODName,
                    ceoName: stakeholders.ceoName,
                });
                const empDetails = fullEmployees.find((e) => e.employeeId === firstAssigned.employeeId);
                const displayEmployeeName = employeeDisplayName(empDetails || firstAssigned);
                const hodName = formSummary?.employeeStats?.hodName || 'Manager';

                const pdfBuffer = await generateAssetLossFineReportPdf({
                    fine: ownerFineForPdf,
                    assigned: firstAssigned,
                    formSummary,
                    employeeName: displayEmployeeName,
                    hodName,
                    hrEmployee: stakeholders.hrHOD,
                    accountsEmployee: stakeholders.accountsHOD,
                });

                if (pdfBuffer) {
                    const greetingName = ownerResolved.isFallbackToReportee
                        ? employeeDisplayName(assetOwner.primaryReportee)
                        : employeeDisplayName(assetOwner);
                    const fallbackNote = ownerResolved.isFallbackToReportee
                        ? getFallbackEmailNote(employeeDisplayName(assetOwner), greetingName)
                        : '';

                    const stakeholderCc = new Set();
                    addEmployeeEmailToSet(stakeholderCc, stakeholders.hrHOD);
                    addEmployeeEmailToSet(stakeholderCc, stakeholders.accountsHOD);
                    addEmployeeEmailToSet(stakeholderCc, stakeholders.managementHOD);
                    addEmployeeEmailToSet(stakeholderCc, stakeholders.assetController);
                    stakeholderCc.delete(ownerResolved.email);

                    await transporter.sendMail({
                        fromName,
                        to: ownerResolved.email,
                        cc: Array.from(stakeholderCc),
                        subject: `Asset Loss Fine Report — #${ownerFineForPdf.fineId} Approved`,
                        html: buildAssetLossFineReportEmailHtml({
                            greetingName,
                            fineId: ownerFineForPdf.fineId,
                            employeeName: displayEmployeeName,
                            fallbackNote,
                        }),
                        attachments: [
                            {
                                filename: `AssetLossFineReport-${ownerFineForPdf.fineId}.pdf`,
                                content: pdfBuffer,
                                contentType: 'application/pdf',
                            },
                        ],
                    });
                    console.log(`[AssetLossFineReportEmail] Asset owner copy sent to ${ownerResolved.email}`);
                }
            }
        }
    } catch (error) {
        console.error('[AssetLossFineReportEmail] Error:', error?.message || error);
    }
}

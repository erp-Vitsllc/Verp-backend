import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    resolveEmployeeEmail,
    resolveEmployeeEmailWithReporteeLoaded,
    pickEffectiveEmail,
    employeeDisplayName,
} from './resolveEmployeeEmail.js';
import { employeeHasActivePortalUser } from './vehicleHandoverApprovalFlow.js';
import {
    buildVehicleServiceScheduledEmailHtml,
    vehicleServiceScheduledSubject,
} from './buildVehicleServiceScheduledEmailHtml.js';
import { withFrontendPath, resolveFrontendBaseUrl } from './resolveFrontendBaseUrl.js';
import { vehicleServiceDetailsPath } from './vehicleServiceAdminOfficerNotification.js';
import { buildEmailDedupeKey, sendErpEmail } from './emailDispatch.js';

const EMP_SELECT =
    'firstName lastName employeeId companyEmail workEmail personalEmail email company mobileNumber phoneNumber contactNumber phone mobile primaryReportee enablePortalAccess';
const REPORTEE_SELECT =
    'firstName lastName employeeId companyEmail workEmail status profileStatus enablePortalAccess';

function pickEmpEmail(emp) {
    if (!emp) return null;
    return resolveEmployeeEmail(emp).email || null;
}

function formatKm(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return `${n.toLocaleString()} KM`;
}

function formatMoney(value) {
    if (value == null || value === '') return '';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return `AED ${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatPaymentMethod(remark = {}) {
    const mode = String(remark.amountMode || '').toLowerCase().trim();
    if (mode === 'warranty') return 'Warranty';
    const method = String(remark.paymentMethod || '').toLowerCase().trim();
    if (method === 'acc_pay' || method === 'accpay' || method === 'account_pay') return 'Acc Pay';
    if (method === 'bank_transfer' || method === 'banktransfer' || method === 'bank transfer') {
        return 'Bank Transfer';
    }
    if (method === 'cash' || method === 'amount' || mode === 'amount' || mode === 'cash') return 'Cash';
    if (method) return String(remark.paymentMethod).trim();
    if (mode) return mode;
    return '';
}

function reporteeLooksPopulated(reportee) {
    if (reportee == null) return true;
    if (typeof reportee !== 'object') return false;
    return Boolean(
        reportee.firstName ||
            reportee.lastName ||
            reportee.employeeId ||
            reportee.companyEmail ||
            reportee.workEmail,
    );
}

async function loadAssigneeWithReportee(raw) {
    if (!raw) return null;
    const alreadyLoaded =
        typeof raw === 'object' &&
        raw.employeeId &&
        raw.primaryReportee !== undefined &&
        reporteeLooksPopulated(raw.primaryReportee);
    if (alreadyLoaded) return raw;
    const id = raw._id || raw;
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
        return typeof raw === 'object' ? raw : null;
    }
    return EmployeeBasic.findById(id)
        .select(EMP_SELECT)
        .populate('company', 'name')
        .populate('primaryReportee', REPORTEE_SELECT)
        .lean();
}

function noUserAccountFallbackNote(employeeName, reporteeName) {
    return `
    <div style="background-color: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 6px; margin-bottom: 20px; font-size: 13px;">
        <strong>Note:</strong> This notification was sent to you (${reporteeName}) because <strong>${employeeName}</strong> does not have a user account. Please ensure they are informed.
    </div>`;
}

async function resolveScheduledToRecipient(asset, assignee) {
    if (asset?.assignedToType === 'Company' && asset?.assignedCompany) {
        const companyId = asset.assignedCompany._id || asset.assignedCompany;
        const company =
            typeof asset.assignedCompany === 'object' && asset.assignedCompany.email !== undefined
                ? asset.assignedCompany
                : await Company.findById(companyId).select('name nickName email').lean();
        const email = String(company?.email || '').trim() || null;
        return {
            email,
            greetingName: String(company?.name || company?.nickName || 'Company').trim() || 'Employee',
            fallbackNoteHtml: '',
        };
    }

    if (!assignee) {
        return { email: null, greetingName: 'Employee', fallbackNoteHtml: '' };
    }

    const hasUser = await employeeHasActivePortalUser(assignee);
    const { email, employee } = await resolveEmployeeEmailWithReporteeLoaded(assignee);
    const full = employee || assignee;

    if (hasUser) {
        return {
            email,
            greetingName: employeeDisplayName(full) || 'Employee',
            fallbackNoteHtml: '',
        };
    }

    const reportee = full?.primaryReportee;
    return {
        email: pickEffectiveEmail(reportee),
        greetingName: employeeDisplayName(reportee) || 'Employee',
        fallbackNoteHtml: reportee
            ? noUserAccountFallbackNote(employeeDisplayName(full), employeeDisplayName(reportee))
            : '',
    };
}

function dayLabel(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    return String(value).trim().slice(0, 10);
}

function plateOf(asset) {
    return [asset?.plateEmirate, asset?.plateNumber].filter(Boolean).join(' ').trim();
}

function assignedUserOf(asset, assignee) {
    if (asset?.assignedToType === 'Company' && asset?.assignedCompany) {
        const company = asset.assignedCompany;
        if (company && typeof company === 'object') {
            return String(company.name || company.nickName || 'Company').trim();
        }
        return 'Company';
    }
    return employeeDisplayName(assignee) || 'Unassigned';
}

function serviceDetailsUrl(asset, service, serviceType) {
    const assetId = asset?._id;
    const serviceId = service?._id || service?.id;
    const path = vehicleServiceDetailsPath(assetId, serviceId, serviceType);
    if (path) return withFrontendPath(path);
    if (assetId) return withFrontendPath(`/HRM/Asset/Vehicle/details/${assetId}?tab=service`);
    return resolveFrontendBaseUrl();
}

/**
 * Formal scheduled-service email — after Admin completes Schedule / Reschedule.
 * TO only: vehicle assigned user (primary reportee if assignee has no user account).
 * No CC.
 * One send per service window (deduped).
 */
export async function sendVehicleServiceScheduledNotificationEmail({
    asset,
    remark = {},
    service = null,
    serviceTypeLabel = '',
    toOverride = null,
} = {}) {
    try {
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.warn('[VehicleServiceScheduled] EMAIL_USER/EMAIL_PASS missing — skip.');
            return { ok: false, reason: 'no-credentials' };
        }

        const assignee = await loadAssigneeWithReportee(asset?.assignedTo || null);
        const adminOfficer = await getDepartmentHOD('admincontroller');
        const adminEmail = pickEmpEmail(adminOfficer);
        const toRecipient = await resolveScheduledToRecipient(asset, assignee);

        const serviceType =
            String(serviceTypeLabel || service?.serviceType || remark.serviceType || 'service').trim() ||
            'service';

        const start =
            dayLabel(remark.serviceStartDate) ||
            dayLabel(remark.scheduledServiceDate) ||
            dayLabel(asset?.activeServiceWorkflow?.scheduledServiceDate);
        const end =
            dayLabel(remark.serviceEndDate) ||
            dayLabel(remark.serviceWindowEndDate) ||
            dayLabel(asset?.activeServiceWorkflow?.serviceWindowEndDate);

        const amountRaw =
            service?.value != null && service.value !== ''
                ? service.value
                : remark.amount ?? remark.quotationAmount ?? remark.estimatedAmount ?? '';

        const html = buildVehicleServiceScheduledEmailHtml({
            employeeName: toRecipient.greetingName || 'Employee',
            serviceType,
            garageName: remark.garageName || remark.vendorName || '',
            garageLocation: remark.garageLocation || '',
            garageContact: remark.garageContact || '',
            serviceStartDate: start,
            serviceEndDate: end,
            paymentMethod: formatPaymentMethod(remark),
            amountToPay:
                String(remark.amountMode || '').toLowerCase() === 'warranty'
                    ? 'Warranty (N/A)'
                    : formatMoney(amountRaw) || 'AED 0',
            vehicleNumber: plateOf(asset),
            vehicleModelYear: asset?.modelYear || '',
            vehicleAssetNumber: asset?.assetId || '',
            assignedUser: assignedUserOf(asset, assignee),
            currentKm: formatKm(asset?.currentKilometer),
            adminOfficerName: employeeDisplayName(adminOfficer),
            adminOfficerEmail: adminEmail || '',
            detailsUrl: serviceDetailsUrl(asset, service, serviceType),
            portalUrl: resolveFrontendBaseUrl(),
            fallbackNoteHtml: toRecipient.fallbackNoteHtml || '',
        });

        const primaryTo = String(toOverride || toRecipient.email || '').trim();
        if (!primaryTo) {
            console.warn('[VehicleServiceScheduled] No assigned user / primary reportee email — skip.');
            return { ok: false, reason: 'no-recipients' };
        }

        const serviceId = String(service?._id || service?.id || asset?.activeServiceWorkflow?.serviceRecordId || '');
        const assetId = String(asset?._id || asset?.id || '');
        const dedupeKey = buildEmailDedupeKey([
            'VehicleServiceScheduled',
            assetId,
            serviceId,
            start,
            end,
            serviceType,
        ]);

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const result = await sendErpEmail({
            transporter,
            from: `"VeRP Portal" <${emailUser}>`,
            to: primaryTo,
            subject: vehicleServiceScheduledSubject(serviceType),
            html,
            dedupeKey,
            module: 'VehicleService',
            emailType: 'scheduled',
            recordId: serviceId || assetId,
            metadata: { subjectCategory: 'information' },
        });

        if (!result.sent) {
            if (result.reason === 'duplicate') {
                console.log('[VehicleServiceScheduled] Duplicate scheduled notification suppressed.');
            }
            return { ok: false, reason: result.reason || 'not-sent' };
        }

        console.log(`[VehicleServiceScheduled] Sent TO: ${primaryTo} (${serviceType})`);
        return { ok: true, to: primaryTo };
    } catch (err) {
        console.error('[VehicleServiceScheduled] Email error:', err.message);
        return { ok: false, reason: err.message };
    }
}

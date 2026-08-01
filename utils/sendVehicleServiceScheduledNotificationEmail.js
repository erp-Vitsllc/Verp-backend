import nodemailer from 'nodemailer';
import mongoose from 'mongoose';
import EmployeeBasic from '../models/EmployeeBasic.js';
import Company from '../models/Company.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import {
    resolveEmployeeEmail,
    resolveEmployeeEmailWithReporteeLoaded,
    employeeDisplayName,
    getFallbackEmailNote,
} from './resolveEmployeeEmail.js';
import {
    buildVehicleServiceScheduledEmailHtml,
    VEHICLE_SERVICE_SCHEDULED_SUBJECT,
} from './buildVehicleServiceScheduledEmailHtml.js';

const EMP_SELECT =
    'firstName lastName employeeId companyEmail workEmail personalEmail email company mobileNumber phoneNumber contactNumber phone mobile';

function pickEmpEmail(emp) {
    if (!emp) return null;
    const { email } = resolveEmployeeEmail(emp);
    if (email) return email;
    return String(emp.companyEmail || emp.workEmail || emp.email || '').trim() || null;
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

function pickContactNumber(emp) {
    if (!emp) return '';
    return (
        String(
            emp.mobileNumber ||
                emp.phoneNumber ||
                emp.contactNumber ||
                emp.mobile ||
                emp.phone ||
                '',
        ).trim() || ''
    );
}

async function resolveEmployeeByIdOrCode(raw) {
    const id = String(raw || '').trim();
    if (!id) return null;
    if (mongoose.Types.ObjectId.isValid(id)) {
        return EmployeeBasic.findById(id).select(EMP_SELECT).populate('company', 'name').lean();
    }
    return EmployeeBasic.findOne({ employeeId: id }).select(EMP_SELECT).populate('company', 'name').lean();
}

async function resolveCompanyName(assignee, remark = {}) {
    const fromRemark = String(remark.carDrivenByCompanyName || remark.companyName || '').trim();
    if (fromRemark) return fromRemark;
    if (assignee?.company?.name) return String(assignee.company.name).trim();
    if (assignee?.company && mongoose.Types.ObjectId.isValid(String(assignee.company))) {
        const company = await Company.findById(assignee.company).select('name').lean();
        if (company?.name) return String(company.name).trim();
    }
    return process.env.DEFAULT_COMPANY_NAME?.trim() || 'VITS LLC';
}

function dayLabel(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    return String(value).trim().slice(0, 10);
}

/**
 * After Admin schedules + Accounts confirms — formal scheduled-service email.
 * TO: vehicle assigned user
 * CC: assigned user (if distinct), Admin Officer, car driven by
 */
export async function sendVehicleServiceScheduledNotificationEmail({
    asset,
    remark = {},
    service = null,
    serviceTypeLabel = '',
    toOverride = null,
    ccExtra = [],
} = {}) {
    try {
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.warn('[VehicleServiceScheduled] EMAIL_USER/EMAIL_PASS missing — skip.');
            return { ok: false, reason: 'no-credentials' };
        }

        let assignee = asset?.assignedTo || null;
        if (assignee && (!assignee.firstName || !pickEmpEmail(assignee) || !assignee.company)) {
            const id = assignee._id || assignee;
            if (id && mongoose.Types.ObjectId.isValid(String(id))) {
                assignee = await EmployeeBasic.findById(id)
                    .select(EMP_SELECT)
                    .populate('company', 'name')
                    .lean();
            }
        } else if (assignee && !assignee.company?.name && assignee.company) {
            assignee = await EmployeeBasic.findById(assignee._id || assignee)
                .select(EMP_SELECT)
                .populate('company', 'name')
                .lean();
        }

        const [adminOfficer, driver] = await Promise.all([
            getDepartmentHOD('admincontroller'),
            resolveEmployeeByIdOrCode(remark.carDrivenByEmployeeId),
        ]);

        const {
            email: resolvedTo,
            isFallbackToReportee,
            employee: fullAssignee,
        } = await resolveEmployeeEmailWithReporteeLoaded(assignee);

        const to = String(toOverride || resolvedTo || '').trim();
        if (!to) {
            console.warn('[VehicleServiceScheduled] No assigned-user email — skip.');
            return { ok: false, reason: 'no-assignee-email' };
        }

        const greetingName =
            isFallbackToReportee && fullAssignee?.primaryReportee
                ? fullAssignee.primaryReportee.firstName ||
                  employeeDisplayName(fullAssignee.primaryReportee)
                : employeeDisplayName(assignee);

        const fallbackNote =
            isFallbackToReportee && fullAssignee?.primaryReportee
                ? getFallbackEmailNote(
                      employeeDisplayName(fullAssignee),
                      employeeDisplayName(fullAssignee.primaryReportee),
                  )
                : '';

        const companyName = await resolveCompanyName(assignee || fullAssignee, remark);
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
            employeeName: greetingName,
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
                    : formatMoney(amountRaw),
            currentKm: formatKm(asset?.currentKilometer),
            adminOfficerName: employeeDisplayName(adminOfficer),
            adminOfficerContact: pickContactNumber(adminOfficer),
            adminOfficerEmail: pickEmpEmail(adminOfficer) || '',
            companyName,
            fallbackNoteHtml: fallbackNote,
        });

        const ccSet = new Set();
        for (const emp of [assignee, adminOfficer, driver]) {
            const addr = pickEmpEmail(emp);
            if (addr) ccSet.add(addr.toLowerCase());
        }
        for (const extra of ccExtra || []) {
            const addr = String(extra || '').trim();
            if (addr) ccSet.add(addr.toLowerCase());
        }
        ccSet.delete(to.toLowerCase());
        const cc = [...ccSet];

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        await transporter.sendMail({
            from: `"VeRP Portal" <${emailUser}>`,
            to,
            ...(cc.length ? { cc } : {}),
            subject: VEHICLE_SERVICE_SCHEDULED_SUBJECT,
            html,
        });

        console.log(
            `[VehicleServiceScheduled] Sent TO: ${to}${cc.length ? ` CC: ${cc.join(', ')}` : ''} (${serviceType})`,
        );
        return { ok: true, to, cc };
    } catch (err) {
        console.error('[VehicleServiceScheduled] Email error:', err.message);
        return { ok: false, reason: err.message };
    }
}

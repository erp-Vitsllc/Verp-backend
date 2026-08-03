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
    buildVehicleServiceCompletedEmailHtml,
    VEHICLE_SERVICE_COMPLETED_SUBJECT,
} from './buildVehicleServiceCompletedEmailHtml.js';

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
    if (value == null || value === '') return 'AED 0';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return `AED ${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
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

function dayLabel(value) {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }
    return String(value).trim().slice(0, 10);
}

function firstFinite(...candidates) {
    for (const raw of candidates) {
        if (raw == null || raw === '') continue;
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** Resolve company vs employee paid amounts from service remark / value. */
function resolvePaidAmounts(remark = {}, service = null) {
    const mode = String(remark.amountMode || '').toLowerCase().trim();
    if (mode === 'warranty') {
        return { companyPaid: 'Warranty', employeePaid: 'AED 0' };
    }

    const company = firstFinite(
        remark.hrReviewCompanyPay,
        remark.companyPay,
        remark.companyPaidAmount,
        remark.companyAmount,
    );
    const employee = firstFinite(
        remark.hrReviewEmployeePay,
        remark.employeePay,
        remark.employeeLiabilityTotal,
        remark.employeePaidAmount,
        remark.employeeAmount,
    );

    if (company != null || employee != null) {
        return {
            companyPaid: formatMoney(company ?? 0),
            employeePaid: formatMoney(employee ?? 0),
        };
    }

    const total = firstFinite(
        remark.totalServiceCharge,
        service?.value,
        remark.garageBillAmount,
        remark.amount,
    );
    return {
        companyPaid: formatMoney(total ?? 0),
        employeePaid: formatMoney(0),
    };
}

async function resolveEmployeeByIdOrCode(raw) {
    const id = String(raw || '').trim();
    if (!id) return null;
    if (mongoose.Types.ObjectId.isValid(id)) {
        return EmployeeBasic.findById(id).select(EMP_SELECT).populate('company', 'name').lean();
    }
    return EmployeeBasic.findOne({ employeeId: id }).select(EMP_SELECT).populate('company', 'name').lean();
}

async function loadEmployeeFull(emp) {
    if (!emp) return null;
    if (emp.firstName && pickEmpEmail(emp) && (emp.company?.name || !emp.company)) {
        if (emp.company?.name || !emp.company) return emp;
    }
    const id = emp._id || emp;
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return emp;
    return EmployeeBasic.findById(id).select(EMP_SELECT).populate('company', 'name').lean();
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

/**
 * After Complete / End Service — formal completion & return email.
 * TO: assigned user (+ car driven by, each personalized)
 * CC: Admin Officer, HR, Accounts
 */
export async function sendVehicleServiceCompletedNotificationEmail({
    asset,
    remark = {},
    service = null,
    toOverride = null,
    ccExtra = [],
} = {}) {
    try {
        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();
        if (!emailUser || !emailPass) {
            console.warn('[VehicleServiceCompleted] EMAIL_USER/EMAIL_PASS missing — skip.');
            return { ok: false, reason: 'no-credentials' };
        }

        let assignee = await loadEmployeeFull(asset?.assignedTo || null);
        const [adminOfficer, hr, accounts, driver] = await Promise.all([
            getDepartmentHOD('admincontroller'),
            getDepartmentHOD('hr'),
            getDepartmentHOD('accounts'),
            resolveEmployeeByIdOrCode(remark.carDrivenByEmployeeId),
        ]);

        const companyName = await resolveCompanyName(assignee, remark);
        const paid = resolvePaidAmounts(remark, service);

        const completedDate =
            dayLabel(remark.vehicleServiceCompletedAt) ||
            dayLabel(remark.oilServiceEndedAt) ||
            dayLabel(remark.serviceCompletedAt) ||
            dayLabel(new Date());
        const returnedDate =
            dayLabel(remark.returnDate) ||
            dayLabel(remark.serviceReturnDate) ||
            dayLabel(remark.accidentReturnDate) ||
            dayLabel(remark.handOverDate) ||
            completedDate;

        const currentKm = formatKm(
            firstFinite(
                remark.currentKm,
                service?.currentKm,
                service?.kilometer,
                service?.odometer,
                asset?.currentKilometer,
            ),
        );

        const adminCc = pickEmpEmail(adminOfficer);
        const stakeholderCc = [];
        for (const emp of [adminOfficer, hr, accounts, driver]) {
            const addr = pickEmpEmail(emp);
            if (addr) stakeholderCc.push(addr.toLowerCase());
        }
        for (const extra of ccExtra || []) {
            const addr = String(extra || '').trim();
            if (addr) stakeholderCc.push(addr.toLowerCase());
        }
        const uniqueStakeholderCc = [...new Set(stakeholderCc)];

        const transporter = nodemailer.createTransport({
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: { user: emailUser, pass: emailPass },
        });

        const primaryRecipients = [];
        const seenIds = new Set();
        for (const emp of [assignee, driver]) {
            if (!emp) continue;
            const id = emp._id ? String(emp._id) : '';
            if (id && seenIds.has(id)) continue;
            if (id) seenIds.add(id);
            primaryRecipients.push(emp);
        }

        const buildCcForTo = (toAddr) => {
            const ccSet = new Set(uniqueStakeholderCc);
            ccSet.delete(String(toAddr || '').toLowerCase());
            return [...ccSet];
        };

        if (toOverride) {
            // Preview / force path: single TO override, still CC stakeholders.
            const html = buildVehicleServiceCompletedEmailHtml({
                employeeName: employeeDisplayName(assignee) || 'Employee',
                serviceCompletedDate: completedDate,
                vehicleReturnedDate: returnedDate,
                currentKm,
                companyPaidAmount: paid.companyPaid,
                employeePaidAmount: paid.employeePaid,
                adminOfficerName: employeeDisplayName(adminOfficer),
                adminOfficerContact: pickContactNumber(adminOfficer),
                adminOfficerEmail: adminCc || '',
                companyName,
            });
            const cc = buildCcForTo(toOverride);
            await transporter.sendMail({
                from: `"VeRP Portal" <${emailUser}>`,
                to: toOverride,
                ...(cc.length ? { cc } : {}),
                subject: VEHICLE_SERVICE_COMPLETED_SUBJECT,
                html,
            });
            console.log(
                `[VehicleServiceCompleted] Sent TO: ${toOverride}${cc.length ? ` CC: ${cc.join(', ')}` : ''}`,
            );
            return { ok: true, to: [toOverride], cc };
        }

        if (!primaryRecipients.length) {
            console.warn('[VehicleServiceCompleted] No assigned user / driver — skip.');
            return { ok: false, reason: 'no-recipients' };
        }

        const sentTo = [];
        let lastCc = [];
        for (const recipient of primaryRecipients) {
            const {
                email: resolvedTo,
                isFallbackToReportee,
                employee: full,
            } = await resolveEmployeeEmailWithReporteeLoaded(recipient);
            const to = String(resolvedTo || '').trim();
            if (!to) {
                console.warn(
                    `[VehicleServiceCompleted] No email for ${employeeDisplayName(recipient)} — skip.`,
                );
                continue;
            }

            const greetingName =
                isFallbackToReportee && full?.primaryReportee
                    ? full.primaryReportee.firstName || employeeDisplayName(full.primaryReportee)
                    : employeeDisplayName(recipient);

            const fallbackNote =
                isFallbackToReportee && full?.primaryReportee
                    ? getFallbackEmailNote(
                          employeeDisplayName(full),
                          employeeDisplayName(full.primaryReportee),
                      )
                    : '';

            const html = buildVehicleServiceCompletedEmailHtml({
                employeeName: greetingName,
                serviceCompletedDate: completedDate,
                vehicleReturnedDate: returnedDate,
                currentKm,
                companyPaidAmount: paid.companyPaid,
                employeePaidAmount: paid.employeePaid,
                adminOfficerName: employeeDisplayName(adminOfficer),
                adminOfficerContact: pickContactNumber(adminOfficer),
                adminOfficerEmail: adminCc || '',
                companyName,
                fallbackNoteHtml: fallbackNote,
            });

            const cc = buildCcForTo(to);
            lastCc = cc;

            await transporter.sendMail({
                from: `"VeRP Portal" <${emailUser}>`,
                to,
                ...(cc.length ? { cc } : {}),
                subject: VEHICLE_SERVICE_COMPLETED_SUBJECT,
                html,
            });
            sentTo.push(to);
            console.log(
                `[VehicleServiceCompleted] Sent TO: ${to}${cc.length ? ` CC: ${cc.join(', ')}` : ''}`,
            );
        }

        return { ok: sentTo.length > 0, to: sentTo, cc: lastCc };
    } catch (err) {
        console.error('[VehicleServiceCompleted] Email error:', err.message);
        return { ok: false, reason: err.message };
    }
}

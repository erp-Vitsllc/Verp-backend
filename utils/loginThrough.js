import EmployeeContact from '../models/EmployeeContact.js';
import { normalizeWhatsAppPhone, isValidWhatsAppPhone } from './normalizeWhatsAppPhone.js';

function hasUsableWhatsAppNumber(input) {
    const raw = String(input || '').trim();
    if (!raw) return false;
    const phone = normalizeWhatsAppPhone(raw);
    return isValidWhatsAppPhone(phone) && phone.length >= 11;
}

export const PORTAL_APP_WHATSAPP_REQUIRED =
    'Cannot activate Portal App. Add a WhatsApp number on the employee profile first.';
export const WEB_LOGIN_EMAIL_REQUIRED =
    'Cannot activate Web. Add a Company Email ID in Work Details first.';

export const ACCESS_CONTROL_PATCH_KEYS = ["loginThrough", "enablePortalAccess"];

export function normalizeLoginThrough(source) {
    const stored = source?.loginThrough;
    if (!stored || typeof stored !== 'object') {
        return { portalApp: false, web: false };
    }
    return {
        portalApp: stored.portalApp === true,
        web: stored.web === true,
    };
}

/** True when the employee can sign in on at least one channel (Web or Portal App). */
export function canLoginThroughAnyChannel(source) {
    const through = normalizeLoginThrough(source);
    return through.portalApp === true || through.web === true;
}

/**
 * Where an assignee accepts assign / reassign / transfer / vehicle handover.
 * Web wins when both are on. Company email is not part of this choice.
 * @returns {'web' | 'app' | null}
 */
export function assigneeAcceptChannel(source) {
    const through = normalizeLoginThrough(source);
    if (through.web) return 'web';
    if (through.portalApp) return 'app';
    return null;
}

/**
 * Mongoose always exposes nested `loginThrough` as an object, even when the
 * query did not select it. Only real booleans mean Web/App was loaded.
 */
export function loginThroughFlagsAreLoaded(source) {
    const stored = source?.loginThrough;
    if (!stored || typeof stored !== 'object') return false;
    return typeof stored.portalApp === 'boolean' || typeof stored.web === 'boolean';
}

/** Reload Web/App from the employee record when the in-memory copy was not selected. */
export async function loadLoginThroughForCheck(emp) {
    if (!emp || loginThroughFlagsAreLoaded(emp)) return emp;
    const empId = emp.employeeId ? String(emp.employeeId).trim() : '';
    if (!empId) return emp;
    const EmployeeBasic = (await import('../models/EmployeeBasic.js')).default;
    const row = await EmployeeBasic.findOne({ employeeId: empId })
        .select('loginThrough')
        .lean()
        .catch(() => null);
    if (!row) return emp;
    return {
        employeeId: empId,
        loginThrough: row.loginThrough || { portalApp: false, web: false },
    };
}

export function loginThroughFromBody(body, current) {
    const next = normalizeLoginThrough(current);
    const incoming = body?.loginThrough;
    if (!incoming || typeof incoming !== 'object') return next;
    if (typeof incoming.portalApp === 'boolean') next.portalApp = incoming.portalApp;
    if (typeof incoming.web === 'boolean') next.web = incoming.web;
    return next;
}

export function assertLoginThroughCompanyEmail(employee, nextLoginThrough) {
    if (!nextLoginThrough?.web) return '';
    const email = String(employee?.companyEmail || employee?.workEmail || '').trim();
    return email ? '' : WEB_LOGIN_EMAIL_REQUIRED;
}

export async function assertLoginThroughWhatsApp(employeeId, nextLoginThrough) {
    if (!nextLoginThrough?.portalApp) return '';
    const id = String(employeeId || '').trim();
    if (!id) return 'Link an employee before activating Portal App.';
    const contact = await EmployeeContact.findOne({ employeeId: id }).select('whatsappNumber').lean();
    return hasUsableWhatsAppNumber(contact?.whatsappNumber) ? '' : PORTAL_APP_WHATSAPP_REQUIRED;
}

function pendingProposedPayload(entry) {
    if (!entry || typeof entry !== "object") return {};
    const proposed = entry.proposedData || entry.proposed || entry.newData || entry.toData;
    if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) return {};
    return proposed;
}

/** Login / portal flags are access settings — never HR activation queue rows. */
export function isAccessControlOnlyPendingEntry(entry) {
    const proposed = pendingProposedPayload(entry);
    const keys = Object.keys(proposed).filter((key) => proposed[key] !== undefined);
    if (keys.length === 0) return false;
    return keys.every((key) => ACCESS_CONTROL_PATCH_KEYS.includes(key));
}

export function accessControlSetFromPendingEntry(entry) {
    const proposed = pendingProposedPayload(entry);
    const set = {};
    if (proposed.loginThrough !== undefined) {
        set.loginThrough = normalizeLoginThrough({ loginThrough: proposed.loginThrough });
    }
    if (typeof proposed.enablePortalAccess === "boolean") {
        set.enablePortalAccess = proposed.enablePortalAccess;
    }
    return set;
}

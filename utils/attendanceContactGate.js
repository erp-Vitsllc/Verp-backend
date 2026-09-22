import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeContact from '../models/EmployeeContact.js';
import { normalizeLoginThrough } from './loginThrough.js';

export const WEB_CHECKIN_EMAIL_REQUIRED =
    'Cannot check in. Add your Company Email ID in Work Details first, then check in.';
export const APP_CHECKIN_WHATSAPP_REQUIRED =
    'Cannot check in. Add your WhatsApp number in Basic Details first, then check in.';
export const WEB_ACCESS_REQUIRED =
    'Cannot check in from the website. Enable Web access first.';
export const APP_ACCESS_REQUIRED =
    'Cannot check in from the mobile app. Enable App access first.';

function hasText(value) {
    return Boolean(String(value || '').trim());
}

export async function loadPunchContactFlags(employee) {
    let employeeId = String(employee?.employeeId || '').trim();
    let companyEmail = String(employee?.companyEmail || '').trim();
    let loginThrough = employee?.loginThrough;
    if (employee?._id && (!companyEmail || !employeeId || loginThrough == null)) {
        const row = await EmployeeBasic.findById(employee._id)
            .select('companyEmail employeeId loginThrough')
            .lean();
        if (!companyEmail) companyEmail = String(row?.companyEmail || '').trim();
        if (!employeeId) employeeId = String(row?.employeeId || '').trim();
        if (loginThrough == null) loginThrough = row?.loginThrough;
    }

    let whatsappNumber = '';
    if (employeeId) {
        const contact = await EmployeeContact.findOne({ employeeId }).select('whatsappNumber').lean();
        whatsappNumber = String(contact?.whatsappNumber || '').trim();
    }

    const through = normalizeLoginThrough({ loginThrough });
    return {
        hasCompanyEmail: hasText(companyEmail),
        hasWhatsappNumber: hasText(whatsappNumber),
        portalApp: through.portalApp,
        web: through.web,
    };
}

export function punchContactLockMessage(flags, punchSource, action = 'check in') {
    const source = punchSource === 'app' ? 'app' : 'web';
    if (source === 'web' && flags?.web === false) {
        return WEB_ACCESS_REQUIRED.replaceAll('check in', action);
    }
    if (source === 'app' && flags?.portalApp === false) {
        return APP_ACCESS_REQUIRED.replaceAll('check in', action);
    }
    if (source === 'web' && !flags?.hasCompanyEmail) {
        return WEB_CHECKIN_EMAIL_REQUIRED.replaceAll('check in', action);
    }
    if (source === 'app' && !flags?.hasWhatsappNumber) {
        return APP_CHECKIN_WHATSAPP_REQUIRED.replaceAll('check in', action);
    }
    return '';
}

export async function rejectIfMissingPunchContact(res, employee, punchSource, action = 'check in') {
    const { employeeHasMobileReviewBypass } = await import('./userMobileDevice.js');
    if (await employeeHasMobileReviewBypass(employee)) return false;
    const flags = await loadPunchContactFlags(employee);
    const message = punchContactLockMessage(flags, punchSource, action);
    if (!message) return false;
    res.status(400).json({
        message,
        punchContactLocked: true,
        punchContactField:
            punchSource === 'app'
                ? (flags?.portalApp === false ? 'portalApp' : 'whatsappNumber')
                : (flags?.web === false ? 'web' : 'companyEmail'),
        punchSource: punchSource === 'app' ? 'app' : 'web',
        contactGate: flags,
    });
    return true;
}

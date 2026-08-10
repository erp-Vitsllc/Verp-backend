/**
 * Location lines + deep links for document-expiry emails.
 * Paths mirror frontend dashboard notification routing so the CTA opens the same card/tab.
 */
import { emailFrontendUrl, withFrontendPath } from './resolveFrontendBaseUrl.js';
import {
    resolveCompanyCertificateExpiryNavigationMeta,
} from './companyExpiryScanUtils.js';
import {
    resolveVehicleExpiryFocusCard,
    resolveVehicleExpiryTab,
} from './vehicleExpiryScanUtils.js';

const OWNER_DOC_FOCUS_BY_KEY = {
    passport: 'ownerPassport',
    emiratesId: 'ownerEmiratesId',
    visitVisa: 'ownerVisitVisa',
    employmentVisa: 'ownerEmploymentVisa',
    spouseVisa: 'ownerSpouseVisa',
    labourCard: 'ownerLabourCard',
    medical: 'ownerMedical',
    drivingLicense: 'ownerDrivingLicense',
    visa: 'ownerVisitVisa',
};

const OWNER_DOC_LABEL_RE =
    /^(.*?)\s*[-\u2013\u2014]\s*(Passport|Visa|Visit Visa|Employment Visa|Spouse Visa|Emirates ID|Medical Insurance|Driving License|Labour Card)\s*$/i;

export function escapeExpiryEmailHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function appendQuery(path, key, value) {
    if (!path || value == null || value === '') return path;
    const sep = String(path).includes('?') ? '&' : '?';
    return `${path}${sep}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

function extractExpiryLabel(extra1OrLabel = '') {
    const raw = String(extra1OrLabel || '').trim();
    const prefix = 'Expiry follow-up required:';
    const withoutPrefix = raw.toLowerCase().startsWith(prefix.toLowerCase())
        ? raw.slice(prefix.length).trim()
        : raw;
    return withoutPrefix.replace(/\s*\(Exp:\s*[^)]+\)\s*$/i, '').trim();
}

function resolveCompanyFocusCardFromLabel(label = '') {
    const text = extractExpiryLabel(label);
    if (!text) return null;
    const l = text.toLowerCase();

    if (l.includes('trade license')) return 'tradeLicense';
    if (l.includes('establishment')) return 'establishmentCard';
    if (l.includes('ejari')) return 'ejari';
    if (l.includes('moa')) return 'moa';

    const ownerMatch = text.match(OWNER_DOC_LABEL_RE);
    if (ownerMatch) {
        const doc = ownerMatch[2].trim().toLowerCase();
        if (doc.includes('passport')) return 'ownerPassport';
        if (doc.includes('emirates')) return 'ownerEmiratesId';
        if (doc.includes('visit visa')) return 'ownerVisitVisa';
        if (doc.includes('employment visa')) return 'ownerEmploymentVisa';
        if (doc.includes('spouse visa')) return 'ownerSpouseVisa';
        if (doc.includes('labour')) return 'ownerLabourCard';
        if (doc.includes('medical')) return 'ownerMedical';
        if (doc.includes('driving')) return 'ownerDrivingLicense';
        if (doc.includes('visa')) return 'ownerVisitVisa';
    }

    if (l.includes('passport')) return 'ownerPassport';
    if (l.includes('emirates')) return 'ownerEmiratesId';
    return null;
}

function resolveCompanyExpiryTab(label = '') {
    const l = extractExpiryLabel(label).toLowerCase();
    if (
        l.includes('document with expiry') ||
        l.includes('moa') ||
        l.includes('memo') ||
        l.includes('certificate')
    ) {
        return 'others';
    }
    if (l.includes('trade license') || l.includes('establishment') || l.includes('ejari')) {
        return 'basic';
    }
    if (
        l.includes('passport') ||
        l.includes('visa') ||
        l.includes('emirates') ||
        l.includes('medical') ||
        l.includes('driving') ||
        l.includes('labour')
    ) {
        return 'owner';
    }
    if (l.includes('insurance') || l.includes('document')) return 'others';
    return 'others';
}

function companyTabDisplayName(tab = '') {
    if (tab === 'basic') return 'Basic Details';
    if (tab === 'owner') return 'Owner';
    if (tab === 'others') return 'Documents';
    return tab || 'Profile';
}

function companyDocStatusDisplay(label = '') {
    const l = extractExpiryLabel(label).toLowerCase();
    if (l.includes('memo')) return 'Memo';
    if (l.includes('certificate')) return 'Certificate';
    if (l.includes('moa') || l.includes('document with expiry') || l.includes('insurance')) {
        return 'Live Documents';
    }
    return null;
}

function resolveEmployeeExpiryTab(label = '', doc = {}) {
    const l = extractExpiryLabel(label).toLowerCase();
    if (l.includes('contract')) return 'work-details';
    if (doc?.isCertificate || l.includes('certificate')) return 'documents';

    const basicCardExpiryLabels = [
        'passport',
        'visit visa',
        'employment visa',
        'spouse visa',
        'emirates id',
        'labour card',
        'medical insurance',
        'driving license',
    ];
    if (basicCardExpiryLabels.some((x) => l.includes(x))) return 'basic';

    if (
        l.includes('document with expiry') ||
        l.includes('moa') ||
        l.includes('memo') ||
        l.includes('document') ||
        l.includes('insurance')
    ) {
        return 'documents';
    }
    if (
        l.includes('passport') ||
        l.includes('visa') ||
        l.includes('emirates') ||
        l.includes('labour') ||
        l.includes('medical') ||
        l.includes('driving')
    ) {
        return 'basic';
    }
    return 'documents';
}

function employeeTabDisplayName(tab = '') {
    if (tab === 'basic') return 'Basic Details';
    if (tab === 'documents') return 'Documents';
    if (tab === 'work-details') return 'Work Details';
    return tab || 'Profile';
}

function resolveEmployeeFocusCard(label = '') {
    const l = extractExpiryLabel(label).toLowerCase();
    if (!l) return null;
    if (l.includes('passport')) return 'passport';
    if (l.includes('visit visa') || l.includes('employment visa') || l.includes('spouse visa') || l.includes('visa')) {
        return 'visa';
    }
    if (l.includes('emirates') || l.includes('eid')) return 'emirates-id';
    if (l.includes('labour')) return 'labour-card';
    if (l.includes('medical')) return 'medical-insurance';
    if (l.includes('driving')) return 'driving-license';
    if (l.includes('contract')) return 'work-details';
    if (l.includes('document with expiry') || l.includes('moa') || l.includes('memo') || l.includes('certificate')) {
        return `doc-${l.replace(/\s+/g, '-')}`;
    }
    return null;
}

function vehicleTabDisplayName(tab = '') {
    if (tab === 'basic') return 'Basic Details';
    if (tab === 'permit') return 'Permit';
    if (tab === 'service') return 'Service';
    if (tab === 'document') return 'Document';
    return tab || 'Profile';
}

function certificateTypeLabel(row = {}) {
    const t = String(row?.type || '').trim();
    if (!t) return 'Certificate';
    const lower = t.toLowerCase();
    if (lower === 'installer') return 'Installer';
    if (lower === 'safety') return 'Safety';
    if (lower === 'administration') return 'Administration';
    return t;
}

/**
 * Shared HTML block: location rows + CTA link.
 */
export function renderExpiryEmailLocationBlock({ locationRows = [], detailUrl = '', ctaLabel = 'Open in VeRP' }) {
    const rowsHtml = (locationRows || [])
        .filter((row) => row?.label && row?.value)
        .map(
            (row) =>
                `<p style="margin:0 0 8px;"><strong>${escapeExpiryEmailHtml(row.label)}:</strong> ${escapeExpiryEmailHtml(row.value)}</p>`,
        )
        .join('');

    const linkHtml = detailUrl
        ? `<p style="margin:18px 0 0;">
                <a href="${escapeExpiryEmailHtml(detailUrl)}"
                   style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">
                    ${escapeExpiryEmailHtml(ctaLabel)}
                </a>
           </p>
           <p style="margin:10px 0 0;font-size:12px;color:#64748b;word-break:break-all;">
                Or open: <a href="${escapeExpiryEmailHtml(detailUrl)}" style="color:#2563eb;">${escapeExpiryEmailHtml(detailUrl)}</a>
           </p>`
        : '';

    return `
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;">
            <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#64748b;">Where to find this file</p>
            ${rowsHtml}
            ${linkHtml}
        </div>
    `;
}

export function buildCompanyExpiryEmailLocation({ company, doc, ownerTabMeta = null } = {}) {
    const companyName = String(company?.name || 'Company').trim();
    const companyCode = String(company?.companyId || '').trim();
    const label = String(doc?.label || 'Document').trim();
    const tab = ownerTabMeta != null ? 'owner' : resolveCompanyExpiryTab(label);
    const docStatus = companyDocStatusDisplay(label);
    const certMeta =
        doc?.isCertificate && doc?.documentRow
            ? resolveCompanyCertificateExpiryNavigationMeta(company, doc.documentRow)
            : null;

    let focusCard =
        (ownerTabMeta?.fieldKey && OWNER_DOC_FOCUS_BY_KEY[ownerTabMeta.fieldKey]) ||
        resolveCompanyFocusCardFromLabel(label);

    const locationRows = [
        { label: 'Module', value: 'Company' },
        {
            label: 'Company',
            value: companyCode ? `${companyName} (${companyCode})` : companyName,
        },
        { label: 'Tab', value: companyTabDisplayName(tab) },
    ];

    if (ownerTabMeta != null) {
        const ownerName =
            String(company?.owners?.[ownerTabMeta.idx]?.name || '').trim() ||
            `Owner #${ownerTabMeta.idx + 1}`;
        locationRows.push({ label: 'Owner', value: ownerName });
        locationRows.push({
            label: 'Document type',
            value: label.includes(' - ') ? label.split(/\s*[-\u2013\u2014]\s*/).slice(1).join(' - ') || label : label,
        });
    } else if (doc?.isCertificate) {
        locationRows.push({ label: 'Documents sub-tab', value: 'Certificate' });
        locationRows.push({
            label: 'Certificate type',
            value: certMeta?.certificateSectionId || certificateTypeLabel(doc.documentRow),
        });
        if (Number.isInteger(certMeta?.certificateSectionPage) && certMeta.certificateSectionPage > 1) {
            locationRows.push({
                label: 'Certificate page',
                value: String(certMeta.certificateSectionPage),
            });
        }
        locationRows.push({ label: 'Document', value: label });
    } else {
        if (docStatus) locationRows.push({ label: 'Documents sub-tab', value: docStatus });
        locationRows.push({ label: 'Document', value: label });
    }

    let path = `/Company/${encodeURIComponent(String(company?._id || ''))}?tab=${encodeURIComponent(tab)}`;
    if (docStatus === 'Memo') path = appendQuery(path, 'docStatusTab', 'memo');
    else if (docStatus === 'Certificate' || doc?.isCertificate) path = appendQuery(path, 'docStatusTab', 'certificate');
    else if (docStatus === 'Live Documents') path = appendQuery(path, 'docStatusTab', 'live');

    if (Number.isInteger(ownerTabMeta?.idx) && ownerTabMeta.idx >= 0) {
        path = appendQuery(path, 'ownerTab', ownerTabMeta.idx);
    }
    if (certMeta?.certificateSectionId) {
        path = appendQuery(path, 'certSection', certMeta.certificateSectionId);
    }
    if (Number.isInteger(certMeta?.certificateSectionPage) && certMeta.certificateSectionPage > 1) {
        path = appendQuery(path, 'sectionPage', certMeta.certificateSectionPage);
    }
    if (certMeta?.certificateDocumentId) {
        path = appendQuery(path, 'focusCertificate', certMeta.certificateDocumentId);
    }
    if (focusCard) path = appendQuery(path, 'focusCard', focusCard);

    return {
        locationRows,
        detailUrl: withFrontendPath(path),
        ctaLabel: doc?.isCertificate ? 'Open certificate in Company profile' : 'Open document in Company profile',
        baseUrl: emailFrontendUrl(),
    };
}

export function buildEmployeeExpiryEmailLocation({ employee, doc } = {}) {
    const subjectName =
        `${employee?.firstName || ''} ${employee?.lastName || ''}`.trim() ||
        employee?.employeeId ||
        'Employee';
    const empId = String(employee?.employeeId || employee?._id || '').trim();
    const label = String(doc?.label || 'Document').trim();
    const tab = resolveEmployeeExpiryTab(label, doc);
    const focusCard = resolveEmployeeFocusCard(label);
    const isCertificate = !!(doc?.isCertificate || /certificate/i.test(label));

    const locationRows = [
        { label: 'Module', value: 'Employee' },
        {
            label: 'Employee',
            value: empId ? `${subjectName} (${empId})` : subjectName,
        },
        { label: 'Tab', value: employeeTabDisplayName(tab) },
    ];

    if (isCertificate) {
        locationRows.push({ label: 'Documents sub-tab', value: 'Live Documents' });
        const certType = certificateTypeLabel(doc?.documentRow || {});
        if (certType) locationRows.push({ label: 'Certificate type', value: certType });
    } else if (tab === 'documents') {
        locationRows.push({ label: 'Documents sub-tab', value: 'Live Documents' });
    }

    locationRows.push({ label: 'Document', value: label });

    let path = `/emp/${encodeURIComponent(empId || String(employee?._id || ''))}?tab=${encodeURIComponent(tab)}`;
    if (tab === 'documents') path = appendQuery(path, 'docStatusTab', 'live');
    if (focusCard) path = appendQuery(path, 'focusCard', focusCard);

    return {
        locationRows,
        detailUrl: withFrontendPath(path),
        ctaLabel: 'Open document in Employee profile',
        baseUrl: emailFrontendUrl(),
    };
}

export function buildVehicleExpiryEmailLocation({ asset, doc } = {}) {
    const vehicleLabel = `${asset?.name || 'Vehicle'} (${asset?.assetId || asset?._id || 'N/A'})`;
    const docType = String(doc?.docType || '').trim();
    const tab = resolveVehicleExpiryTab(docType);
    const focusCard = resolveVehicleExpiryFocusCard(docType);
    const label = String(doc?.label || 'Document').trim();

    const locationRows = [
        { label: 'Module', value: 'Asset → Vehicle' },
        { label: 'Vehicle', value: vehicleLabel },
        { label: 'Tab', value: vehicleTabDisplayName(tab) },
        { label: 'Document', value: label },
    ];
    if (docType) locationRows.push({ label: 'Document type', value: docType });

    let path = `/HRM/Asset/Vehicle/details/${encodeURIComponent(String(asset?._id || ''))}`;
    path = appendQuery(path, 'tab', tab);
    path = appendQuery(path, 'focusCard', focusCard);

    return {
        locationRows,
        detailUrl: withFrontendPath(path),
        ctaLabel: 'Open document on Vehicle profile',
        baseUrl: emailFrontendUrl(),
    };
}

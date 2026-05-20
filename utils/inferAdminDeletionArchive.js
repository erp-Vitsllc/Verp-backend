import { ARCHIVE_TOP_MODULES } from '../constants/adminDeletionArchiveConstants.js';

function employeeParentRef(payload) {
    const employeeId = payload?.employeeId;
    if (!employeeId) return {};
    return { employeeId: String(employeeId) };
}

function companyParentRef(payload) {
    const companyId = payload?.companyId;
    if (!companyId) return {};
    return { companyId: String(companyId) };
}

function assetTopModule(payload) {
    const name = (payload?.name || payload?.assetName || '').toLowerCase();
    const assetId = (payload?.assetId || '').toLowerCase();
    if (name.includes('vehicle') || assetId.includes('veh')) return 'vehicle_asset';
    return 'tools_asset';
}

const MODULE_RULES = [
    { test: (m) => m === 'Employee', entityType: 'employee_whole', topModule: 'employees', category: 'list' },
    { test: (m) => m.includes('Employee Document'), entityType: 'employee_document', topModule: 'employees', category: 'documents' },
    { test: (m) => m.includes('Archived document') || m.includes('Old Document') && m.includes('Employee'), entityType: 'employee_old_document', topModule: 'employees', category: 'documents_old' },
    { test: (m) => m.includes('Passport'), entityType: 'employee_passport', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Visa'), entityType: 'employee_visa', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Emirates'), entityType: 'employee_emirates_id', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Labour'), entityType: 'employee_labour_card', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Medical'), entityType: 'employee_medical_insurance', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Driving'), entityType: 'employee_driving_license', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Education'), entityType: 'employee_education', topModule: 'employees', category: 'personal_details' },
    { test: (m) => m.includes('Experience'), entityType: 'employee_experience', topModule: 'employees', category: 'personal_details' },
    { test: (m) => m.includes('Training'), entityType: 'employee_training', topModule: 'employees', category: 'training' },
    { test: (m) => m.includes('Emergency'), entityType: 'employee_emergency_contact', topModule: 'employees', category: 'personal_details' },
    { test: (m) => m.includes('Signature'), entityType: 'employee_signature', topModule: 'employees', category: 'basic_details' },
    { test: (m) => m.includes('Work Details') || m.includes('Work details'), entityType: 'employee_work_details', topModule: 'employees', category: 'work_details' },
    { test: (m) => m.includes('Salary'), entityType: 'employee_salary_history', topModule: 'employees', category: 'salary' },
    { test: (m) => m === 'Company', entityType: 'company_whole', topModule: 'company', category: 'list' },
    { test: (m) => m === 'Company Old Document' || (m.includes('Company') && m.includes('Old Document')), entityType: 'company_old_document', topModule: 'company', category: 'documents_old' },
    { test: (m) => m.includes('Company') && m.includes('document'), entityType: 'company_document', topModule: 'company', category: 'documents' },
    { test: (m) => m.startsWith('Company ') && (m.includes('tradeLicense') || m.includes('establishmentCard')), entityType: 'company_card', topModule: 'company', category: 'basic_details' },
    { test: (m) => m.includes('Company') && m.includes('Owner'), entityType: 'company_owner', topModule: 'company', category: 'owner' },
    { test: (m) => m.includes('Company Archived Owner'), entityType: 'company_owner', topModule: 'company', category: 'owner' },
    { test: (m) => m === 'Fine', entityType: 'fine', topModule: 'fine', category: 'list' },
    { test: (m) => m === 'Reward', entityType: 'reward', topModule: 'reward', category: 'list' },
    { test: (m) => m === 'Loan' || m === 'Advance' || m.includes('Loan') || m.includes('Advance'), entityType: 'loan', topModule: 'loan_advance', category: 'list' },
    { test: (m) => m === 'Asset', entityType: 'asset_item', topModule: null, category: 'list' },
    { test: (m) => m.includes('Asset Document'), entityType: 'asset_document', topModule: null, category: 'documents' },
    { test: (m) => m.includes('Asset Service') || m.includes('Vehicle Service'), entityType: 'asset_service', topModule: null, category: 'service' },
    { test: (m) => m.includes('Asset Accessories'), entityType: 'asset_accessories', topModule: 'tools_asset', category: 'accessories' },
    { test: (m) => m.includes('Accessory catalog'), entityType: 'accessory_catalog', topModule: 'tools_asset', category: 'catalog' },
    { test: (m) => m.includes('Asset Type'), entityType: 'asset_type', topModule: 'tools_asset', category: 'list' },
    { test: (m) => m.includes('Asset Category'), entityType: 'asset_category', topModule: 'tools_asset', category: 'list' },
    { test: (m) => m === 'User', entityType: 'user', topModule: 'settings', category: 'users' },
    { test: (m) => m === 'Group', entityType: 'group', topModule: 'settings', category: 'groups' },
    { test: (m) => m === 'Payment', entityType: 'payment', topModule: 'payment', category: 'list' },
];

export function inferAdminDeletionArchiveMeta({ moduleName, recordId, details, deletedPayload } = {}) {
    const mn = String(moduleName || '').trim();
    const payload = deletedPayload != null ? deletedPayload : {};
    const rule = MODULE_RULES.find((r) => r.test(mn));
    if (!rule) {
        return {
            topModule: 'other',
            category: 'list',
            entityType: 'unknown',
            title: mn || 'Deleted record',
            subtitle: recordId || '',
            details: details || '',
            parentRef: {},
            restoreDescriptor: { type: 'unknown' },
        };
    }

    let topModule = rule.topModule;
    if (topModule == null) topModule = assetTopModule(payload);

    let parentRef = {};
    if (topModule === 'employees') parentRef = employeeParentRef(payload);
    if (topModule === 'company') parentRef = companyParentRef(payload);
    if (topModule === 'vehicle_asset' || topModule === 'tools_asset') {
        parentRef = { assetId: payload?.assetId || recordId };
    }

    const subtitle =
        payload.companyName ||
        payload.employeeId ||
        payload.name ||
        parentRef.employeeId ||
        parentRef.companyId ||
        '';

    return {
        topModule,
        category: rule.category,
        entityType: rule.entityType,
        title: mn,
        subtitle: String(subtitle || recordId || ''),
        details: details || '',
        parentRef,
        restoreDescriptor: { type: rule.entityType },
    };
}

export function getArchiveTopModuleKeys() {
    return Object.values(ARCHIVE_TOP_MODULES).map((m) => m.key);
}

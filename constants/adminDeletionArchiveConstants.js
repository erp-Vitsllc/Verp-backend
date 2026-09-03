/** Pending recovery rows are auto-purged after this many days (not moved to Old Documents). */
export const ADMIN_DELETION_ARCHIVE_RETENTION_DAYS = 60;

/** Enrolment reset snapshots stay in Deleted Records this many days. */
export const SALARY_ENROLLMENT_RESET_RETENTION_DAYS = 90;

/** Top-level tabs (align with ERP sidebar modules). */
export const ARCHIVE_TOP_MODULES = {
    employees: { key: 'employees', label: 'Employees' },
    company: { key: 'company', label: 'Company' },
    fine: { key: 'fine', label: 'Fine' },
    loan_advance: { key: 'loan_advance', label: 'Loan / Advance' },
    reward: { key: 'reward', label: 'Reward' },
    vehicle_asset: { key: 'vehicle_asset', label: 'Vehicle Asset' },
    tools_asset: { key: 'tools_asset', label: 'Tools Asset' },
    utility_bills: { key: 'utility_bills', label: 'Utility Bills' },
    payment: { key: 'payment', label: 'Payments' },
    settings: { key: 'settings', label: 'Settings' },
    other: { key: 'other', label: 'Other' },
};

export const ARCHIVE_CATEGORIES = {
    employees: {
        list: { key: 'list', label: 'Employee list' },
        basic_details: { key: 'basic_details', label: 'Basic details' },
        personal_details: { key: 'personal_details', label: 'Personal details' },
        work_details: { key: 'work_details', label: 'Work details' },
        documents: { key: 'documents', label: 'Documents' },
        documents_old: { key: 'documents_old', label: 'Old documents' },
        salary: { key: 'salary', label: 'Salary' },
        training: { key: 'training', label: 'Training' },
        other: { key: 'other', label: 'Other' },
    },
    company: {
        list: { key: 'list', label: 'Company list' },
        basic_details: { key: 'basic_details', label: 'Basic details' },
        owner: { key: 'owner', label: 'Owner information' },
        documents: { key: 'documents', label: 'Documents' },
        documents_old: { key: 'documents_old', label: 'Old documents' },
        assets_fine: { key: 'assets_fine', label: 'Assets / Fine' },
        other: { key: 'other', label: 'Other' },
    },
    fine: { list: { key: 'list', label: 'Fine records' } },
    loan_advance: { list: { key: 'list', label: 'Loan / Advance records' } },
    reward: { list: { key: 'list', label: 'Reward records' } },
    vehicle_asset: {
        list: { key: 'list', label: 'Vehicles' },
        documents: { key: 'documents', label: 'Documents & cards' },
        service: { key: 'service', label: 'Service records' },
    },
    tools_asset: {
        list: { key: 'list', label: 'Assets' },
        accessories: { key: 'accessories', label: 'Accessories' },
        documents: { key: 'documents', label: 'Documents' },
        service: { key: 'service', label: 'Service records' },
        catalog: { key: 'catalog', label: 'Accessory catalog' },
    },
    utility_bills: {
        list: { key: 'list', label: 'Utility accounts' },
        bills: { key: 'bills', label: 'Bill payments' },
        configs: { key: 'configs', label: 'Utility types' },
    },
    settings: {
        list: { key: 'list', label: 'Users & groups' },
        users: { key: 'users', label: 'Users' },
        groups: { key: 'groups', label: 'Groups' },
    },
    payment: { list: { key: 'list', label: 'Payment records' } },
    other: { list: { key: 'list', label: 'Other' } },
};

export function categoryLabel(topModule, category) {
    return ARCHIVE_CATEGORIES[topModule]?.[category]?.label || category || 'Other';
}

export function topModuleLabel(topModule) {
    return ARCHIVE_TOP_MODULES[topModule]?.label || topModule || 'Other';
}

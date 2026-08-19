// Kinds offered in the dashboard Request card.
export const HUB_MENU_KINDS = ['leave', 'advance', 'loan', 'salary', 'certificate', 'assets'];

// Retired kinds stay accepted so existing pending requests can still be decided.
export const HUB_LEGACY_KINDS = ['fine', 'vehicle', 'utility'];

export const HUB_KINDS = [...HUB_MENU_KINDS, ...HUB_LEGACY_KINDS];

// Asset areas an employee picks before writing an asset request.
export const HUB_ASSET_TYPES = ['Vehicle', 'Tools', 'Utility Bill'];

export const HUB_DASHBOARD_TYPE = {
    leave: 'Employee Leave Request',
    advance: 'Employee Advance Request',
    loan: 'Employee Loan Request',
    salary: 'Employee Salary Request',
    certificate: 'Employee Certificate Request',
    assets: 'Employee Asset Request',
    fine: 'Employee Fine Request',
    vehicle: 'Employee Vehicle Request',
    utility: 'Employee Utility Request',
};

export const HUB_KIND_LABEL = {
    leave: 'Leave',
    advance: 'Advance',
    loan: 'Loan',
    salary: 'Early Salary',
    certificate: 'Salary Certificate',
    assets: 'Assets',
    fine: 'Fine',
    vehicle: 'Vehicle',
    utility: 'Utility Bill',
};

export const HUB_TYPE_TO_KIND = Object.fromEntries(
    Object.entries(HUB_DASHBOARD_TYPE).map(([kind, type]) => [type, kind]),
);

export const HUB_DASHBOARD_TYPES = Object.values(HUB_DASHBOARD_TYPE);

export function isEmployeeHubRequestType(type = '') {
    return HUB_DASHBOARD_TYPES.includes(String(type || '').trim());
}

export function hubKindFromType(type = '') {
    return HUB_TYPE_TO_KIND[String(type || '').trim()] || '';
}

export function hubRequestDisplayLabel(kind, assetType = '') {
    const base = HUB_KIND_LABEL[kind] || 'Request';
    const area = String(assetType || '').trim();
    return area ? `${base} · ${area}` : base;
}

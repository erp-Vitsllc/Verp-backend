export const HUB_KINDS = ['leave', 'fine', 'advance', 'assets', 'vehicle', 'utility'];

export const HUB_DASHBOARD_TYPE = {
    leave: 'Employee Leave Request',
    fine: 'Employee Fine Request',
    advance: 'Employee Advance Request',
    assets: 'Employee Asset Request',
    vehicle: 'Employee Vehicle Request',
    utility: 'Employee Utility Request',
};

export const HUB_KIND_LABEL = {
    leave: 'Leave',
    fine: 'Fine',
    advance: 'Advance',
    assets: 'Assets',
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

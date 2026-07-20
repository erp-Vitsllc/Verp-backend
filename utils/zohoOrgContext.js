import { AsyncLocalStorage } from 'async_hooks';

const zohoOrgStorage = new AsyncLocalStorage();

export function getZohoOrgContext() {
    return zohoOrgStorage.getStore() || null;
}

/** Run fn with Zoho Books organization_id bound for all nested service calls. */
export function withZohoOrganization(organizationId, fn) {
    const id = String(organizationId || '').trim();
    if (!id) {
        return fn();
    }
    return zohoOrgStorage.run({ organizationId: id }, fn);
}

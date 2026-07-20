import Company from '../models/Company.js';
import { getZohoOrganizationId } from '../services/zohoService.js';
import { withZohoOrganization } from './zohoOrgContext.js';

/**
 * Resolve Zoho Books organization id for an ERP company.
 * Uses Company.zohoOrganizationId when set; otherwise env default.
 */
export async function resolveZohoOrganizationIdForCompany(companyOrId) {
    if (!companyOrId) {
        return getZohoOrganizationId();
    }

    let company = companyOrId;
    if (typeof companyOrId === 'string' || companyOrId?._bsontype || companyOrId?.buffer) {
        company = await Company.findById(companyOrId).select('zohoOrganizationId name').lean();
    } else if (companyOrId?.zohoOrganizationId === undefined && companyOrId?._id) {
        company = await Company.findById(companyOrId._id).select('zohoOrganizationId name').lean();
    }

    const fromCompany = String(company?.zohoOrganizationId || '').trim();
    if (fromCompany) return fromCompany;

    return getZohoOrganizationId();
}

/** Resolve org from express query: organizationId | companyId */
export async function resolveZohoOrganizationIdFromRequest(req) {
    const organizationId = String(req?.query?.organizationId || req?.body?.organizationId || '').trim();
    if (organizationId) return organizationId;

    const companyId = String(req?.query?.companyId || req?.body?.companyId || '').trim();
    if (companyId) {
        return resolveZohoOrganizationIdForCompany(companyId);
    }

    return getZohoOrganizationId();
}

export async function runWithRequestZohoOrganization(req, fn) {
    const organizationId = await resolveZohoOrganizationIdFromRequest(req);
    return withZohoOrganization(organizationId, fn);
}

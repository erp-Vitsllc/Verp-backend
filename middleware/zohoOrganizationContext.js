import { resolveZohoOrganizationIdFromRequest } from '../utils/resolveZohoOrganization.js';
import { withZohoOrganization } from '../utils/zohoOrgContext.js';

/**
 * Bind Zoho org for the request from ?organizationId= or ?companyId=
 * (falls back to ZOHO_ORGANIZATION_ID). Keeps AsyncLocalStorage alive until response ends.
 */
export async function zohoOrganizationContext(req, res, next) {
    try {
        const organizationId = await resolveZohoOrganizationIdFromRequest(req);
        req.zohoOrganizationId = organizationId;

        await withZohoOrganization(
            organizationId,
            () =>
                new Promise((resolve, reject) => {
                    let settled = false;
                    const finish = (err) => {
                        if (settled) return;
                        settled = true;
                        if (err) reject(err);
                        else resolve();
                    };

                    res.on('finish', () => finish());
                    res.on('close', () => finish());

                    try {
                        next();
                    } catch (err) {
                        finish(err);
                    }
                }),
        );
    } catch (err) {
        next(err);
    }
}

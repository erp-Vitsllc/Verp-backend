import { listZohoTokenOrganizations } from '../../utils/zohoTokenStore.js';
import Company from '../../models/Company.js';
import { fetchZohoOrganizations, getZohoConfig } from '../../services/zohoService.js';

function brandFromZohoOrgName(name = '') {
    const hay = String(name || '').toLowerCase();
    if (/neuron|nexus|nnit/.test(hay)) return 'NNIT';
    if (/vega/.test(hay)) return 'VEGA';
    return '';
}

/** GET /zoho/connections — which Zoho orgs are connected + company mapping */
export const getZohoConnections = async (_req, res) => {
    try {
        const config = getZohoConfig();
        const defaultOrganizationId = String(config.organizationId || '').trim();
        const nnitOrganizationId = String(config.nnitOrganizationId || '').trim();

        const [tokenOrgs, companies, zohoOrgs] = await Promise.all([
            listZohoTokenOrganizations(),
            Company.find({})
                .select('name nickName zohoOrganizationId zohoOrganizationLabel status')
                .lean(),
            fetchZohoOrganizations().catch(() => []),
        ]);

        // Ensure env-configured orgs are always present even if /organizations fails.
        const knownOrgs = [...(Array.isArray(zohoOrgs) ? zohoOrgs : [])];
        if (
            defaultOrganizationId &&
            !knownOrgs.some((row) => row.organizationId === defaultOrganizationId)
        ) {
            knownOrgs.push({
                organizationId: defaultOrganizationId,
                name: 'VEGADIGITAL IT SOLUTIONS LLC',
                isDefault: true,
                isActive: true,
            });
        }
        if (
            nnitOrganizationId &&
            !knownOrgs.some((row) => row.organizationId === nnitOrganizationId)
        ) {
            knownOrgs.push({
                organizationId: nnitOrganizationId,
                name: 'NEURON NEXUS INFORMATION TECHNOLOGY L.L.C',
                isDefault: false,
                isActive: true,
            });
        }

        const organizations = knownOrgs.map((row) => ({
            ...row,
            brand:
                brandFromZohoOrgName(row.name) ||
                (row.organizationId === defaultOrganizationId
                    ? 'VEGA'
                    : row.organizationId === nnitOrganizationId
                      ? 'NNIT'
                      : ''),
        }));

        return res.status(200).json({
            success: true,
            data: {
                defaultOrganizationId,
                nnitOrganizationId,
                organizations,
                connections: tokenOrgs,
                companies: companies.map((c) => ({
                    id: String(c._id),
                    name: c.name,
                    nickName: c.nickName || '',
                    status: c.status,
                    zohoOrganizationId: String(c.zohoOrganizationId || '').trim(),
                    zohoOrganizationLabel: String(c.zohoOrganizationLabel || '').trim(),
                })),
            },
        });
    } catch (error) {
        console.error('[ZohoConnections] Failed:', error?.message || error);
        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to load Zoho connections',
        });
    }
};

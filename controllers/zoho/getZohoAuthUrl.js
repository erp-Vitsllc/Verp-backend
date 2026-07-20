import { buildAuthorizationUrl } from '../../services/zohoService.js';
import Company from '../../models/Company.js';

export const getZohoAuthUrl = async (req, res) => {
    try {
        let organizationId = String(req.query?.organizationId || '').trim();
        const companyId = String(req.query?.companyId || '').trim();

        if (!organizationId && companyId) {
            const company = await Company.findById(companyId)
                .select('zohoOrganizationId name')
                .lean();
            organizationId = String(company?.zohoOrganizationId || '').trim();
            if (!organizationId) {
                return res.status(400).json({
                    success: false,
                    message:
                        'This company has no zohoOrganizationId. Set it on the company, then connect Zoho.',
                });
            }
        }

        const auth = await buildAuthorizationUrl({ organizationId });

        return res.status(200).json({
            success: true,
            data: {
                authorizationUrl: auth.authorizationUrl,
                scope: auth.scope,
                organizationId: auth.organizationId,
            },
        });
    } catch (error) {
        console.error('[ZohoAuthUrl] Failed:', error?.message || error);
        return res.status(500).json({
            success: false,
            message: error?.message || 'Failed to build Zoho authorization URL',
        });
    }
};

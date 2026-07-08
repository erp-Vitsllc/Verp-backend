import { buildAuthorizationUrl } from '../../services/zohoService.js';

export const getZohoAuthUrl = async (_req, res) => {
    try {
        const auth = await buildAuthorizationUrl();

        return res.status(200).json({
            success: true,
            data: {
                authorizationUrl: auth.authorizationUrl,
                scope: auth.scope,
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

import { syncLocatorToErpDatabase } from '../../services/locatorSnapshotService.js';

/** Pull latest Locator positions into ERP, then the vehicle list can read them. */
export const postLocatorRefreshGps = async (_req, res) => {
    try {
        const result = await syncLocatorToErpDatabase();
        if (!result?.configured) {
            return res.status(200).json({
                success: false,
                message: 'GPS is not configured.',
            });
        }

        return res.status(200).json({
            success: true,
            saved: result.saved ?? 0,
        });
    } catch (error) {
        const status = error?.statusCode === 429 ? 429 : 500;
        console.error('[LocatorSync] manual refresh failed:', error?.message || error);
        return res.status(status).json({
            success: false,
            message:
                status === 429
                    ? 'GPS refresh is busy. Try again in a minute. Current values were kept.'
                    : 'GPS refresh failed. Current values were kept.',
        });
    }
};

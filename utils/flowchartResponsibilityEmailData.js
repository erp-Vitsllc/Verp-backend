import AssetItem from '../models/AssetItem.js';

/**
 * Loads lists for responsibility approval emails (HR / Asset Controller previews).
 */
export async function buildResponsibilityEmailData(category) {
    const cat = (category || '').toLowerCase().replace(/\s+/g, '');
    const out = {
        hrBullets: [],
        companyAssets: [],
        unassignedAssets: [],
        parkingAssets: [],
        /** @deprecated kept for older email templates; prefer accessories nested on each asset */
        accessorySummaryLines: []
    };

    if (cat === 'hr') {
        out.hrBullets = [
            'Employee profiles, onboarding, and org data used across HRM',
            'Fine, Reward, Loan, and Advance approval routing (per matrix)',
            'Company-allocated assets (HR / company handover flows)',
            'Coordination with Accounts, Asset Controller, and Management approvers'
        ];
        out.companyAssets = await AssetItem.find({
            assignedToType: 'Company',
            status: { $in: ['Assigned', 'Pending', 'On Leave'] }
        })
            .select('assetId name status')
            .sort({ assetId: 1 })
            .limit(40)
            .lean();
    }

    if (cat === 'assetcontroller') {
        out.unassignedAssets = await AssetItem.find({
            status: 'Unassigned'
        })
            .select('assetId name status accessories')
            .sort({ assetId: 1 })
            .limit(80)
            .lean();

        out.parkingAssets = await AssetItem.find({ status: 'On Leave' })
            .select('assetId name status accessories')
            .sort({ assetId: 1 })
            .limit(80)
            .lean();

        const flatAcc = [];
        for (const a of [...out.unassignedAssets, ...out.parkingAssets]) {
            for (const acc of a.accessories || []) {
                flatAcc.push({
                    line: `${a.assetId} — ${acc.name || 'Accessory'}${acc.status ? ` (${acc.status})` : ''}`
                });
            }
        }
        out.accessorySummaryLines = flatAcc.slice(0, 50);
    }

    return out;
}

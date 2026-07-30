import AssetItem from '../models/AssetItem.js';

/** Global ERP-wide VSR prefix — unique across all vehicles and service types. */
export const VSR_PREFIX = 'VSR-';
const VSR_REGEX = /^VSR-(\d+)$/i;

/**
 * Allocate the next global VSR-No for any vehicle service: `VSR-001`, `VSR-002`, …
 * Unique across the whole ERP (all assets, all service types).
 * Call (and await) before pushing the new service onto asset.services.
 * @param {_asset} unused — kept for call-site compatibility
 */
export async function allocateNextServiceReqNo(_asset) {
    try {
        const docs = await AssetItem.find(
            { 'services.serviceReqNo': { $regex: /^VSR-\d+$/i } },
            { 'services.serviceReqNo': 1 },
        ).lean();

        let maxSeq = 0;
        for (let d = 0; d < docs.length; d += 1) {
            const services = Array.isArray(docs[d]?.services) ? docs[d].services : [];
            for (let i = 0; i < services.length; i += 1) {
                const no = String(services[i]?.serviceReqNo || '').trim();
                const match = no.match(VSR_REGEX);
                if (match?.[1]) {
                    const n = Number.parseInt(match[1], 10);
                    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
                }
            }
        }

        return `${VSR_PREFIX}${String(maxSeq + 1).padStart(3, '0')}`;
    } catch (error) {
        console.error('Error allocating VSR-No:', error);
        return `${VSR_PREFIX}${String(Date.now()).slice(-6)}`;
    }
}

/** Prefer stored serviceReqNo / VSR-No; fall back for legacy rows without one. */
export function formatServiceReqNoDisplay(service, asset) {
    const stored = String(service?.serviceReqNo || '').trim();
    if (stored) return stored;

    const assetId = String(asset?.assetId || '').trim();
    const services = Array.isArray(asset?.services) ? asset.services : [];
    if (assetId && service?._id && services.length) {
        const idx = services.findIndex((s) => String(s?._id) === String(service._id));
        if (idx >= 0) {
            return `${assetId}-${String(idx + 1).padStart(3, '0')}`;
        }
    }

    const fallback = String(service?._id || '').slice(-8);
    return fallback || assetId || '—';
}

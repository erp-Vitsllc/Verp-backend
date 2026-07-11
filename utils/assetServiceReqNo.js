/**
 * Allocate the next Service Req No for an asset: `{assetId}-{NNN}`
 * e.g. VEGA-Veh-001-001, then VEGA-Veh-001-002, …
 * Call before pushing the new service onto asset.services.
 */
export function allocateNextServiceReqNo(asset) {
    const assetId = String(asset?.assetId || '').trim() || 'ASSET';
    const prefix = `${assetId}-`;
    const services = Array.isArray(asset?.services) ? asset.services : [];
    let maxSeq = 0;

    for (let i = 0; i < services.length; i += 1) {
        const no = String(services[i]?.serviceReqNo || '').trim();
        if (no.startsWith(prefix)) {
            const n = Number.parseInt(no.slice(prefix.length), 10);
            if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
        } else {
            // Legacy rows without serviceReqNo — reserve their index slot.
            maxSeq = Math.max(maxSeq, i + 1);
        }
    }

    const next = maxSeq + 1;
    return `${assetId}-${String(next).padStart(3, '0')}`;
}

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

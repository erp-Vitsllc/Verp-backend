import { isFleetVehicleAsset } from './assetApprovalHelpers.js';

const normType = (t) => String(t || '').toLowerCase().trim();

function parseDescription(doc) {
    if (!doc?.description) return {};
    try {
        return JSON.parse(doc.description);
    } catch {
        return { text: String(doc.description) };
    }
}

export const VEHICLE_EXPIRY_DOC_LABELS = {
    registration: 'Mulkia (Registration)',
    insurance: 'Insurance Card',
    warranty: 'Warranty',
    permit: 'Permit',
    petrol: 'Petrol Card',
    toll: 'Toll Card',
    mortgage: 'Mortgage',
};

export { isFleetVehicleAsset };

export function isVehicleDocumentArchived(doc) {
    if (!doc) return true;
    const status = String(doc.status || doc.documentStatus || '').toLowerCase();
    if (['old', 'renewed', 'archived', 'inactive'].includes(status)) return true;
    const meta = parseDescription(doc);
    return Boolean(meta.isRenewed || meta.notRenewed);
}

export function buildVehicleExpiryDocumentLabel(doc) {
    if (!doc) return null;
    const t = normType(doc.type);
    if (t.includes(' attachment')) return null;

    if (t === 'permit') {
        const meta = parseDescription(doc);
        const permitType = String(meta.permitType || '').trim();
        return permitType ? `Permit (${permitType})` : VEHICLE_EXPIRY_DOC_LABELS.permit;
    }

    const mapped = VEHICLE_EXPIRY_DOC_LABELS[t];
    if (mapped) return mapped;

    if (doc.expiryDate && t) {
        const base = String(doc.type || 'Document').trim();
        return base || 'Document';
    }
    return null;
}

export function vehicleExpiryLabelsForSection(sectionId) {
    const section = String(sectionId || '').trim();
    if (section === 'registration') return [VEHICLE_EXPIRY_DOC_LABELS.registration];
    if (section === 'insurance') return [VEHICLE_EXPIRY_DOC_LABELS.insurance];
    return [];
}

export function vehicleExpiryLabelForDocType(typeName) {
    const t = normType(typeName);
    if (t.includes(' attachment')) {
        if (t.startsWith('registration')) return VEHICLE_EXPIRY_DOC_LABELS.registration;
        if (t.startsWith('insurance')) return VEHICLE_EXPIRY_DOC_LABELS.insurance;
        if (t.startsWith('warranty')) return VEHICLE_EXPIRY_DOC_LABELS.warranty;
        if (t.startsWith('permit')) return VEHICLE_EXPIRY_DOC_LABELS.permit;
        return null;
    }
    return buildVehicleExpiryDocumentLabel({ type: typeName, expiryDate: new Date() });
}

/** Live fleet vehicle cards / dates that can trigger HR expiry follow-up. */
export function collectVehicleExpiryDocuments(asset) {
    const docs = [];
    if (!asset || !isFleetVehicleAsset(asset)) return docs;

    const profileActive = String(asset.vehicleProfileActivationStatus || '').toLowerCase() === 'active';
    if (!profileActive) return docs;

    const disposition = String(asset.vehicleDispositionStatus || 'active').toLowerCase();
    if (disposition === 'sold' || disposition === 'total loss') return docs;

    const seen = new Set();
    for (const doc of asset.documents || []) {
        if (!doc?.expiryDate || isVehicleDocumentArchived(doc)) continue;
        const label = buildVehicleExpiryDocumentLabel(doc);
        if (!label) continue;
        const key = `${normType(doc.type)}:${String(doc._id || label)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        docs.push({
            key,
            label,
            expiryDate: doc.expiryDate,
            docType: normType(doc.type),
        });
    }

    if (asset.nextServiceDate) {
        docs.push({
            key: 'asset:nextServiceDate',
            label: 'Next Service',
            expiryDate: asset.nextServiceDate,
            docType: 'service',
        });
    }
    if (asset.gearOilDueDate) {
        docs.push({
            key: 'asset:gearOilDueDate',
            label: 'Gear Oil Service',
            expiryDate: asset.gearOilDueDate,
            docType: 'service',
        });
    }

    return docs;
}

export function resolveVehicleExpiryFocusCard(docType = '') {
    const t = normType(docType);
    if (t === 'registration') return 'vehicleRegistration';
    if (t === 'insurance') return 'vehicleInsurance';
    if (t === 'warranty') return 'vehicleWarranty';
    if (t === 'permit') return 'vehiclePermit';
    if (t === 'petrol') return 'vehiclePetrol';
    if (t === 'toll') return 'vehicleToll';
    if (t === 'mortgage') return 'vehicleMortgage';
    if (t === 'service') return 'vehicleService';
    return 'vehicleRegistration';
}

export function resolveVehicleExpiryTab(docType = '') {
    const t = normType(docType);
    if (t === 'permit') return 'permit';
    if (t === 'service') return 'service';
    if (['petrol', 'toll', 'mortgage'].includes(t)) return 'document';
    return 'basic';
}

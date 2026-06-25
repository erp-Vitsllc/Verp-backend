const normDocType = (t) => String(t || '').toLowerCase().trim();

function parseDocDescription(doc) {
    if (!doc?.description) return {};
    try {
        return JSON.parse(doc.description);
    } catch {
        return {};
    }
}

export function isVehicleBasicDetailsComplete(asset) {
    if (!asset) return false;
    const brand = String(asset.typeId?.name || asset.type || '').trim();
    const model = String(asset.name || '').trim();
    const hasModelYear = asset.modelYear != null && String(asset.modelYear).trim() !== '';
    const plateDigits = String(asset.plateNumber || '').replace(/\D/g, '');
    return Boolean(brand && model && hasModelYear && plateDigits.length >= 1);
}

export function isVehicleRegistrationCardComplete(asset) {
    const docs = Array.isArray(asset?.documents) ? asset.documents : [];
    const registrationDoc = docs.find((d) => normDocType(d.type) === 'registration') || null;
    const registrationAttachments = docs.filter((d) => normDocType(d.type) === 'registration attachment');
    const registrationMeta = parseDocDescription(registrationDoc);

    return Boolean(
        registrationDoc?.issueDate ||
            registrationDoc?.expiryDate ||
            registrationDoc?.attachment ||
            registrationMeta?.fee != null ||
            registrationAttachments.length > 0,
    );
}

export function isVehicleInsuranceCardComplete(asset) {
    const docs = Array.isArray(asset?.documents) ? asset.documents : [];
    const insuranceDoc = docs.find((d) => normDocType(d.type) === 'insurance') || null;
    const insuranceAttachments = docs.filter((d) => normDocType(d.type) === 'insurance attachment');
    const insuranceMeta = parseDocDescription(insuranceDoc);

    return Boolean(
        insuranceDoc?.issueDate ||
            insuranceDoc?.expiryDate ||
            insuranceDoc?.attachment ||
            (insuranceMeta?.policy && String(insuranceMeta.policy).trim()) ||
            (insuranceMeta?.company && String(insuranceMeta.company).trim()) ||
            insuranceMeta?.premiumAmount != null ||
            insuranceMeta?.excessCharge != null ||
            insuranceAttachments.length > 0,
    );
}

export function isVehicleProfilePictureComplete(asset) {
    return Boolean(asset?.imagePreview || asset?.photo || asset?.images?.[0]?.url);
}

export const VEHICLE_PROFILE_ACTIVATION_SECTION_IDS = [
    'basic',
    'registration',
    'insurance',
    'profile_picture',
];

/** Returns first missing requirement message, or null when profile is 100% ready. */
export function assertVehicleProfileActivationReady(asset) {
    if (!isVehicleBasicDetailsComplete(asset)) {
        return 'Complete basic details (brand, model, model year, and plate number) before submitting.';
    }
    if (!isVehicleRegistrationCardComplete(asset)) {
        return 'Add the registration card before submitting.';
    }
    if (!isVehicleInsuranceCardComplete(asset)) {
        return 'Add the insurance card before submitting.';
    }
    if (!isVehicleProfilePictureComplete(asset)) {
        return 'Upload a profile picture before submitting.';
    }
    return null;
}

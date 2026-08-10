const normDocType = (t) => String(t || '').toLowerCase().trim();

function parseDocDescription(doc) {
    if (!doc?.description) return {};
    try {
        return JSON.parse(doc.description);
    } catch {
        return {};
    }
}

function isDocumentOld(doc) {
    const meta = parseDocDescription(doc);
    return Boolean(meta?.isOld || meta?.lifecycle === 'old' || meta?.status === 'old');
}

function liveDocsOfType(asset, type) {
    const docs = Array.isArray(asset?.documents) ? asset.documents : [];
    const want = normDocType(type);
    return docs.filter((d) => normDocType(d.type) === want && !isDocumentOld(d));
}

function pickPrimaryLiveDoc(docs) {
    if (!docs?.length) return null;
    return [...docs].sort((a, b) => {
        const ta = new Date(a.issueDate || a.expiryDate || a.createdAt || 0).getTime();
        const tb = new Date(b.issueDate || b.expiryDate || b.createdAt || 0).getTime();
        return tb - ta;
    })[0];
}

export function isVehicleBasicDetailsComplete(asset) {
    if (!asset) return false;
    const brand = String(asset.vehicleBrand || asset.typeId?.name || asset.type || '').trim();
    const model = String(asset.name || '').trim();
    const hasModelYear = asset.modelYear != null && String(asset.modelYear).trim() !== '';
    const plateDigits = String(asset.plateNumber || '').replace(/\D/g, '');
    return Boolean(brand && model && hasModelYear && plateDigits.length >= 1);
}

export function isVehicleRegistrationCardComplete(asset) {
    const registrationDocs = liveDocsOfType(asset, 'registration');
    const registrationAttachments = liveDocsOfType(asset, 'registration attachment');
    const registrationDoc = pickPrimaryLiveDoc(registrationDocs);
    if (!registrationDoc && registrationAttachments.length === 0) return false;

    // Progress only requires a live card. Expiry is handled by card status + notifications.
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
    const insuranceDocs = liveDocsOfType(asset, 'insurance');
    const insuranceAttachments = liveDocsOfType(asset, 'insurance attachment');
    const insuranceDoc = pickPrimaryLiveDoc(insuranceDocs);
    if (!insuranceDoc && insuranceAttachments.length === 0) return false;

    // Progress only requires a live card. Expiry is handled by card status + notifications.
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

/** Progress bar: HR-approved / active inspection only (matches frontend). */
export function isVehicleInspectionComplete(asset) {
    return String(asset?.vehicleInspectionStatus || '').toLowerCase() === 'active';
}

/** Activation gate: also accept a Vehicle Inspection document (legacy). */
export function isVehicleInspectionCompleteForActivation(asset) {
    if (isVehicleInspectionComplete(asset)) return true;
    return (asset?.documents || []).some(
        (doc) => String(doc?.type || '').trim().toLowerCase() === 'vehicle inspection',
    );
}

export const VEHICLE_PROFILE_ACTIVATION_SECTION_IDS = [
    'basic',
    'registration',
    'insurance',
    'profile_picture',
    'warranty',
    'permit',
    'petrol',
    'toll',
    'documents',
    'mortgage',
];

export function buildVehicleProfileCompletionChecks(asset) {
    return [
        { label: 'Basic Details', completed: isVehicleBasicDetailsComplete(asset) },
        { label: 'Mulkia (Registration)', completed: isVehicleRegistrationCardComplete(asset) },
        { label: 'Insurance Details', completed: isVehicleInsuranceCardComplete(asset) },
        { label: 'Profile Picture', completed: isVehicleProfilePictureComplete(asset) },
        { label: 'Vehicle Inspection', completed: isVehicleInspectionComplete(asset) },
    ];
}

export function computeVehicleProfileCompletionPercent(asset) {
    const checks = buildVehicleProfileCompletionChecks(asset);
    const total = checks.length || 1;
    const completed = checks.filter((c) => c.completed).length;
    return {
        profilePct: Math.round((completed / total) * 100),
        completionChecks: checks,
        pendingChecks: checks.filter((c) => !c.completed),
    };
}

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
    if (!isVehicleInspectionCompleteForActivation(asset)) {
        return 'Complete vehicle inspection (Admin Officer request and HR approval) before submitting for activation.';
    }
    return null;
}

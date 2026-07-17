function resolveLocationName(contact, locations = []) {
    const locationId = String(contact?.location_id || '').trim();
    if (!locationId || !Array.isArray(locations)) {
        return String(contact?.location_name || contact?.branch_name || '').trim();
    }

    const match = locations.find(
        (location) => String(location?.location_id || location?.id || '').trim() === locationId,
    );

    return String(
        match?.location_name || match?.name || contact?.location_name || contact?.branch_name || '',
    ).trim();
}

function resolvePrimaryLocation(locations = []) {
    if (!Array.isArray(locations) || !locations.length) return null;

    const primary = locations.find(
        (location) =>
            location?.is_primary === true ||
            location?.is_primary_location === true ||
            String(location?.type || '').toLowerCase().includes('primary'),
    );

    return primary || locations[0] || null;
}

export function buildVendorPaymentDefaults(contact, locations = []) {
    if (!contact || typeof contact !== 'object') {
        const primary = resolvePrimaryLocation(locations);
        if (!primary) return null;
        return {
            location_id: String(primary.location_id || primary.id || '').trim(),
            location_name: String(primary.location_name || primary.name || '').trim(),
            currency_code: 'AED',
            outstanding_payable_amount: 0,
            payment_terms_label: '',
        };
    }

    let locationId = String(contact.location_id || '').trim();
    let locationName = resolveLocationName(contact, locations);

    if (!locationId) {
        const primary = resolvePrimaryLocation(locations);
        if (primary) {
            locationId = String(primary.location_id || primary.id || '').trim();
            locationName = String(primary.location_name || primary.name || locationName || '').trim();
        }
    }

    const currencyCode = String(contact.currency_code || 'AED').trim() || 'AED';
    const outstandingPayableAmount = Number(contact.outstanding_payable_amount) || 0;

    return {
        location_id: locationId,
        location_name: locationName,
        currency_code: currencyCode,
        outstanding_payable_amount: outstandingPayableAmount,
        payment_terms_label: String(contact.payment_terms_label || '').trim(),
    };
}

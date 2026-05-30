const ADDRESS_REGEX = /^[A-Za-z0-9\s,./#-]{5,255}$/;
const CITY_REGEX = /^[A-Za-z\s]{2,100}$/;
const PO_BOX_REGEX = /^[A-Za-z0-9-]{1,20}$/;
const COUNTRY_STATE_REGEX = /^[A-Za-z0-9\s.'()-]{2,100}$/;

export function sanitizeCompanyAddressField(val, fieldName) {
    if (val === undefined || val === null) return "";
    if (typeof val === "object" || Array.isArray(val)) {
        throw new Error(`Invalid data type for field ${fieldName}`);
    }
    let str = String(val).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    return str;
}

export function validateCompanyAddressPayload({ address, country, state, city, postalCode }) {
    if (!address) {
        return { ok: false, message: "Company Address is required" };
    }
    if (address.length < 5) {
        return { ok: false, message: "Company Address must be at least 5 characters" };
    }
    if (address.length > 255) {
        return { ok: false, message: "Company Address must be no more than 255 characters" };
    }
    if (!ADDRESS_REGEX.test(address)) {
        return { ok: false, message: "Company Address contains restricted special characters" };
    }

    if (!country) {
        return { ok: false, message: "Country is required" };
    }
    if (!COUNTRY_STATE_REGEX.test(country)) {
        return { ok: false, message: "Please select a valid country from the list" };
    }

    if (!state) {
        return { ok: false, message: "State / Emirates is required" };
    }
    if (state.length < 2 || state.length > 100) {
        return { ok: false, message: "State / Emirates must be between 2 and 100 characters" };
    }
    if (!COUNTRY_STATE_REGEX.test(state)) {
        return { ok: false, message: "Please select a valid State / Emirate from the list" };
    }

    if (city) {
        if (city.length < 2) {
            return { ok: false, message: "City must be at least 2 characters" };
        }
        if (city.length > 100) {
            return { ok: false, message: "City must be no more than 100 characters" };
        }
        if (!CITY_REGEX.test(city)) {
            return { ok: false, message: "City must contain only letters and spaces" };
        }
    }

    if (postalCode) {
        if (postalCode.length < 1) {
            return { ok: false, message: "PO Box must be at least 1 character" };
        }
        if (postalCode.length > 20) {
            return { ok: false, message: "PO Box must be no more than 20 characters" };
        }
        if (!PO_BOX_REGEX.test(postalCode)) {
            return { ok: false, message: "PO Box contains invalid characters" };
        }
    }

    return { ok: true };
}

import { stripDangerousText } from "./employeeAddValidation.js";

const COUNTRY_ISO = /^[A-Za-z]{2}$/;

function validateAddressLine(value) {
    const cleaned = stripDangerousText(value);
    if (!cleaned) return "Address is required";
    if (cleaned.length < 5) return "Address must be at least 5 characters";
    if (cleaned.length > 200) return "Address must be no more than 200 characters";
    return null;
}

function validateApartment(value) {
    const cleaned = stripDangerousText(value);
    if (!cleaned) return null;
    if (cleaned.length > 50) return "Apartment/Flat must be no more than 50 characters";
    return null;
}

function validateCity(value) {
    const cleaned = stripDangerousText(value);
    if (!cleaned) return "City is required";
    if (cleaned.length < 2) return "City must be at least 2 characters";
    if (!/^[A-Za-z0-9\s]+$/.test(cleaned)) {
        return "City must contain letters, numbers, and spaces only";
    }
    return null;
}

function validateState(value) {
    const cleaned = stripDangerousText(value);
    if (!cleaned) return "Emirates/State is required";
    if (!/^[A-Za-z\s'-]+$/.test(cleaned)) {
        return "Emirates/State may contain only letters, spaces, hyphen and apostrophe";
    }
    return null;
}

function validateCountry(value) {
    const code = String(value || "").trim();
    if (!code) return "Country is required";
    if (!COUNTRY_ISO.test(code)) return "Please select a valid country from the list";
    return null;
}

function validatePostalCode(value) {
    const cleaned = stripDangerousText(value);
    if (!cleaned) return null;
    if (cleaned.length > 10) return "ZIP Code must be no more than 10 characters";
    if (!/^[A-Za-z0-9\s-]+$/.test(cleaned)) {
        return "ZIP Code may contain only letters, numbers, spaces, and hyphens";
    }
    return null;
}

export function validateEmployeeAddressPayload(form = {}) {
    const errors = [];
    const push = (err) => {
        if (err) errors.push(err);
    };

    push(validateAddressLine(form.line1 ?? form.addressLine1 ?? form.currentAddressLine1));
    push(validateApartment(form.line2 ?? form.addressLine2 ?? form.currentAddressLine2));
    push(validateCity(form.city ?? form.currentCity));
    push(validateCountry(form.country ?? form.currentCountry));
    push(validateState(form.state ?? form.currentState));
    push(validatePostalCode(form.postalCode ?? form.currentPostalCode));

    return { ok: errors.length === 0, errors, message: errors[0] || "" };
}

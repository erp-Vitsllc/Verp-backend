import { stripDangerousText, validateInternationalPhone } from "./employeeAddValidation.js";

const RELATION_VALUES = ["Self", "Father", "Mother", "Spouse", "Friend", "Other"];

function validateName(value) {
    const cleaned = stripDangerousText(value).replace(/\s+/g, " ").trim();
    if (!cleaned) return "Name is required";
    if (cleaned.length < 2) return "Name must be at least 2 characters";
    if (cleaned.length > 100) return "Name must be no more than 100 characters";
    if (!/^[A-Za-z\s]+$/.test(cleaned)) return "Name must contain only letters and spaces";
    return null;
}

function validateRelation(value) {
    const cleaned = String(value || "").trim();
    if (!cleaned) return "Relation is required";
    if (!RELATION_VALUES.includes(cleaned)) return "Please select a valid relation";
    return null;
}

function validatePhone(value, { employeeContactNumber } = {}) {
    const phoneErr = validateInternationalPhone(value);
    if (phoneErr) return phoneErr;
    const normalize = (n) => String(n || "").replace(/\D/g, "");
    const incoming = normalize(value);
    const employee = normalize(employeeContactNumber);
    if (employee && incoming && incoming === employee) {
        return "Emergency contact number must not be the same as the employee contact number";
    }
    return null;
}

export function validateEmergencyContactPayload(contact = {}, options = {}) {
    const errors = [];
    const push = (err) => {
        if (err) errors.push(err);
    };

    push(validateName(contact.name));
    push(validateRelation(contact.relation));
    push(validatePhone(contact.number, options));

    return { ok: errors.length === 0, errors, message: errors[0] || "" };
}

import {
    stripDangerousText,
    validateInternationalPhone,
    EMPLOYEE_ADD_PATTERNS,
} from "./employeeAddValidation.js";

export const EMPLOYEE_MARITAL_STATUS_VALUES = [
    "single",
    "married",
    "divorced",
    "widowed",
];

const PROFILE_NAME_PART = /^[A-Za-z\s'-]+$/;
const PROFILE_FATHER_NAME = /^[A-Za-z\s]+$/;
const NATIONALITY_ISO = /^[A-Za-z]{2}$/;

function parseIsoDate(value) {
    if (!value) return null;
    const str = String(value).includes("T") ? String(value).split("T")[0] : String(value);
    if (!EMPLOYEE_ADD_PATTERNS.DATE_ISO.test(str)) return null;
    const [y, m, day] = str.split("-").map(Number);
    const d = new Date(y, m - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== m - 1 || d.getDate() !== day) return null;
    return d;
}

function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function calculateAgeOnDate(birthIso, onIso) {
    const birth = parseIsoDate(birthIso);
    const on = parseIsoDate(onIso);
    if (!birth || !on) return null;
    let age = on.getFullYear() - birth.getFullYear();
    const md = on.getMonth() - birth.getMonth();
    if (md < 0 || (md === 0 && on.getDate() < birth.getDate())) age--;
    return age;
}

function todayIso() {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

function normalizeProfileNamePart(value) {
    return stripDangerousText(value).replace(/\s+/g, " ").trim();
}

function validateProfileNamePart(value, label) {
    const cleaned = normalizeProfileNamePart(value);
    if (!cleaned) return `${label} is required`;
    if (cleaned.length < 2 || cleaned.length > 100) {
        return `${label} must be 2–100 characters`;
    }
    if (!PROFILE_NAME_PART.test(cleaned)) {
        return `${label} must contain only letters, spaces, apostrophe and hyphen`;
    }
    return null;
}

function validateProfileEmail(value) {
    const email = stripDangerousText(value).toLowerCase();
    if (!email) return "Email is required";
    if (email.length > 254) return "Email must be no more than 254 characters";
    if (/\.\./.test(email)) return "Email cannot contain consecutive dots";
    if (!EMPLOYEE_ADD_PATTERNS.EMAIL.test(email)) return "Please enter a valid email address";
    return null;
}

function validateProfileDateOfBirth(value) {
    const d = parseIsoDate(value);
    if (!d) return "Date of Birth is required and must be a valid date";
    if (startOfDay(d) >= startOfDay(new Date())) return "Date of Birth cannot be today or in the future";
    const age = calculateAgeOnDate(value, todayIso());
    if (age !== null && age < 18) return "Employee must be at least 18 years old";
    return null;
}

function validateProfileMaritalStatus(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return "Marital Status is required";
    if (!EMPLOYEE_MARITAL_STATUS_VALUES.includes(normalized)) {
        return "Please select a valid marital status option";
    }
    return null;
}

function validateProfileNumberOfDependents(maritalStatus, value) {
    if (String(maritalStatus || "").toLowerCase() !== "married") return null;
    const raw = value === undefined || value === null ? "" : String(value).trim();
    if (raw === "") return "Number of Dependents is required when marital status is Married";
    if (!/^\d+$/.test(raw)) return "Number of Dependents must be a whole number";
    if (parseInt(raw, 10) < 0) return "Number of Dependents must be 0 or greater";
    if (parseInt(raw, 10) > 50) return "Number of Dependents cannot exceed 50";
    return null;
}

function validateProfileFathersName(value) {
    const cleaned = normalizeProfileNamePart(value);
    if (!cleaned) return "Father's Name is required";
    if (cleaned.length < 2 || cleaned.length > 100) {
        return "Father's Name must be 2–100 characters";
    }
    if (!PROFILE_FATHER_NAME.test(cleaned)) {
        return "Father's Name must contain only letters and spaces";
    }
    return null;
}

function validateProfileNationality(value) {
    const code = String(value || "").trim();
    if (!code) return "Nationality is required";
    if (!NATIONALITY_ISO.test(code)) return "Please select a valid nationality from the list";
    return null;
}

export function validateEmployeeProfileBasicDetailsPayload(body = {}) {
    const errors = [];
    const push = (err) => {
        if (err) errors.push(err);
    };

    push(validateProfileNamePart(body.firstName, "First name"));
    push(validateProfileNamePart(body.lastName, "Last name"));
    const combined = `${normalizeProfileNamePart(body.firstName)} ${normalizeProfileNamePart(body.lastName)}`.trim();
    if (combined.length > 100) errors.push("Full name must be no more than 100 characters");

    push(validateProfileEmail(body.email));
    push(validateInternationalPhone(body.contactNumber));
    push(validateProfileDateOfBirth(body.dateOfBirth));
    push(validateProfileMaritalStatus(body.maritalStatus));
    push(validateProfileNumberOfDependents(body.maritalStatus, body.numberOfDependents));
    push(validateProfileFathersName(body.fathersName));
    push(validateProfileNationality(body.nationality || body.country));

    return { ok: errors.length === 0, errors, message: errors[0] || "" };
}

export function normalizeEmployeeProfileBasicDetailsPayload(body = {}) {
    const marital = String(body.maritalStatus || "").trim().toLowerCase();
    return {
        firstName: normalizeProfileNamePart(body.firstName),
        lastName: normalizeProfileNamePart(body.lastName),
        email: stripDangerousText(body.email).toLowerCase(),
        contactNumber: stripDangerousText(body.contactNumber).replace(/\s/g, ""),
        dateOfBirth: body.dateOfBirth || null,
        maritalStatus: marital,
        numberOfDependents:
            marital === "married" && body.numberOfDependents !== undefined && body.numberOfDependents !== null
                ? parseInt(String(body.numberOfDependents), 10)
                : null,
        fathersName: normalizeProfileNamePart(body.fathersName),
        nationality: String(body.nationality || body.country || "").trim().toUpperCase(),
        country: String(body.nationality || body.country || "").trim().toUpperCase(),
    };
}

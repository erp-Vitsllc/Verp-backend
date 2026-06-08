import mongoose from "mongoose";
import Company from "../models/Company.js";

export const EMPLOYEE_ADD_PATTERNS = {
    PERSON_NAME: /^[A-Za-z\s'-]{2,50}$/,
    FATHER_NAME: /^[A-Za-z\s'.-]{2,100}$/,
    EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    ADDRESS: /^[A-Za-z0-9\s#/,.\-]{5,255}$/,
    APARTMENT: /^[A-Za-z0-9\s/-]{1,50}$/,
    CITY: /^[A-Za-z\s'-]{2,100}$/,
    POSTAL_CODE: /^[A-Za-z0-9\s-]{3,20}$/,
    DATE_ISO: /^\d{4}-\d{2}-\d{2}$/,
    SALARY_AMOUNT: /^\d+(\.\d{1,2})?$/,
};

const GENDER_VALUES = ["male", "female", "other"];

export function stripDangerousText(value) {
    if (value === undefined || value === null) return "";
    let str = String(value).trim();
    str = str.replace(/<[^>]*>?/gm, "");
    if (/<|>|javascript:|on\w+=/i.test(str)) return "";
    return str;
}

function parseIsoDate(value) {
    if (!value || !EMPLOYEE_ADD_PATTERNS.DATE_ISO.test(String(value))) return null;
    const [y, m, day] = String(value).split("-").map(Number);
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

export function validateInternationalPhone(phoneNumber) {
    const cleaned = stripDangerousText(phoneNumber).replace(/\s/g, "");
    if (!cleaned) return "Contact number is required";
    if (!/^\+?\d+$/.test(cleaned)) {
        return "Phone number may contain digits only, with optional leading +";
    }
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
        return "Phone number must be between 8 and 15 digits (E.164 standard)";
    }
    return null;
}

export function validateEmployeeAddBody(body) {
    const errors = [];
    const b = body || {};

    const firstName = stripDangerousText(b.firstName);
    const lastName = stripDangerousText(b.lastName);
    if (!EMPLOYEE_ADD_PATTERNS.PERSON_NAME.test(firstName)) {
        errors.push("Invalid first name");
    }
    if (!EMPLOYEE_ADD_PATTERNS.PERSON_NAME.test(lastName)) {
        errors.push("Invalid last name");
    }

    const employeeId = stripDangerousText(b.employeeId).replace(/\s+/g, "").toUpperCase();
    if (!employeeId) errors.push("Employee ID is required");

    if (!b.company || !mongoose.Types.ObjectId.isValid(b.company)) {
        errors.push("Valid company is required");
    }

    const email = stripDangerousText(b.email).toLowerCase();
    if (!email || email.length > 254 || /\.\./.test(email) || !EMPLOYEE_ADD_PATTERNS.EMAIL.test(email)) {
        errors.push("Invalid email");
    }

    const phoneErr = validateInternationalPhone(b.contactNumber);
    if (phoneErr) errors.push(phoneErr);

    const doj = b.dateOfJoining;
    const dojDate = parseIsoDate(doj);
    if (!dojDate) errors.push("Invalid date of joining");
    else {
        if (startOfDay(dojDate) > startOfDay(new Date())) {
            errors.push("Date of joining cannot be in the future");
        }
        if (b.dateOfBirth) {
            const ageAtJoin = calculateAgeOnDate(b.dateOfBirth, doj);
            if (ageAtJoin !== null && ageAtJoin < 18) {
                errors.push("Employee must be at least 18 at joining");
            }
        }
    }

    if (b.contractJoiningDate) {
        const contractDate = parseIsoDate(b.contractJoiningDate);
        if (!contractDate) errors.push("Invalid contract joining date");
        else {
            if (startOfDay(contractDate) > startOfDay(new Date())) {
                errors.push("Contract joining date cannot be in the future");
            }
            if (dojDate && startOfDay(contractDate) < startOfDay(dojDate)) {
                errors.push("Contract joining date cannot be before date of joining");
            }
        }
    }

    const dobDate = parseIsoDate(b.dateOfBirth);
    if (!dobDate) errors.push("Invalid date of birth");
    else {
        const age = calculateAgeOnDate(b.dateOfBirth, todayIso());
        if (age !== null && age < 18) errors.push("Employee must be at least 18 years old");
        if (age !== null && age > 100) errors.push("Employee age must not exceed 100 years");
    }

    const gender = String(b.gender || "").toLowerCase();
    if (!GENDER_VALUES.includes(gender)) errors.push("Invalid gender");

    const fathersName = stripDangerousText(b.fathersName);
    if (!EMPLOYEE_ADD_PATTERNS.FATHER_NAME.test(fathersName)) {
        errors.push("Invalid father's name");
    }

    const addressLine1 = stripDangerousText(b.addressLine1);
    if (!EMPLOYEE_ADD_PATTERNS.ADDRESS.test(addressLine1)) {
        errors.push("Invalid address");
    }

    const addressLine2 = stripDangerousText(b.addressLine2);
    if (!EMPLOYEE_ADD_PATTERNS.APARTMENT.test(addressLine2)) {
        errors.push("Invalid apartment / villa / flat");
    }

    const city = stripDangerousText(b.city);
    if (!EMPLOYEE_ADD_PATTERNS.CITY.test(city)) {
        errors.push("Invalid city");
    }

    const postal = stripDangerousText(b.postalCode);
    if (postal && !EMPLOYEE_ADD_PATTERNS.POSTAL_CODE.test(postal)) {
        errors.push("Invalid postal code");
    }

    const monthlyStr = String(b.monthlySalary ?? "").trim();
    if (!EMPLOYEE_ADD_PATTERNS.SALARY_AMOUNT.test(monthlyStr) || parseFloat(monthlyStr) <= 0) {
        errors.push("Invalid monthly salary");
    }

    const monthly = parseFloat(monthlyStr) || 0;
    const basic = parseFloat(b.basic) || 0;
    const other = parseFloat(b.otherAllowance) || 0;
    const hra = parseFloat(b.houseRentAllowance) || 0;
    const vehicle = parseFloat(b.vehicleAllowance) || 0;
    const fuel = parseFloat(b.fuelAllowance) || 0;
    const additional = Array.isArray(b.additionalAllowances)
        ? b.additionalAllowances.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0)
        : 0;
    const total = basic + other + hra + vehicle + fuel + additional;
    if (Math.abs(total - monthly) > 0.01) {
        errors.push("Salary components must equal monthly salary");
    }

    let pct =
        (parseFloat(b.basicPercentage) || 0) +
        (parseFloat(b.otherPercentage) || 0) +
        (parseFloat(b.houseRentPercentage) || 0) +
        (parseFloat(b.vehiclePercentage) || 0) +
        (parseFloat(b.fuelPercentage) || 0);
    if (Math.abs(pct - 100) > 0.05) {
        errors.push("Salary percentages must total 100%");
    }

    return { errors, normalized: { employeeId, email, firstName, lastName } };
}

export async function assertActiveCompany(companyId) {
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
        return "Invalid company";
    }
    const company = await Company.findById(companyId).select("status").lean();
    if (!company) return "Company not found";
    if (String(company.status || "").toLowerCase() !== "active") {
        return "Only active companies can be selected";
    }
    return null;
}

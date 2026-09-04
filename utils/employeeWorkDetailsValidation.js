import mongoose from "mongoose";
import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import Company from "../models/Company.js";
import Department from "../models/Department.js";
import Designation from "../models/Designation.js";

export const WORK_STATUS_VALUES = ["Probation", "Permanent", "Temporary", "Notice", "Left User"];

export const WORK_STATUS_DIRECT_EDIT_BLOCKED = [
    "Notice",
    "Left User",
    "Termination",
    "Resignation",
];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 100;

function parseIsoDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
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

function normalizeEmail(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function validateCompanyEmailUnique(email, { skipEmployeeId = "" } = {}) {
    if (!email) return null;
    const existingEmp = await EmployeeBasic.findOne({
        employeeId: { $ne: skipEmployeeId },
        companyEmail: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    }).select("employeeId").lean();
    if (existingEmp) return "Company email must be unique";
    const existingUser = await User.findOne({
        companyEmail: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
        ...(skipEmployeeId ? { employeeId: { $ne: skipEmployeeId } } : {}),
    }).select("_id").lean();
    if (existingUser) return "Company email must be unique";
    return null;
}

export async function validateEmployeeWorkDetailsPayload(payload = {}, { employee = null, employeeId = "" } = {}) {
    const p = payload || {};
    const skipId = employeeId || employee?.employeeId || "";

    if (p.companyEmail !== undefined && p.companyEmail !== null && String(p.companyEmail).trim()) {
        const email = normalizeEmail(p.companyEmail);
        if (email.length > MAX_EMAIL_LENGTH) return { ok: false, message: "Company email must be no more than 100 characters" };
        if (!EMAIL_REGEX.test(email)) return { ok: false, message: "Please enter a valid email address" };
        const currentEmail = normalizeEmail(employee?.companyEmail || "");
        if (email !== currentEmail) {
            const uniqueErr = await validateCompanyEmailUnique(email, { skipEmployeeId: skipId });
            if (uniqueErr) return { ok: false, message: uniqueErr };
        }
    }

    if (p.dateOfJoining !== undefined) {
        if (!p.dateOfJoining) return { ok: false, message: "Date of Joining is required" };
        const doj = parseIsoDate(p.dateOfJoining);
        if (!doj) return { ok: false, message: "Date of Joining must be a valid date" };
        if (startOfDay(doj) > startOfDay(new Date())) {
            return { ok: false, message: "Date of Joining cannot be in the future" };
        }
        const dob = employee?.dateOfBirth || p.dateOfBirth;
        if (dob) {
            const age = calculateAgeOnDate(dob, p.dateOfJoining);
            if (age !== null && age < 18) {
                return { ok: false, message: "Employee must be at least 18 years old on the joining date" };
            }
        }
    }

    if (p.contractJoiningDate !== undefined && p.contractJoiningDate !== null && String(p.contractJoiningDate).trim() !== "") {
        const cjd = parseIsoDate(p.contractJoiningDate);
        if (!cjd) return { ok: false, message: "Contract Joining Date must be a valid date" };
        if (startOfDay(cjd) > startOfDay(new Date())) {
            return { ok: false, message: "Contract Joining Date cannot be in the future" };
        }
    }

    if (p.company !== undefined) {
        if (!p.company || !mongoose.Types.ObjectId.isValid(p.company)) {
            return { ok: false, message: "Valid company is required" };
        }
    }

    const needsCompany = p.company !== undefined && p.company && mongoose.Types.ObjectId.isValid(p.company);
    const needsDepartment = p.department !== undefined;
    const needsDesignation = p.designation !== undefined;
    const needsReportingManager = Boolean(p.reportingAuthority ?? employee?.reportingAuthority);

    const [companyDoc, deptDoc, desigDoc, mgrDoc] = await Promise.all([
        needsCompany
            ? Company.findById(p.company).select("status name").lean()
            : Promise.resolve(null),
        needsDepartment
            ? Department.findOne({ name: String(p.department).trim() }).select("status").lean()
            : Promise.resolve(null),
        needsDesignation
            ? Designation.findOne({ name: String(p.designation).trim() }).select("department status").lean()
            : Promise.resolve(null),
        needsReportingManager
            ? EmployeeBasic.findById(p.reportingAuthority ?? employee?.reportingAuthority)
                .select("employeeId profileStatus")
                .lean()
            : Promise.resolve(null),
    ]);

    if (needsCompany) {
        if (!companyDoc) return { ok: false, message: "Selected company does not exist" };
        if (String(companyDoc.status || "").toLowerCase() !== "active") {
            return { ok: false, message: "Only active companies can be selected" };
        }
    }

    if (needsDepartment) {
        if (!String(p.department || "").trim()) return { ok: false, message: "Department is required" };
        if (!deptDoc) return { ok: false, message: "Invalid department selected" };
        if (deptDoc.status && String(deptDoc.status).toLowerCase() !== "active") {
            return { ok: false, message: "Only active departments can be selected" };
        }
    }

    if (needsDesignation) {
        const designationName = String(p.designation || "").trim();
        if (!designationName) return { ok: false, message: "Designation is required" };
        if (!desigDoc) return { ok: false, message: "Invalid designation selected" };
        if (desigDoc.status && String(desigDoc.status).toLowerCase() === "inactive") {
            return { ok: false, message: "Only active designations can be selected" };
        }
        if (p.department && desigDoc.department && String(desigDoc.department).trim().toLowerCase() !== String(p.department).trim().toLowerCase()) {
            return { ok: false, message: "Designation must belong to the selected department" };
        }
    }

    if (p.status !== undefined) {
        if (!WORK_STATUS_VALUES.includes(p.status)) return { ok: false, message: "Invalid work status" };
    }

    const selfId = employee?._id ? String(employee._id) : "";
    const selfEmpId = employee?.employeeId || skipId;

    const reportingAuthority = p.reportingAuthority ?? employee?.reportingAuthority;
    if (reportingAuthority) {
        const ra = String(reportingAuthority);
        if (selfId && ra === selfId) return { ok: false, message: "Employee cannot report to themselves" };
        if (!mgrDoc) return { ok: false, message: "Reporting manager must exist in the system" };
        if (mgrDoc.employeeId === selfEmpId) return { ok: false, message: "Employee cannot report to themselves" };
    }

    const dept = String(p.department || employee?.department || "").trim().toLowerCase();
    const isManagement = dept === "management";

    if (p.primaryReportee !== undefined) {
        if (!isManagement && !p.primaryReportee) {
            return { ok: false, message: "Primary Reportee is required" };
        }
        if (p.primaryReportee) {
            const pr = String(p.primaryReportee);
            if (selfId && pr === selfId) return { ok: false, message: "Employee cannot be selected as their own reportee" };
        }
    }

    if (p.secondaryReportee && p.primaryReportee && String(p.secondaryReportee) === String(p.primaryReportee)) {
        return { ok: false, message: "Secondary Reportee cannot be the same as Primary Reportee" };
    }
    if (p.secondaryReportee && selfId && String(p.secondaryReportee) === selfId) {
        return { ok: false, message: "Employee cannot be selected as their own reportee" };
    }

    if (p.enablePortalAccess === undefined && employee && employee.enablePortalAccess === undefined) {
        return { ok: false, message: "Portal Access is required" };
    }

    return { ok: true };
}

import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeeContact from "../models/EmployeeContact.js";
import EmployeePersonal from "../models/EmployeePersonal.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeSalary from "../models/EmployeeSalary.js";
import EmployeeBank from "../models/EmployeeBank.js";
import EmployeeEmergencyContact from "../models/EmployeeEmergencyContact.js";
import { calculateProfileCompletionBackend } from "./calculateProfileCompletionBackend.js";
import { isEmployeeProfileLiveActive } from "./employeeDocumentRenewal.js";
import {
    buildProfileActivationEntityLine,
    buildProfileIncompleteMessage,
} from "./employeeProfileNotificationMessages.js";

const CACHE_TTL_MS = 45 * 1000;
const QUERY_MS = 15000;

let cachedItems = null;
let cachedAt = 0;
let inFlight = null;

function indexByEmployeeId(rows) {
    const map = new Map();
    for (const row of rows || []) {
        const raw = String(row?.employeeId || "").trim();
        if (!raw) continue;
        map.set(raw, row);
        map.set(raw.toLowerCase(), row);
        map.set(raw.replace(/\s+/g, "").toLowerCase(), row);
    }
    return map;
}

function pickRow(map, employeeId) {
    const raw = String(employeeId || "").trim();
    if (!raw || !map) return null;
    return (
        map.get(raw) ||
        map.get(raw.toLowerCase()) ||
        map.get(raw.replace(/\s+/g, "").toLowerCase()) ||
        null
    );
}

function fileRef(url, hasData) {
    if (url) return { url };
    if (hasData) return { data: "stored" };
    return undefined;
}

function shapeForCompletion(emp, bags) {
    const id = emp.employeeId;
    const contact = pickRow(bags.contact, id);
    const personal = pickRow(bags.personal, id);
    const passport = pickRow(bags.passport, id);
    const visa = pickRow(bags.visa, id);
    const eid = pickRow(bags.eid, id);
    const labour = pickRow(bags.labour, id);
    const salary = pickRow(bags.salary, id);
    const bank = pickRow(bags.bank, id);
    const emergency = pickRow(bags.emergency, id);

    const salaryHistory = Array.isArray(salary?.salaryHistory)
        ? salary.salaryHistory.map((entry) => ({
              fromDate: entry.fromDate,
              toDate: entry.toDate,
              month: entry.month,
              basic: entry.basic,
              offerLetter: fileRef(entry.offerLetterUrl, entry.hasOfferLetterData),
          }))
        : [];

    return {
        employeeId: emp.employeeId,
        firstName: emp.firstName,
        lastName: emp.lastName,
        email: emp.email,
        companyEmail: emp.companyEmail,
        status: emp.status,
        probationPeriod: emp.probationPeriod,
        profilePicture: emp.profilePicture,
        profileStatus: emp.profileStatus,
        profileApprovalStatus: emp.profileApprovalStatus,
        company: emp.company,
        dateOfJoining: emp.dateOfJoining,
        primaryReportee: emp.primaryReportee,
        department: emp.department,
        designation: emp.designation,
        updatedAt: emp.updatedAt,
        createdAt: emp.createdAt,
        contactNumber: contact?.contactNumber,
        country: contact?.country,
        gender: personal?.gender,
        dateOfBirth: personal?.dateOfBirth,
        maritalStatus: personal?.maritalStatus,
        numberOfDependents: personal?.numberOfDependents,
        nationality: personal?.nationality,
        fathersName: personal?.fathersName,
        passportDetails: passport
            ? {
                  number: passport.number,
                  nationality: passport.nationality,
                  issueDate: passport.issueDate,
                  expiryDate: passport.expiryDate,
                  placeOfIssue: passport.placeOfIssue,
              }
            : undefined,
        visaDetails: visa
            ? {
                  visit: visa.visit,
                  employment: visa.employment,
                  spouse: visa.spouse,
              }
            : undefined,
        emiratesIdDetails: eid?.emiratesId
            ? {
                  number: eid.emiratesId.number,
                  issueDate: eid.emiratesId.issueDate,
                  expiryDate: eid.emiratesId.expiryDate,
              }
            : undefined,
        labourCardDetails: labour
            ? {
                  number: labour.number,
                  issueDate: labour.issueDate,
                  expiryDate: labour.expiryDate,
                  noticePeriodMonths: labour.noticePeriodMonths ?? null,
                  document: labour.hasDocument ? { url: "stored" } : undefined,
                  labourContractAttachment: labour.hasContract ? { url: "stored" } : undefined,
              }
            : undefined,
        basic: salary?.basic || 0,
        salaryHistory,
        offerLetter: fileRef(salary?.offerLetterUrl, salary?.hasOfferLetterData),
        bankName: bank?.bankName,
        accountName: bank?.accountName,
        accountNumber: bank?.accountNumber,
        ibanNumber: bank?.ibanNumber,
        emergencyContacts: Array.isArray(emergency?.emergencyContacts) ? emergency.emergencyContacts : [],
        emergencyContactName: emergency?.emergencyContactName,
        emergencyContactNumber: emergency?.emergencyContactNumber,
        signature:
            emp.signature?.url || emp.signature?.name
                ? { url: emp.signature?.url, name: emp.signature?.name }
                : undefined,
    };
}

async function loadIncompleteProfiles() {
    const employees = await EmployeeBasic.find({
        profileStatus: { $in: ["active", "Active"] },
        profileApprovalStatus: { $in: ["active", "Active"] },
    })
        .select({
            employeeId: 1,
            firstName: 1,
            lastName: 1,
            email: 1,
            companyEmail: 1,
            status: 1,
            probationPeriod: 1,
            profilePicture: 1,
            profileStatus: 1,
            profileApprovalStatus: 1,
            company: 1,
            dateOfJoining: 1,
            primaryReportee: 1,
            department: 1,
            designation: 1,
            "signature.url": 1,
            "signature.name": 1,
            updatedAt: 1,
            createdAt: 1,
        })
        .lean()
        .maxTimeMS(QUERY_MS);

    const live = employees.filter((emp) => isEmployeeProfileLiveActive(emp) && emp.employeeId);
    const employeeIds = live.map((emp) => emp.employeeId);
    if (employeeIds.length === 0) return [];

    const match = { employeeId: { $in: employeeIds } };
    const [
        contacts,
        personals,
        passports,
        visas,
        emiratesIds,
        labourCards,
        salaries,
        banks,
        emergencies,
    ] = await Promise.all([
        EmployeeContact.find(match)
            .select({ employeeId: 1, contactNumber: 1, country: 1 })
            .lean()
            .maxTimeMS(QUERY_MS),
        EmployeePersonal.find(match)
            .select({
                employeeId: 1,
                gender: 1,
                dateOfBirth: 1,
                maritalStatus: 1,
                numberOfDependents: 1,
                nationality: 1,
                fathersName: 1,
            })
            .lean()
            .maxTimeMS(QUERY_MS),
        EmployeePassport.find(match)
            .select({
                employeeId: 1,
                number: 1,
                nationality: 1,
                issueDate: 1,
                expiryDate: 1,
                placeOfIssue: 1,
            })
            .lean()
            .maxTimeMS(QUERY_MS),
        EmployeeVisa.find(match)
            .select({
                employeeId: 1,
                "visit.number": 1,
                "visit.issueDate": 1,
                "visit.expiryDate": 1,
                "visit.sponsor": 1,
                "employment.number": 1,
                "employment.issueDate": 1,
                "employment.expiryDate": 1,
                "employment.sponsor": 1,
                "spouse.number": 1,
                "spouse.issueDate": 1,
                "spouse.expiryDate": 1,
                "spouse.sponsor": 1,
            })
            .lean()
            .maxTimeMS(QUERY_MS),
        EmployeeEmiratesId.find(match)
            .select({
                employeeId: 1,
                "emiratesId.number": 1,
                "emiratesId.issueDate": 1,
                "emiratesId.expiryDate": 1,
            })
            .lean()
            .maxTimeMS(QUERY_MS),
        EmployeeLabourCard.aggregate([
            { $match: match },
            {
                $project: {
                    employeeId: 1,
                    number: "$labourCard.number",
                    issueDate: "$labourCard.issueDate",
                    expiryDate: "$labourCard.expiryDate",
                    noticePeriodMonths: "$labourCard.noticePeriodMonths",
                    hasDocument: {
                        $or: [
                            { $gt: [{ $strLenCP: { $ifNull: ["$labourCard.document.url", ""] } }, 0] },
                            { $gt: [{ $strLenCP: { $ifNull: ["$labourCard.document.data", ""] } }, 0] },
                        ],
                    },
                    hasContract: {
                        $or: [
                            {
                                $gt: [
                                    { $strLenCP: { $ifNull: ["$labourCard.labourContractAttachment.url", ""] } },
                                    0,
                                ],
                            },
                            {
                                $gt: [
                                    { $strLenCP: { $ifNull: ["$labourCard.labourContractAttachment.data", ""] } },
                                    0,
                                ],
                            },
                        ],
                    },
                },
            },
        ]).option({ maxTimeMS: QUERY_MS }),
        EmployeeSalary.aggregate([
            { $match: match },
            {
                $project: {
                    employeeId: 1,
                    basic: 1,
                    offerLetterUrl: "$offerLetter.url",
                    hasOfferLetterData: {
                        $gt: [{ $strLenCP: { $ifNull: ["$offerLetter.data", ""] } }, 0],
                    },
                    salaryHistory: {
                        $map: {
                            input: { $ifNull: ["$salaryHistory", []] },
                            as: "entry",
                            in: {
                                fromDate: "$$entry.fromDate",
                                toDate: "$$entry.toDate",
                                month: "$$entry.month",
                                basic: "$$entry.basic",
                                offerLetterUrl: "$$entry.offerLetter.url",
                                hasOfferLetterData: {
                                    $gt: [{ $strLenCP: { $ifNull: ["$$entry.offerLetter.data", ""] } }, 0],
                                },
                            },
                        },
                    },
                },
            },
        ]).option({ maxTimeMS: QUERY_MS }),
        EmployeeBank.find(match)
            .select({
                employeeId: 1,
                bankName: 1,
                accountName: 1,
                accountNumber: 1,
                ibanNumber: 1,
            })
            .lean()
            .maxTimeMS(QUERY_MS),
        EmployeeEmergencyContact.find(match)
            .select({
                employeeId: 1,
                "emergencyContacts.name": 1,
                "emergencyContacts.number": 1,
                emergencyContactName: 1,
                emergencyContactNumber: 1,
            })
            .lean()
            .maxTimeMS(QUERY_MS),
    ]);

    const bags = {
        contact: indexByEmployeeId(contacts),
        personal: indexByEmployeeId(personals),
        passport: indexByEmployeeId(passports),
        visa: indexByEmployeeId(visas),
        eid: indexByEmployeeId(emiratesIds),
        labour: indexByEmployeeId(labourCards),
        salary: indexByEmployeeId(salaries),
        bank: indexByEmployeeId(banks),
        emergency: indexByEmployeeId(emergencies),
    };

    const items = [];
    for (const emp of live) {
        const complete = shapeForCompletion(emp, bags);
        const { percentage } = calculateProfileCompletionBackend(complete);
        if (!Number.isFinite(percentage) || percentage >= 100) continue;

        const displayName =
            `${complete.firstName || ""} ${complete.lastName || ""}`.trim() ||
            complete.employeeId ||
            "Unknown Employee";
        const empKey = complete.employeeId || String(emp._id);

        items.push({
            id: emp._id,
            type: "Profile Incomplete",
            requestedBy: "System",
            requestedDate: complete.updatedAt || emp.updatedAt || emp.createdAt || new Date(),
            actionedDate: null,
            status: "Pending",
            extra1: buildProfileIncompleteMessage({
                employeeName: displayName,
                employeeId: empKey,
            }),
            extra2: buildProfileActivationEntityLine(displayName, empKey),
            subjectName: displayName,
            extra3: JSON.stringify({ kind: "mandatory-cards" }),
            targetEmployeeId: empKey,
            scope: "inbox",
        });
    }

    return items;
}

/** Incomplete mandatory-card rows for Flowchart HR. Bulk-loaded, not one full profile per employee. */
export async function collectIncompleteMandatoryProfileItems() {
    if (cachedItems && Date.now() - cachedAt < CACHE_TTL_MS) {
        return cachedItems;
    }
    if (inFlight) return inFlight;

    inFlight = loadIncompleteProfiles()
        .then((items) => {
            cachedItems = items;
            cachedAt = Date.now();
            return items;
        })
        .finally(() => {
            inFlight = null;
        });

    return inFlight;
}

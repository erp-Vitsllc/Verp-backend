import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import EmployeeSalary from "../models/EmployeeSalary.js";
import EmployeeBank from "../models/EmployeeBank.js";
import DashboardAction from "../models/DashboardAction.js";
import { normalizeArchivedDocumentStorageRef } from "./archiveEmployeeDocument.js";

const ARCHIVE_PREFIX = "Left User Return";
const VISA_TYPES = ["visit", "employment", "spouse"];

const hasStoredDocumentFile = (document) =>
    Boolean(
        document &&
            ((typeof document.url === "string" && document.url.trim() !== "") ||
                (typeof document.data === "string" && document.data.trim() !== "") ||
                (typeof document.publicId === "string" && document.publicId.trim() !== "")),
    );

const asPlainDocument = (doc) => {
    if (!doc) return null;
    const plain = doc.toObject ? doc.toObject() : { ...doc };
    return normalizeArchivedDocumentStorageRef(plain) || plain;
};

const archiveDescription = (detail = "") => {
    const trimmed = String(detail || "").trim();
    return trimmed ? `${ARCHIVE_PREFIX} - ${trimmed}` : ARCHIVE_PREFIX;
};

const pushOldDocumentRow = (employeeDoc, row) => {
    if (!employeeDoc.oldDocuments) employeeDoc.oldDocuments = [];
    employeeDoc.oldDocuments.push({
        ...row,
        archivedAt: new Date(),
        archiveReason: "Replaced",
    });
};

const hasIdentitySectionData = (details = {}) =>
    Boolean(
        String(details.number || "").trim() ||
            String(details.provider || "").trim() ||
            details.issueDate ||
            details.expiryDate ||
            hasStoredDocumentFile(details.document) ||
            hasStoredDocumentFile(details.labourContractAttachment),
    );

const formatSalaryPeriod = (entry) => {
    if (entry?.month && String(entry.month).trim()) return String(entry.month).trim();
    const from = entry?.fromDate ? new Date(entry.fromDate) : null;
    if (from && !Number.isNaN(from.getTime())) {
        return from.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    return "Salary";
};

const salaryDescription = (entry) =>
    `Basic: ${entry.basic ?? 0}, HRA: ${entry.houseRentAllowance ?? 0}, Vehicle: ${entry.vehicleAllowance ?? 0}, Fuel: ${entry.fuelAllowance ?? 0}, Other: ${entry.otherAllowance ?? 0}, Total: ${entry.totalSalary ?? 0}`;

const hasSalaryEntryData = (entry = {}) =>
    (Number(entry.basic) || 0) > 0 ||
    (Number(entry.houseRentAllowance) || 0) > 0 ||
    (Number(entry.otherAllowance) || 0) > 0 ||
    (Number(entry.vehicleAllowance) || 0) > 0 ||
    (Number(entry.fuelAllowance) || 0) > 0 ||
    (Number(entry.totalSalary) || 0) > 0 ||
    hasStoredDocumentFile(entry.offerLetter) ||
    hasStoredDocumentFile(entry.attachment);

/**
 * Move live profile documents to oldDocuments and clear partition collections
 * so the returned employee starts with empty live cards.
 */
export async function archiveEmployeeProfileForLeftUserReturn(employeeDoc) {
    const employeeId = employeeDoc?.employeeId;
    if (!employeeId) return;

    const [
        passport,
        visa,
        emiratesId,
        labourCard,
        medicalInsurance,
        drivingLicense,
        salary,
        bank,
    ] = await Promise.all([
        EmployeePassport.findOne({ employeeId }),
        EmployeeVisa.findOne({ employeeId }),
        EmployeeEmiratesId.findOne({ employeeId }),
        EmployeeLabourCard.findOne({ employeeId }),
        EmployeeMedicalInsurance.findOne({ employeeId }),
        EmployeeDrivingLicense.findOne({ employeeId }),
        EmployeeSalary.findOne({ employeeId }),
        EmployeeBank.findOne({ employeeId }),
    ]);

    if (
        passport &&
        (String(passport.number || "").trim() ||
            passport.issueDate ||
            passport.expiryDate ||
            hasStoredDocumentFile(passport.document))
    ) {
        pushOldDocumentRow(employeeDoc, {
            type: "Previous Passport",
            description: archiveDescription(passport.number ? `Passport No: ${passport.number}` : "Passport"),
            issueDate: passport.issueDate || passport.lastUpdated || null,
            expiryDate: passport.expiryDate || null,
            document: asPlainDocument(passport.document),
        });
    }

    if (visa) {
        for (const visaType of VISA_TYPES) {
            const details = visa[visaType];
            if (!hasIdentitySectionData(details)) continue;
            const visaLabel = `${visaType.charAt(0).toUpperCase() + visaType.slice(1)} Visa`;
            pushOldDocumentRow(employeeDoc, {
                type: `Previous ${visaLabel}`,
                description: archiveDescription(details.number ? `Visa No: ${details.number}` : visaLabel),
                issueDate: details.issueDate || details.lastUpdated || null,
                expiryDate: details.expiryDate || null,
                document: asPlainDocument(details.document),
            });
        }
    }

    const emiratesDetails = emiratesId?.emiratesId;
    if (hasIdentitySectionData(emiratesDetails)) {
        pushOldDocumentRow(employeeDoc, {
            type: "Previous Emirates ID",
            description: archiveDescription(
                emiratesDetails.number ? `Emirates ID No: ${emiratesDetails.number}` : "Emirates ID",
            ),
            issueDate: emiratesDetails.issueDate || emiratesDetails.lastUpdated || null,
            expiryDate: emiratesDetails.expiryDate || null,
            document: asPlainDocument(emiratesDetails.document),
        });
    }

    const labourDetails = labourCard?.labourCard;
    if (hasIdentitySectionData(labourDetails)) {
        pushOldDocumentRow(employeeDoc, {
            type: "Previous Labour Card",
            description: archiveDescription(
                labourDetails.number ? `Labour Card No: ${labourDetails.number}` : "Labour Card",
            ),
            issueDate: labourDetails.issueDate || labourDetails.lastUpdated || null,
            expiryDate: labourDetails.expiryDate || null,
            document: asPlainDocument(labourDetails.document),
        });
        if (hasStoredDocumentFile(labourDetails.labourContractAttachment)) {
            pushOldDocumentRow(employeeDoc, {
                type: "Previous Labour Contract",
                description: archiveDescription(
                    labourDetails.number
                        ? `Labour Contract (Labour Card No: ${labourDetails.number})`
                        : "Labour Contract",
                ),
                issueDate: labourDetails.issueDate || labourDetails.lastUpdated || null,
                expiryDate: labourDetails.expiryDate || null,
                document: asPlainDocument(labourDetails.labourContractAttachment),
            });
        }
    }

    const medicalDetails = medicalInsurance?.medicalInsurance;
    if (hasIdentitySectionData(medicalDetails)) {
        pushOldDocumentRow(employeeDoc, {
            type: "Previous Medical Insurance",
            description: archiveDescription(
                medicalDetails.number
                    ? `Policy No: ${medicalDetails.number}`
                    : String(medicalDetails.provider || "Medical Insurance"),
            ),
            issueDate: medicalDetails.issueDate || medicalDetails.lastUpdated || null,
            expiryDate: medicalDetails.expiryDate || null,
            document: asPlainDocument(medicalDetails.document),
        });
    }

    const drivingDetails = drivingLicense?.drivingLicenceDetails;
    if (hasIdentitySectionData(drivingDetails)) {
        pushOldDocumentRow(employeeDoc, {
            type: "Previous Driving License",
            description: archiveDescription(
                drivingDetails.number ? `License No: ${drivingDetails.number}` : "Driving License",
            ),
            issueDate: drivingDetails.issueDate || drivingDetails.lastUpdated || null,
            expiryDate: drivingDetails.expiryDate || null,
            document: asPlainDocument(drivingDetails.document),
        });
    }

    if (salary) {
        const history = Array.isArray(salary.salaryHistory) ? salary.salaryHistory : [];
        const archivedOfferFingerprints = new Set();

        for (const entry of history) {
            if (!hasSalaryEntryData(entry)) continue;
            const period = formatSalaryPeriod(entry);
            const resolvedDoc = asPlainDocument(entry.offerLetter || entry.attachment);
            pushOldDocumentRow(employeeDoc, {
                type: `Previous Salary (${period})`,
                description: archiveDescription(salaryDescription(entry)),
                issueDate: entry.fromDate || null,
                expiryDate: entry.toDate || null,
                basicSalary: entry.basic ?? null,
                houseRentAllowance: entry.houseRentAllowance ?? null,
                vehicleAllowance: entry.vehicleAllowance ?? null,
                fuelAllowance: entry.fuelAllowance ?? null,
                otherAllowance: entry.otherAllowance ?? null,
                totalSalary: entry.totalSalary ?? null,
                document: resolvedDoc,
            });
            const fp =
                (resolvedDoc?.url || resolvedDoc?.data || "").slice(0, 120) ||
                `period:${period}`;
            archivedOfferFingerprints.add(fp);
        }

        if (hasStoredDocumentFile(salary.offerLetter)) {
            const offerFp = (salary.offerLetter?.url || salary.offerLetter?.data || "").slice(0, 120);
            if (!archivedOfferFingerprints.has(offerFp)) {
                pushOldDocumentRow(employeeDoc, {
                    type: "Previous Salary (Offer Letter)",
                    description: archiveDescription(salary.offerLetter?.name || "Salary offer letter"),
                    document: asPlainDocument(salary.offerLetter),
                });
            }
        }

        const hasTopLevelSalary =
            (Number(salary.basic) || 0) > 0 ||
            (Number(salary.houseRentAllowance) || 0) > 0 ||
            (Number(salary.otherAllowance) || 0) > 0 ||
            (Number(salary.totalSalary) || 0) > 0;

        if (history.length === 0 && hasTopLevelSalary) {
            pushOldDocumentRow(employeeDoc, {
                type: "Previous Salary (Salary)",
                description: archiveDescription(
                    `Basic: ${salary.basic ?? 0}, HRA: ${salary.houseRentAllowance ?? 0}, Other: ${salary.otherAllowance ?? 0}, Total: ${salary.totalSalary ?? 0}`,
                ),
                basicSalary: salary.basic ?? null,
                houseRentAllowance: salary.houseRentAllowance ?? null,
                vehicleAllowance: salary.vehicleAllowance ?? null,
                fuelAllowance: salary.fuelAllowance ?? null,
                otherAllowance: salary.otherAllowance ?? null,
                totalSalary: salary.totalSalary ?? null,
                document: asPlainDocument(salary.offerLetter),
            });
        }
    }

    if (bank) {
        const hasBankData =
            Boolean(String(bank.bankName || "").trim()) ||
            Boolean(String(bank.accountNumber || bank.ibanNumber || "").trim()) ||
            hasStoredDocumentFile(bank.bankAttachment);

        if (hasBankData) {
            const accountRef = bank.accountNumber || bank.ibanNumber || "";
            pushOldDocumentRow(employeeDoc, {
                type: "Previous Bank Details",
                description: archiveDescription(
                    `Bank: ${bank.bankName || ""}${accountRef ? ` | A/C: ${accountRef}` : ""}`.trim(),
                ),
                bankName: bank.bankName || null,
                accountNumber: accountRef || null,
                issueDate: bank.updatedAt || bank.createdAt || null,
                document: asPlainDocument(bank.bankAttachment),
            });
        }
    }

    const signature = employeeDoc.signature;
    if (signature && typeof signature === "object") {
        const archivedSignature = asPlainDocument(signature);
        const hasSignatureFile = Boolean(
            archivedSignature?.url || archivedSignature?.data || archivedSignature?.publicId,
        );
        if (hasSignatureFile || signature.signedAt || signature.name) {
            pushOldDocumentRow(employeeDoc, {
                type: "Digital Signature",
                description: archiveDescription(
                    signature.name ? `Signature: ${signature.name}` : "Digital Signature",
                ),
                issueDate: signature.signedAt || null,
                expiryDate: null,
                document: hasSignatureFile ? archivedSignature : null,
            });
        }
        employeeDoc.signature = undefined;
        employeeDoc.markModified("signature");
    }

    const manualDocuments = Array.isArray(employeeDoc.documents) ? [...employeeDoc.documents] : [];
    for (const source of manualDocuments) {
        const plain = source?.toObject ? source.toObject() : { ...source };
        pushOldDocumentRow(employeeDoc, {
            type: plain.type || "Document",
            description: archiveDescription(plain.description || plain.type || "Document"),
            issueDate: plain.issueDate || null,
            expiryDate: plain.expiryDate || null,
            cost: plain.cost ?? null,
            basicSalary: plain.basicSalary ?? null,
            houseRentAllowance: plain.houseRentAllowance ?? null,
            vehicleAllowance: plain.vehicleAllowance ?? null,
            fuelAllowance: plain.fuelAllowance ?? null,
            otherAllowance: plain.otherAllowance ?? null,
            totalSalary: plain.totalSalary ?? null,
            createdAt: plain.createdAt || null,
            document: asPlainDocument(plain.document),
        });
    }
    employeeDoc.documents = [];
    employeeDoc.markModified("documents");

    employeeDoc.pendingNotRenewRequests = [];
    employeeDoc.pendingReactivationChanges = [];
    employeeDoc.markModified("oldDocuments");

    await Promise.all([
        EmployeePassport.deleteOne({ employeeId }),
        EmployeeVisa.deleteOne({ employeeId }),
        EmployeeEmiratesId.deleteOne({ employeeId }),
        EmployeeLabourCard.deleteOne({ employeeId }),
        EmployeeMedicalInsurance.deleteOne({ employeeId }),
        EmployeeDrivingLicense.deleteOne({ employeeId }),
        EmployeeSalary.deleteOne({ employeeId }),
        EmployeeBank.deleteOne({ employeeId }),
    ]);

    await DashboardAction.deleteMany({
        requestId: employeeDoc._id,
        requestType: { $in: ["Employee Document Expiry Reminder", "Document Expiry Reminder"] },
        status: "Pending",
    });
}

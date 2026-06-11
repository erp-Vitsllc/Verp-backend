import EmployeeBank from "../models/EmployeeBank.js";
import { archiveEmployeeDocument } from "./archiveEmployeeDocument.js";

const BANK_KEYS = [
    "bankName",
    "accountName",
    "accountNumber",
    "ibanNumber",
    "swiftCode",
    "bankOtherDetails",
    "bankAttachment",
];

const attachmentFingerprint = (att) => {
    if (!att || typeof att !== "object") return "";
    const url = typeof att.url === "string" ? att.url.trim() : "";
    if (url) return `url:${url}`;
    const data = typeof att.data === "string" ? att.data.trim() : "";
    return data ? `data:${data.slice(0, 120)}` : "";
};

const hasPreviousBankData = (bank) =>
    Boolean(
        bank &&
            (String(bank.bankName || "").trim() ||
                String(bank.accountNumber || "").trim() ||
                String(bank.ibanNumber || "").trim() ||
                bank.bankAttachment?.url ||
                bank.bankAttachment?.data),
    );

export function bankUpdateTouchesFields(proposed = {}) {
    return BANK_KEYS.some((k) => Object.prototype.hasOwnProperty.call(proposed, k));
}

export function bankDetailsWereSuperseded(previousBank = {}, proposedBank = {}) {
    if (!hasPreviousBankData(previousBank)) return false;

    for (const k of [
        "bankName",
        "accountName",
        "accountNumber",
        "ibanNumber",
        "swiftCode",
        "bankOtherDetails",
    ]) {
        if (!Object.prototype.hasOwnProperty.call(proposedBank, k)) continue;
        if (String(proposedBank[k] ?? "").trim() !== String(previousBank[k] ?? "").trim()) {
            return true;
        }
    }

    if (Object.prototype.hasOwnProperty.call(proposedBank, "bankAttachment")) {
        const prevFp = attachmentFingerprint(previousBank.bankAttachment);
        const nextFp = attachmentFingerprint(proposedBank.bankAttachment);
        if (prevFp !== nextFp) return true;
    }

    return false;
}

const buildBankArchiveDescription = (bank) => {
    const parts = [];
    if (bank?.bankName) parts.push(`Bank: ${bank.bankName}`);
    if (bank?.accountNumber) parts.push(`A/C: ${bank.accountNumber}`);
    if (bank?.ibanNumber) parts.push(`IBAN: ${bank.ibanNumber}`);
    if (bank?.accountName) parts.push(`Account Name: ${bank.accountName}`);
    return parts.join(" | ") || "Previous bank details";
};

/**
 * When bank details or attachment change, archive the previous bank record to oldDocuments.
 */
export async function archiveSupersededBankIfNeeded(employeeId, proposedBank = {}, previousBank = null) {
    if (!employeeId || !bankUpdateTouchesFields(proposedBank)) {
        return { archived: false };
    }

    let prior = previousBank;
    if (!prior) {
        prior = await EmployeeBank.findOne({ employeeId })
            .select(
                "bankName accountName accountNumber ibanNumber swiftCode bankOtherDetails bankAttachment",
            )
            .lean();
    }

    if (!bankDetailsWereSuperseded(prior, proposedBank)) {
        return { archived: false };
    }

    const att = prior?.bankAttachment;
    const hasFile = Boolean(att?.url || att?.data);

    await archiveEmployeeDocument({
        employeeId,
        type: "Previous Bank Details",
        description: buildBankArchiveDescription(prior),
        bankName: prior?.bankName || null,
        accountNumber: prior?.accountNumber || prior?.ibanNumber || null,
        issueDate: null,
        expiryDate: null,
        document: hasFile ? att : null,
    });

    return { archived: true };
}

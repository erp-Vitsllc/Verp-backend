import { notifyCardDeletedProgressUpdated } from "./notifyCardDeletedProgressUpdated.js";

export function scheduleCompanyCardDeletedNotification(
    req,
    company,
    { cardLabel, cardKey, progressPercentage = null } = {},
) {
    void notifyCardDeletedProgressUpdated({
        req,
        entityType: "company",
        entityMongoId: company?._id,
        entityDisplayId: company?.companyId || String(company?._id || ""),
        entityName: company?.name || "",
        cardLabel: cardLabel || "Card",
        cardKey: cardKey || "",
        progressPercentage,
    });
}

export function scheduleEmployeeCardDeletedNotification(
    req,
    employee,
    { cardLabel, cardKey } = {},
) {
    void notifyCardDeletedProgressUpdated({
        req,
        entityType: "employee",
        entityMongoId: employee?._id,
        entityDisplayId: employee?.employeeId || String(employee?._id || ""),
        entityName: `${employee?.firstName || ""} ${employee?.lastName || ""}`.trim(),
        cardLabel: cardLabel || "Card",
        cardKey: cardKey || "",
        progressPercentage: null,
    });
}

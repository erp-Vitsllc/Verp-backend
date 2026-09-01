/** True when employee nationality is UAE (ISO code or full name). */
export function isEmployeeUaeNationality(employee = {}) {
    const nationalityValue = (
        employee?.nationality ||
        employee?.country ||
        employee?.passportDetails?.nationality ||
        ""
    )
        .toString()
        .trim();
    if (!nationalityValue) return false;

    const normalized = nationalityValue.toLowerCase().replace(/[\s._-]+/g, " ").trim();
    const compact = normalized.replace(/\s+/g, "");

    return (
        normalized === "uae" ||
        normalized === "ae" ||
        normalized === "are" ||
        normalized === "united arab emirates" ||
        normalized === "united arab emirate" ||
        compact === "unitedarabemirates" ||
        compact === "unitedarabemirate"
    );
}

import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Archive a replaced system/manual document into EmployeeBasic.oldDocuments.
 * This keeps old versions visible in Documents > Old Documents.
 */
export const archiveEmployeeDocument = async ({
    employeeId,
    type,
    description = "",
    issueDate = null,
    expiryDate = null,
    cost = null,
    basicSalary = null,
    houseRentAllowance = null,
    vehicleAllowance = null,
    fuelAllowance = null,
    otherAllowance = null,
    totalSalary = null,
    document,
}) => {
    if (!employeeId || !document) return;

    await EmployeeBasic.updateOne(
        { employeeId },
        {
            $push: {
                oldDocuments: {
                    type: type || "Document",
                    description,
                    issueDate: issueDate || null,
                    expiryDate: expiryDate || null,
                    cost: cost ?? null,
                    basicSalary: basicSalary ?? null,
                    houseRentAllowance: houseRentAllowance ?? null,
                    vehicleAllowance: vehicleAllowance ?? null,
                    fuelAllowance: fuelAllowance ?? null,
                    otherAllowance: otherAllowance ?? null,
                    totalSalary: totalSalary ?? null,
                    createdAt: new Date(),
                    archivedAt: new Date(),
                    archiveReason: "Replaced",
                    document,
                },
            },
        }
    );
};

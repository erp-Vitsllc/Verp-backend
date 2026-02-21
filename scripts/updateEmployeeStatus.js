import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

dotenv.config({ path: ".env" });

const statusMap = {
    active: "Permanent",
    permenent: "Permanent",
    permanent: "Permanent",
    probation: "Probation",
    temporary: "Temporary",
    temp: "Temporary",
    notice: "Notice",
    inactive: "Probation", // fallback for legacy values
};

const normalizeStatus = (status) => {
    if (!status) return "Probation";
    const key = status.toString().trim().toLowerCase();
    return statusMap[key] || "Probation";
};

const updateStatuses = async () => {
    try {
        await connectDB();

        const employees = await EmployeeBasic.find({});
        let updatedCount = 0;

        for (const emp of employees) {
            let normalized = normalizeStatus(emp.status);

            // Check probation rule
            if (emp.dateOfJoining && normalized === "Probation") {
                const joinDate = new Date(emp.dateOfJoining);
                const probationPeriod = emp.probationPeriod || 6; // Default to 6 months if not specified

                const probationEndDate = new Date(joinDate);
                probationEndDate.setMonth(joinDate.getMonth() + probationPeriod);

                const today = new Date();

                if (today >= probationEndDate) {
                    normalized = "Permanent";
                }
            }

            if (emp.status !== normalized) {
                console.log(`Updating ${emp.employeeId}: ${emp.status} -> ${normalized}`);
                emp.status = normalized;
                if (normalized === "Permanent") emp.probationPeriod = null;
                await emp.save();
                updatedCount++;
            }
        }

        console.log(`✅ Status normalization complete. Updated ${updatedCount} employees.`);
    } catch (error) {
        console.error("❌ Failed to update employee statuses:", error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
};

updateStatuses();



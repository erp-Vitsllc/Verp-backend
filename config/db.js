import mongoose from "mongoose";
import Group from "../models/Group.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { getAllPermissions } from "../services/permissionService.js";
import { ensureAssetCategoryIndexes } from "../utils/ensureAssetCategoryIndexes.js";

export const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            // Short timeouts + a single driver retry let us skip the flaky
            // 159.41.242.147 Atlas node without the 120s waits we saw earlier
            // (those came from socketTimeoutMS=60s x 2 retries).
            // Worst case now is 2 x socketTimeoutMS = ~40s before bubbling up.
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
            connectTimeoutMS: 10000,
            // Asset list + dashboard stats run many parallel reads; a slightly larger pool reduces
            // "connection … timed out" / wait-queue failures under concurrent users (stay under Atlas limit).
            maxPoolSize: 25,
            minPoolSize: 0,
            maxIdleTimeMS: 60000,
            waitQueueTimeoutMS: 12000,
            retryWrites: true,
            retryReads: true,
            heartbeatFrequencyMS: 5000,
            readPreference: "primaryPreferred",
            family: 4,
            appName: "VERP-Backend",
        });
        console.log("MongoDB Connected Successfully");

        mongoose.connection.on("disconnected", () => {
            console.warn("⚠️  MongoDB disconnected");
        });
        mongoose.connection.on("reconnected", () => {
            console.log("✅ MongoDB reconnected");
        });
        mongoose.connection.on("error", (err) => {
            console.error("❌ MongoDB connection error:", err.message);
        });

        await ensureAssetCategoryIndexes();

        // Ensure the critical EmployeeBasic.company index exists before serving traffic.
        // getCompanies hangs without this index because $lookup runs COLLSCAN per company.
        try {
            const tIdx = Date.now();
            await EmployeeBasic.collection.createIndex(
                { company: 1, employeeId: 1 },
                { name: "company_1_employeeId_1", background: true }
            );
            console.log(`✅ EmployeeBasic company index ready (${Date.now() - tIdx}ms)`);
        } catch (err) {
            console.error("❌ Failed to ensure EmployeeBasic.company index:", err.message);
        }

        // Initialize default Admin group
        await initializeAdminGroup();
    } catch (error) {
        console.error("❌ Database Connection Failed:", error.message);
        process.exit(1);
    }
};

/**
 * Initialize the default Admin group if it doesn't exist
 * This group has all permissions and cannot be deleted or modified (except by admin users)
 */
const initializeAdminGroup = async () => {
    try {
        // Check if Admin group already exists
        const existingAdminGroup = await Group.findOne({
            name: { $regex: new RegExp('^Admin$', 'i') }
        });

        if (!existingAdminGroup) {
            // Get all permissions for Admin group
            const allPermissions = getAllPermissions();

            // Create Admin group with all permissions
            const adminGroup = new Group({
                name: 'Admin',
                users: [],
                permissions: allPermissions,
                status: 'Active',
                isSystemGroup: true
            });

            await adminGroup.save();
            console.log("✅ Default Admin group created successfully");
        } else {
            // If Admin group exists but is not marked as system group, update it
            if (!existingAdminGroup.isSystemGroup) {
                existingAdminGroup.isSystemGroup = true;
                // Also ensure it has all permissions
                const allPermissions = getAllPermissions();
                existingAdminGroup.permissions = allPermissions;
                await existingAdminGroup.save();
                console.log("✅ Existing Admin group updated to system group");
            }
        }
    } catch (error) {
        console.error("❌ Error initializing Admin group:", error.message);
        // Don't exit - this is not critical for server startup
    }
};

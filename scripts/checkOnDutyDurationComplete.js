import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import AssetItem from "../models/AssetItem.js";
import { sendOnDutyDurationCompleteEmail } from "../utils/sendOnDutyDurationCompleteEmail.js";
import { getDepartmentHOD } from "../utils/getDepartmentHOD.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

dotenv.config({ path: ".env" });

const checkOnDutyDurationComplete = async () => {
    try {
        await connectDB();
        console.log("Checking for completed On Duty durations...");

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set to start of day for comparison

        // Find all assets that are "Assigned" and have onLeaveEndDate that has passed
        // These are assets that were set to "On Duty" and should have completed their duration
        // Note: onLeaveEndDate is now used to track "On Duty" duration completion
        const assetsWithCompletedDuration = await AssetItem.find({
            status: 'Assigned',
            onLeaveEndDate: { $lte: today },
            onLeaveDuration: { $ne: null },
            onLeaveStartDate: { $ne: null } // Ensure it's tracking On Duty duration
        }).populate('assignedTo');

        let notifiedCount = 0;

        for (const asset of assetsWithCompletedDuration) {
            if (!asset.assignedTo || !asset.onLeaveDuration) continue;

            console.log(`[On Duty Duration] Asset ${asset.assetId} duration completed on ${asset.onLeaveEndDate?.toLocaleDateString()}`);

            try {
                const assignedUser = await EmployeeBasic.findById(asset.assignedTo._id || asset.assignedTo).populate('primaryReportee');
                const assetController = await getDepartmentHOD('assetcontroller');

                if (assignedUser && assetController) {
                    await sendOnDutyDurationCompleteEmail(
                        asset,
                        assignedUser,
                        assetController,
                        asset.onLeaveDuration
                    );

                    // Clear duration fields after sending email
                    asset.onLeaveStartDate = null;
                    asset.onLeaveEndDate = null;
                    asset.onLeaveDuration = null;
                    await asset.save();

                    notifiedCount++;
                    console.log(`  - Email sent for ${asset.assetId}`);
                }
            } catch (err) {
                console.error(`  - [Error] Failed to process ${asset.assetId}:`, err.message);
            }
        }

        console.log(`✅ On Duty duration check complete. Checked ${assetsWithCompletedDuration.length} assets. Notified for ${notifiedCount} assets.`);
    } catch (error) {
        console.error("❌ Failed to check On Duty duration completion:", error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
};

checkOnDutyDurationComplete();

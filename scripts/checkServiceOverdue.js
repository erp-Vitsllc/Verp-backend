import dotenv from "dotenv";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import AssetItem from "../models/AssetItem.js";
import { sendAssetServiceEmail } from "../utils/sendAssetServiceEmail.js";
import { getDepartmentHOD } from "../utils/getDepartmentHOD.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import DashboardAction from "../models/DashboardAction.js";

dotenv.config({ path: ".env" });

const checkOverdueServices = async () => {
    try {
        await connectDB();
        console.log("Checking for overdue asset services...");

        // Find all assets currently in Service status
        const assetsInService = await AssetItem.find({ status: 'Service' });

        const today = new Date();
        let reminderCount = 0;
        let completedCount = 0;

        for (const asset of assetsInService) {
            // Get the current active service record (the latest one)
            const currentService = asset.services[asset.services.length - 1];

            if (currentService && currentService.expiryDate) {
                const expiryDate = new Date(currentService.expiryDate);

                const msLeft = expiryDate.getTime() - today.getTime();
                const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));

                const assetController = await getDepartmentHOD('assetcontroller');
                const recipients = [];
                if (assetController) recipients.push(assetController);

                if (asset.assignedTo) {
                    const assignedPerson = await EmployeeBasic.findById(asset.assignedTo);
                    if (assignedPerson) {
                        const hasEmail = assignedPerson.companyEmail || assignedPerson.workEmail || assignedPerson.email;
                        let targetRecipient = assignedPerson;
                        if (!hasEmail && assignedPerson.primaryReportee) {
                            const manager = await EmployeeBasic.findById(assignedPerson.primaryReportee);
                            if (manager) targetRecipient = manager;
                        }
                        const isDuplicate = recipients.some(r => r._id.toString() === targetRecipient._id.toString());
                        if (!isDuplicate) recipients.push(targetRecipient);
                    }
                }

                // Send once when there are 2 days or less remaining (but still not expired).
                if (daysLeft > 0 && daysLeft <= 2 && !currentService.reminderSentAt) {
                    console.log(`[Reminder] Asset ${asset.assetId} service expires on ${expiryDate.toLocaleString()}`);
                    for (const recipient of recipients) {
                        await sendAssetServiceEmail({
                            asset,
                            recipient,
                            type: 'Reminder',
                            details: {
                                serviceDuration: currentService.serviceDuration,
                                description: currentService.description
                            },
                            sender: { firstName: 'System', lastName: 'Automated' }
                        });
                    }
                    currentService.reminderSentAt = new Date();
                    await asset.save();
                    reminderCount++;
                }

                // Send once when duration is completed (expiry reached/passed).
                if (daysLeft <= 0 && !currentService.durationCompleteSentAt) {
                    console.log(`[Duration Complete] Asset ${asset.assetId} service completed on ${expiryDate.toLocaleString()}`);
                    for (const recipient of recipients) {
                        await sendAssetServiceEmail({
                            asset,
                            recipient,
                            type: 'DurationComplete',
                            details: {
                                serviceDuration: currentService.serviceDuration,
                                description: currentService.description
                            },
                            sender: { firstName: 'System', lastName: 'Automated' }
                        });
                    }

                    // Notification (dashboard/bell) only when duration is completed.
                    for (const recipient of recipients) {
                        try {
                            await DashboardAction.create({
                                assignedTo: recipient._id,
                                assignedToEmpId: recipient.employeeId,
                                requestId: asset._id,
                                requestType: 'Asset Overdue',
                                subjectEmployeeId: recipient.employeeId || asset.assetId,
                                subjectName: `${recipient.firstName || ''} ${recipient.lastName || ''}`.trim() || 'User',
                                requestedByName: 'System Monitor',
                                extra1: `${asset.assetId} - ${asset.name}`,
                                extra2: `Duration completed on ${expiryDate.toLocaleDateString()}. Please choose Extend or Return.`,
                                status: 'Pending'
                            });
                        } catch (dashErr) {
                            console.error(`  - [Dashboard Error] Failed for ${recipient.firstName || 'recipient'}:`, dashErr.message);
                        }
                    }

                    currentService.durationCompleteSentAt = new Date();
                    currentService.lastWarningSentAt = new Date();
                    await asset.save();
                    completedCount++;
                }
            }
        }

        console.log(
            `✅ Service check complete. Checked ${assetsInService.length} assets. ` +
            `2-day reminders: ${reminderCount}, duration-complete notices: ${completedCount}.`
        );
    } catch (error) {
        console.error("❌ Failed to check overdue services:", error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
};

checkOverdueServices();

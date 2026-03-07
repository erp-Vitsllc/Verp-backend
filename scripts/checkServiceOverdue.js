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
        let notifiedCount = 0;

        for (const asset of assetsInService) {
            // Get the current active service record (the latest one)
            const currentService = asset.services[asset.services.length - 1];

            if (currentService && currentService.expiryDate) {
                const expiryDate = new Date(currentService.expiryDate);

                if (today > expiryDate && !currentService.lastWarningSentAt) {
                    console.log(`[Overdue] Asset ${asset.assetId} service expired on ${expiryDate.toLocaleString()}`);

                    const initiatorId = currentService.requestedBy || asset.requestedBy;
                    const initiator = initiatorId ? await EmployeeBasic.findById(initiatorId) : null;
                    const assetController = await getDepartmentHOD('assetcontroller', initiatorId || asset.assignedTo);

                    const recipients = [];
                    if (assetController) recipients.push(assetController);
                    if (initiator && (!assetController || assetController._id.toString() !== initiator._id.toString())) {
                        recipients.push(initiator);
                    }

                    // Also notify the assigned user (or their manager if no email)
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

                    for (const recipient of recipients) {
                        await sendAssetServiceEmail({
                            asset,
                            recipient,
                            type: 'Warning',
                            details: {
                                serviceDuration: currentService.serviceDuration,
                                description: currentService.description
                            },
                            sender: { firstName: 'System', lastName: 'Automated' }
                        });

                        // Create Dashboard Action for each recipient
                        try {
                            await DashboardAction.create({
                                assignedTo: recipient._id,
                                assignedToEmpId: recipient.employeeId,
                                requestId: asset._id,
                                requestType: 'Asset Overdue',
                                subjectEmployeeId: initiator?.employeeId || asset.assetId,
                                subjectName: `${initiator?.firstName || 'System'} ${initiator?.lastName || ''}`.trim(),
                                requestedByName: 'System Monitor',
                                extra1: `${asset.assetId} - ${asset.name}`,
                                extra2: `OVERDUE: Service expired on ${expiryDate.toLocaleDateString()}`,
                                status: 'Pending'
                            });
                            console.log(`  - Dashboard Action created for ${recipient.firstName}`);
                        } catch (dashErr) {
                            console.error(`  - [Dashboard Error] Failed for ${recipient.firstName}:`, dashErr.message);
                        }
                    }

                    // Mark as warned to avoid repeat spam
                    currentService.lastWarningSentAt = new Date();
                    await asset.save();
                    notifiedCount++;
                }
            }
        }

        console.log(`✅ Overdue check complete. Checked ${assetsInService.length} assets. Notified for ${notifiedCount} assets.`);
    } catch (error) {
        console.error("❌ Failed to check overdue services:", error);
    } finally {
        await mongoose.connection.close();
        process.exit(0);
    }
};

checkOverdueServices();

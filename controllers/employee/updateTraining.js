import EmployeeTraining from "../../models/EmployeeTraining.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getCompleteEmployee, resolveEmployeeId } from "../../services/employeeService.js";
import { triggerProfileReactivationIfNeeded, shouldQueueProfileChange } from "../../utils/triggerProfileReactivation.js";

export const updateTraining = async (req, res) => {
    const { id, trainingId } = req.params;
    const { trainingName, trainingDetails, provider, trainingDate, trainingCost, trainingCertificate } = req.body;

    // Validate required fields and types
    if (!trainingName || !provider || !trainingDate) {
        return res.status(400).json({
            message: "Training Name, Provider, and Training Date are required"
        });
    }

    if (typeof trainingName !== 'string' || typeof provider !== 'string' || (trainingDetails !== undefined && typeof trainingDetails !== 'string')) {
        return res.status(400).json({
            message: "Training Name, Provider, and Details must be valid strings"
        });
    }

    // Validate date
    const parsedTrainingDate = new Date(trainingDate);
    if (isNaN(parsedTrainingDate.getTime())) {
        return res.status(400).json({ message: "Invalid training date provided" });
    }

    try {
        // Get employeeId from employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasic = await EmployeeBasic.findOne({ employeeId }).select("profileStatus profileWorkflow").lean();
        const requiresApprovalQueue = shouldQueueProfileChange(employeeBasic);

        const trainingRecord = await EmployeeTraining.findOne({ employeeId });

        if (!trainingRecord) {
            return res.status(404).json({ message: "Training record not found" });
        }

        const training = trainingRecord.trainingDetails.id(trainingId);

        if (!training) {
            return res.status(404).json({ message: "Training record not found" });
        }

        const previousTraining = training?.toObject ? training.toObject() : training;
        const proposedTraining = {
            ...previousTraining,
            trainingName: trainingName.trim(),
            trainingDetails: trainingDetails ? trainingDetails.trim() : undefined,
            provider: provider.trim(),
            trainingDate: parsedTrainingDate,
            trainingCost: trainingCost !== undefined && trainingCost !== null && trainingCost !== '' ? Number(trainingCost) : undefined,
        };

        // Update certificate if provided
        if (trainingCertificate && trainingCertificate.data) {
            proposedTraining.trainingCertificate = {
                data: trainingCertificate.data,
                name: trainingCertificate.name || '',
                mimeType: trainingCertificate.mimeType || 'application/pdf'
            };
        } else if (trainingCertificate === null) {
            // Allow clearing the certificate
            proposedTraining.trainingCertificate = undefined;
        }
        if (requiresApprovalQueue) {
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Training details updated",
                changeEntry: {
                    card: "Training",
                    reason: "Training details updated",
                    section: "training",
                    changeType: "update",
                    targetIndex: null,
                    previousData: previousTraining || null,
                    proposedData: { trainingId, ...proposedTraining },
                },
            });
        } else {
            // Update training fields
            training.trainingName = proposedTraining.trainingName;
            training.trainingDetails = proposedTraining.trainingDetails;
            training.provider = proposedTraining.provider;
            training.trainingDate = proposedTraining.trainingDate;
            training.trainingCost = proposedTraining.trainingCost;
            if (Object.prototype.hasOwnProperty.call(proposedTraining, "trainingCertificate")) {
                training.trainingCertificate = proposedTraining.trainingCertificate;
            }
            await trainingRecord.save();
            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Training details updated",
            });
        }
        const completeEmployee = await getCompleteEmployee(employeeId);

        return res.status(200).json({
            message: requiresApprovalQueue
                ? "Training change queued for HR activation approval."
                : "Training details updated successfully",
            trainingDetails: trainingRecord?.trainingDetails || completeEmployee?.trainingDetails,
            employee: completeEmployee
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};









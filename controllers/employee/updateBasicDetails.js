import { getCompleteEmployee, saveEmployeeData, resolveEmployeeId } from "../../services/employeeService.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeBank from "../../models/EmployeeBank.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { isUserAdministrator } from "../../services/permissionService.js";
import { archiveEmployeeDocument } from "../../utils/archiveEmployeeDocument.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";

export const updateBasicDetails = async (req, res) => {
    try {
        const { id } = req.params;

        // Get employeeId from the employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const [existingBank, existingSalary, existingBasic] = await Promise.all([
            EmployeeBank.findOne({ employeeId }).select("bankName accountName accountNumber ibanNumber swiftCode bankAttachment").lean(),
            EmployeeSalary.findOne({ employeeId }).select("offerLetter salaryHistory").lean(),
            EmployeeBasic.findOne({ employeeId }).select("trainingDetails").lean(),
        ]);

        // 1. Define allowed fields and their target collections
        const allowedFields = [
            "employeeId",
            "firstName",
            "lastName",
            "contactNumber",
            "email",
            "country",
            "nationality",
            "status",
            "probationPeriod",
            "reportingAuthority",
            "profileApprovalStatus",
            "profileStatus",
            "bankName",
            "accountName",
            "accountNumber",
            "ibanNumber",
            "swiftCode",
            "ifscCode",
            "bankOtherDetails",
            "bankAttachment",
            "addressLine1",
            "addressLine2",
            "city",
            "state",
            "postalCode",
            "currentAddressLine1",
            "currentAddressLine2",
            "currentCity",
            "currentState",
            "currentCountry",
            "currentPostalCode",
            "dateOfBirth",
            "maritalStatus",
            "numberOfDependents",
            "fathersName",
            "gender",
            "emergencyContactName",
            "emergencyContactRelation",
            "emergencyContactNumber",
            "basic",
            "houseRentAllowance",
            "otherAllowance",
            "additionalAllowances",
            "salaryHistory",
            "offerLetter",
            "profilePicture",
            "documents",
            "trainingDetails",
            "enablePortalAccess"
        ];

        // 2. Build updatePayload
        const updatePayload = {};

        allowedFields.forEach(field => {
            if (req.body[field] !== undefined) {
                updatePayload[field] = req.body[field];
            }
        });

        // 3. Handle documents - if URL is provided, use it; if data is base64, upload to S3 (IDrive)

        // Handle bankAttachment - check for URL first, then data
        if (updatePayload.bankAttachment) {
            const bankAttachment = updatePayload.bankAttachment;
            // If URL is provided (from frontend upload), use it directly
            if (bankAttachment.url) {
                updatePayload.bankAttachment = {
                    url: bankAttachment.url,
                    name: bankAttachment.name,
                    mimeType: bankAttachment.mimeType
                };
            } else if (bankAttachment.data && !bankAttachment.data.startsWith('http')) {
                // Base64 data - upload to S3
                try {
                    const uploadResult = await uploadDocumentToS3(
                        bankAttachment.data,
                        `employee-documents/${employeeId}/bank`,
                        bankAttachment.name || 'bank-attachment',
                        'raw'
                    );
                    updatePayload.bankAttachment = {
                        url: uploadResult.url,
                        name: bankAttachment.name,
                        mimeType: bankAttachment.mimeType
                    };
                } catch (error) {
                    console.error('Error uploading bank attachment to S3:', error);
                    // Continue with base64 if upload fails
                }
            }
        }

        // Handle offerLetter - check for URL first, then data
        if (updatePayload.offerLetter) {
            const offerLetter = updatePayload.offerLetter;
            // If URL is provided, use it directly
            if (offerLetter.url) {
                updatePayload.offerLetter = {
                    url: offerLetter.url,
                    name: offerLetter.name,
                    mimeType: offerLetter.mimeType
                };
            } else if (offerLetter.data && !offerLetter.data.startsWith('http')) {
                // Base64 data - upload to S3
                try {
                    const uploadResult = await uploadDocumentToS3(
                        offerLetter.data,
                        `employee-documents/${employeeId}/salary`,
                        offerLetter.name || 'offer-letter',
                        'raw'
                    );
                    updatePayload.offerLetter = {
                        url: uploadResult.url,
                        name: offerLetter.name,
                        mimeType: offerLetter.mimeType
                    };
                } catch (error) {
                    console.error('Error uploading offer letter to S3:', error);
                    // Continue with base64 if upload fails
                }
            }
        }

        // Handle salaryHistory offer letters
        if (updatePayload.salaryHistory && Array.isArray(updatePayload.salaryHistory)) {
            for (let entry of updatePayload.salaryHistory) {
                if (entry.offerLetter) {
                    // If URL is provided, use it directly
                    if (entry.offerLetter.url) {
                        entry.offerLetter = {
                            url: entry.offerLetter.url,
                            name: entry.offerLetter.name,
                            mimeType: entry.offerLetter.mimeType
                        };
                    } else if (entry.offerLetter.data && !entry.offerLetter.data.startsWith('http')) {
                        // Base64 data - upload to S3
                        try {
                            const uploadResult = await uploadDocumentToS3(
                                entry.offerLetter.data,
                                `employee-documents/${employeeId}/salary-history`,
                                entry.offerLetter.name || 'offer-letter',
                                'raw'
                            );
                            entry.offerLetter = {
                                url: uploadResult.url,
                                name: entry.offerLetter.name,
                                mimeType: entry.offerLetter.mimeType
                            };
                        } catch (error) {
                            console.error('Error uploading salary history offer letter to S3:', error);
                            // Continue with base64 if upload fails
                        }
                    }
                }
            }
        }

        // Handle documents array - process each document
        if (updatePayload.documents && Array.isArray(updatePayload.documents)) {
            for (let doc of updatePayload.documents) {
                if (doc.document) {
                    // If URL is provided, use it directly
                    if (doc.document.url) {
                        doc.document = {
                            url: doc.document.url,
                            name: doc.document.name,
                            mimeType: doc.document.mimeType
                        };
                    } else if (doc.document.data && !doc.document.data.startsWith('http')) {
                        // Base64 data - upload to S3
                        try {
                            const uploadResult = await uploadDocumentToS3(
                                doc.document.data,
                                `employee-documents/${employeeId}/documents`,
                                doc.document.name || 'document',
                                'raw'
                            );
                            doc.document = {
                                url: uploadResult.url,
                                name: doc.document.name,
                                mimeType: doc.document.mimeType
                            };
                        } catch (error) {
                            console.error('Error uploading document to S3:', error);
                            // Continue with base64 if upload fails
                        }
                    }
                }
            }
        }

        // Handle trainingDetails certificates - process each training certificate
        if (updatePayload.trainingDetails && Array.isArray(updatePayload.trainingDetails)) {
            for (let training of updatePayload.trainingDetails) {
                if (training.certificate) {
                    // If URL is provided, use it directly
                    if (training.certificate.url) {
                        training.certificate = {
                            url: training.certificate.url,
                            name: training.certificate.name,
                            mimeType: training.certificate.mimeType
                        };
                    } else if (training.certificate.data && !training.certificate.data.startsWith('http')) {
                        // Base64 data - upload to S3
                        try {
                            const uploadResult = await uploadDocumentToS3(
                                training.certificate.data,
                                `employee-documents/${employeeId}/training`,
                                training.certificate.name || 'certificate',
                                'raw'
                            );
                            training.certificate = {
                                url: uploadResult.url,
                                name: training.certificate.name,
                                mimeType: training.certificate.mimeType
                            };
                        } catch (error) {
                            console.error('Error uploading training certificate to S3:', error);
                            // Continue with base64 if upload fails
                        }
                    }
                }
            }
        }

        const previousBankAttachment = existingBank?.bankAttachment;
        const nextBankAttachment = updatePayload.bankAttachment;
        const bankCoreFields = ["bankName", "accountName", "accountNumber", "ibanNumber", "swiftCode"];
        const bankFieldsChanged = bankCoreFields.some((field) => updatePayload[field] !== undefined);
        const bankAttachmentReplaced = Boolean(
            previousBankAttachment?.url &&
            nextBankAttachment?.url &&
            previousBankAttachment.url !== nextBankAttachment.url
        );
        if (previousBankAttachment?.url && (bankAttachmentReplaced || bankFieldsChanged)) {
            const prevSummary = [
                existingBank?.bankName ? `Bank: ${existingBank.bankName}` : "",
                existingBank?.accountName ? `Account: ${existingBank.accountName}` : "",
                existingBank?.accountNumber ? `A/C: ${existingBank.accountNumber}` : "",
                existingBank?.ibanNumber ? `IBAN: ${existingBank.ibanNumber}` : "",
            ].filter(Boolean).join(" | ");
            await archiveEmployeeDocument({
                employeeId,
                type: "Bank Attachment",
                description: prevSummary || "Bank details attachment",
                document: previousBankAttachment,
            });
        }

        const previousOfferLetter = existingSalary?.offerLetter;
        const nextOfferLetter = updatePayload.offerLetter;
        if (previousOfferLetter?.url && nextOfferLetter?.url && previousOfferLetter.url !== nextOfferLetter.url) {
            await archiveEmployeeDocument({
                employeeId,
                type: "Salary Offer Letter",
                description: "Salary offer letter (previous version)",
                document: previousOfferLetter,
            });
        }

        if (Array.isArray(updatePayload.salaryHistory) && Array.isArray(existingSalary?.salaryHistory)) {
            const prevActive = existingSalary.salaryHistory.find((entry) => !entry?.toDate);
            const nextActive = updatePayload.salaryHistory.find((entry) => !entry?.toDate);
            const prevActiveDoc = prevActive?.offerLetter;
            const nextActiveDoc = nextActive?.offerLetter;
            const sameDoc = Boolean(
                prevActiveDoc?.url &&
                nextActiveDoc?.url &&
                prevActiveDoc.url === nextActiveDoc.url
            );
            if (prevActiveDoc?.url && nextActiveDoc?.url && !sameDoc) {
                await archiveEmployeeDocument({
                    employeeId,
                    type: "Salary Increment Letter",
                    description: prevActive?.month ? `Previous active salary (${prevActive.month})` : "Previous active salary",
                    issueDate: prevActive?.fromDate || null,
                    expiryDate: prevActive?.toDate || null,
                    basicSalary: prevActive?.basic ?? null,
                    houseRentAllowance: prevActive?.houseRentAllowance ?? null,
                    vehicleAllowance: prevActive?.vehicleAllowance ?? null,
                    fuelAllowance: prevActive?.fuelAllowance ?? null,
                    otherAllowance: prevActive?.otherAllowance ?? null,
                    totalSalary: prevActive?.totalSalary ?? null,
                    document: prevActiveDoc,
                });
            }
        }

        const userId = req.user?.id;
        const isAdminUser = req.user?.isAdmin === true || (userId ? await isUserAdministrator(userId) : false);

        // 4. Enforce admin-only delete on salary history and training records.
        // If salaryHistory is being updated, check if it's a deletion (array length decreased)
        if (updatePayload.salaryHistory !== undefined && Array.isArray(updatePayload.salaryHistory)) {
            // Get current salary history from EmployeeSalary model
            const employeeSalary = await EmployeeSalary.findOne({ employeeId });
            const currentSalaryHistory = employeeSalary?.salaryHistory || [];
            const newSalaryHistory = updatePayload.salaryHistory;

            // If new array is shorter, it means deletion occurred
            if (newSalaryHistory.length < currentSalaryHistory.length && !isAdminUser) {
                return res.status(403).json({
                    message: "Only administrator can delete salary history records."
                });
            }
        }

        if (updatePayload.trainingDetails !== undefined && Array.isArray(updatePayload.trainingDetails)) {
            const currentTrainingDetails = existingBasic?.trainingDetails || [];
            if (updatePayload.trainingDetails.length < currentTrainingDetails.length && !isAdminUser) {
                return res.status(403).json({
                    message: "Only administrator can delete training records."
                });
            }
        }

        // 5. If nothing to update
        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ message: "Nothing to update" });
        }

        // 6. Update using service (which handles routing to correct collections)
        const updated = await saveEmployeeData(employeeId, updatePayload);

        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        // Remove password from response
        delete updated.password;

        await triggerProfileReactivationIfNeeded({
            employeeId,
            actor: req.user,
            reason: "Basic details updated",
        });

        // 7. Return success
        return res.status(200).json({
            message: "Basic details updated",
            employee: updated
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};

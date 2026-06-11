import { getCompleteEmployee, saveEmployeeData, resolveEmployeeId } from "../../services/employeeService.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeBank from "../../models/EmployeeBank.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { isReqUserAdmin } from "../../utils/sendAdminDeletionNotificationEmails.js";
import { triggerProfileReactivationIfNeeded } from "../../utils/triggerProfileReactivation.js";
import { skipLiveProfileWritesPendingHrAsync, queueOrTriggerProfileChange } from "../../utils/pushPendingReactivationChange.js";
import { markProfileActivationHoldResolvedForSection } from "../../utils/markProfileActivationHoldResolved.js";
import { PURGE_TYPES, purgeEmployeeOldDocuments } from "../../utils/purgeEmployeeOldDocuments.js";
import {
    archiveSalaryIncrementIfNeeded,
    purgeSalaryOldDocumentsUnlessIncrement,
} from "../../utils/archiveSupersededSalaryOnIncrement.js";
import { archiveSupersededBankIfNeeded, bankUpdateTouchesFields } from "../../utils/archiveSupersededBankIfNeeded.js";
import EmployeePersonal from "../../models/EmployeePersonal.js";
import EmployeeContact from "../../models/EmployeeContact.js";
import {
    normalizeEmployeeProfileBasicDetailsPayload,
    validateEmployeeProfileBasicDetailsPayload,
} from "../../utils/employeeProfileBasicDetailsValidation.js";
import {
    validateSalaryHistoryNotEmpty,
    oldestSalaryHistoryStillPresent,
} from "../../utils/employeeSalaryValidation.js";
import { validateEmployeeBankPayload } from "../../utils/employeeBankValidation.js";
import { validateEmployeeAddressPayload } from "../../utils/employeeAddressValidation.js";
import { denyCoreEmployeeProfileDelete } from "../../utils/employeeCardDeleteAccess.js";

const isEmptyProfileValue = (value) =>
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "");

const isClearingProfileFields = (payload, keys) =>
    keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key) && isEmptyProfileValue(payload[key]));

const PROFILE_BASIC_PATCH_KEYS = new Set([
    "firstName",
    "lastName",
    "email",
    "contactNumber",
    "dateOfBirth",
    "maritalStatus",
    "numberOfDependents",
    "fathersName",
    "nationality",
]);

export const updateBasicDetails = async (req, res) => {
    try {
        const { id } = req.params;

        // Get employeeId from the employee record using optimized resolver
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        const employeeId = employee.employeeId;
        const employeeBasicSnapSelect =
            '-password -documents.document.data -trainingDetails.certificate.data';
        const [existingBank, existingSalary, existingBasic] = await Promise.all([
            EmployeeBank.findOne({ employeeId }).select("bankName accountName accountNumber ibanNumber swiftCode bankAttachment").lean(),
            EmployeeSalary.findOne({ employeeId })
                .select(
                    "offerLetter salaryHistory basic houseRentAllowance otherAllowance additionalAllowances monthlySalary totalSalary basicPercentage houseRentPercentage otherAllowancePercentage",
                )
                .lean(),
            EmployeeBasic.findOne({ employeeId }).select(employeeBasicSnapSelect).lean(),
        ]);

        const isAdminUser = await isReqUserAdmin(req.user);
        const skipLive = await skipLiveProfileWritesPendingHrAsync(req, existingBasic);
        const skipArchiveOnRequest =
            req.body?.skipArchive === true ||
            String(req.query?.skipArchive || "").toLowerCase() === "true";

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
            "oldDocuments",
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
        if (skipArchiveOnRequest) {
            delete updatePayload.skipArchive;
        }

        const touchesProfileBasic = [...PROFILE_BASIC_PATCH_KEYS].some((key) =>
            Object.prototype.hasOwnProperty.call(updatePayload, key),
        );

        if (touchesProfileBasic) {
            if (
                updatePayload.employeeId !== undefined &&
                String(updatePayload.employeeId || "").trim() &&
                String(updatePayload.employeeId) !== String(employeeId)
            ) {
                return res.status(400).json({ message: "Employee ID cannot be edited" });
            }
            delete updatePayload.employeeId;

            const [existingPersonal, existingContact] = await Promise.all([
                EmployeePersonal.findOne({ employeeId })
                    .select("dateOfBirth maritalStatus numberOfDependents fathersName nationality")
                    .lean(),
                EmployeeContact.findOne({ employeeId }).select("contactNumber").lean(),
            ]);

            const mergedForValidation = {
                firstName: updatePayload.firstName ?? existingBasic?.firstName,
                lastName: updatePayload.lastName ?? existingBasic?.lastName,
                email: updatePayload.email ?? existingBasic?.email,
                contactNumber:
                    updatePayload.contactNumber ??
                    existingContact?.contactNumber ??
                    existingBasic?.contactNumber,
                dateOfBirth: updatePayload.dateOfBirth ?? existingPersonal?.dateOfBirth,
                maritalStatus: updatePayload.maritalStatus ?? existingPersonal?.maritalStatus,
                numberOfDependents:
                    updatePayload.numberOfDependents !== undefined
                        ? updatePayload.numberOfDependents
                        : existingPersonal?.numberOfDependents,
                fathersName: updatePayload.fathersName ?? existingPersonal?.fathersName,
                nationality:
                    updatePayload.nationality ??
                    updatePayload.country ??
                    existingPersonal?.nationality ??
                    existingBasic?.country,
            };

            const validation = validateEmployeeProfileBasicDetailsPayload(mergedForValidation);
            if (!validation.ok) {
                return res.status(400).json({ message: validation.message });
            }

            const normalizedBasic = normalizeEmployeeProfileBasicDetailsPayload(updatePayload);
            for (const key of PROFILE_BASIC_PATCH_KEYS) {
                if (Object.prototype.hasOwnProperty.call(updatePayload, key)) {
                    updatePayload[key] = normalizedBasic[key];
                }
            }

            if (normalizedBasic.email) {
                const duplicateEmail = await EmployeeBasic.findOne({
                    email: normalizedBasic.email,
                    employeeId: { $ne: employeeId },
                })
                    .select("employeeId")
                    .lean();
                if (duplicateEmail) {
                    return res.status(400).json({ message: "Email must be unique" });
                }
            }
        }

        const touchesPermanentAddress = [
            "addressLine1",
            "addressLine2",
            "city",
            "state",
            "postalCode",
        ].some((key) => Object.prototype.hasOwnProperty.call(updatePayload, key)) ||
            (Object.prototype.hasOwnProperty.call(updatePayload, "country") &&
                !Object.prototype.hasOwnProperty.call(updatePayload, "nationality"));

        if (touchesPermanentAddress) {
            const addressValidation = validateEmployeeAddressPayload({
                line1: updatePayload.addressLine1,
                line2: updatePayload.addressLine2,
                city: updatePayload.city,
                state: updatePayload.state,
                country: updatePayload.country,
                postalCode: updatePayload.postalCode,
            });
            if (!addressValidation.ok) {
                return res.status(400).json({ message: addressValidation.message });
            }
        }

        const touchesCurrentAddress = [
            "currentAddressLine1",
            "currentAddressLine2",
            "currentCity",
            "currentState",
            "currentCountry",
            "currentPostalCode",
        ].some((key) => Object.prototype.hasOwnProperty.call(updatePayload, key));

        if (touchesCurrentAddress) {
            const addressValidation = validateEmployeeAddressPayload({
                line1: updatePayload.currentAddressLine1,
                line2: updatePayload.currentAddressLine2,
                city: updatePayload.currentCity,
                state: updatePayload.currentState,
                country: updatePayload.currentCountry,
                postalCode: updatePayload.currentPostalCode,
            });
            if (!addressValidation.ok) {
                return res.status(400).json({ message: addressValidation.message });
            }
        }

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

        // 4. Salary history delete guards and validation.
        if (updatePayload.salaryHistory !== undefined && Array.isArray(updatePayload.salaryHistory)) {
            const employeeSalary = await EmployeeSalary.findOne({ employeeId });
            const currentSalaryHistory = employeeSalary?.salaryHistory || [];
            const newSalaryHistory = updatePayload.salaryHistory;

            const emptyErr = validateSalaryHistoryNotEmpty(newSalaryHistory);
            if (emptyErr) {
                return res.status(400).json({ message: emptyErr });
            }

            if (newSalaryHistory.length < currentSalaryHistory.length) {
                const emptyAfterDelete = validateSalaryHistoryNotEmpty(newSalaryHistory);
                if (emptyAfterDelete) {
                    return res.status(400).json({ message: emptyAfterDelete });
                }
                if (!oldestSalaryHistoryStillPresent(newSalaryHistory, currentSalaryHistory)) {
                    return res.status(403).json({
                        message: "The first salary record cannot be deleted.",
                    });
                }
            }

            const monthKeys = new Set();
            for (const entry of newSalaryHistory) {
                const fromDate = entry?.fromDate;
                if (!fromDate) continue;
                const d = new Date(fromDate);
                if (Number.isNaN(d.getTime())) continue;
                const key = `${d.getFullYear()}-${d.getMonth()}`;
                if (monthKeys.has(key)) {
                    return res.status(400).json({
                        message: "Duplicate salary records for the same month are not allowed.",
                    });
                }
                monthKeys.add(key);
            }
        }

        const bankTouched = ["bankName", "accountName", "accountNumber", "ibanNumber", "swiftCode", "bankOtherDetails", "bankAttachment"]
            .some((k) => Object.prototype.hasOwnProperty.call(updatePayload, k));
        if (bankTouched) {
            const mergedBank = {
                bankName: updatePayload.bankName ?? existingBank?.bankName,
                accountName: updatePayload.accountName ?? existingBank?.accountName,
                accountNumber: updatePayload.accountNumber ?? existingBank?.accountNumber,
                ibanNumber: updatePayload.ibanNumber ?? existingBank?.ibanNumber,
                swiftCode: updatePayload.swiftCode ?? existingBank?.swiftCode,
                bankOtherDetails: updatePayload.bankOtherDetails ?? existingBank?.bankOtherDetails,
                bankAttachment: updatePayload.bankAttachment ?? existingBank?.bankAttachment,
            };
            const hasExistingAttachment = Boolean(
                mergedBank.bankAttachment?.url || mergedBank.bankAttachment?.data,
            );
            const bankErrors = validateEmployeeBankPayload(mergedBank, {
                requireAttachment: !hasExistingAttachment,
            });
            if (bankErrors.length) {
                return res.status(400).json({ message: bankErrors[0] });
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

        if (skipArchiveOnRequest) {
            const coreDeleteChecks = [
                {
                    sectionKey: "personal",
                    label: "Personal details",
                    keys: ["dateOfBirth", "maritalStatus", "numberOfDependents", "fathersName", "gender", "nationality"],
                },
                {
                    sectionKey: "permanentAddress",
                    label: "Permanent address",
                    keys: ["addressLine1", "addressLine2", "city", "state", "country", "postalCode"],
                },
                {
                    sectionKey: "currentAddress",
                    label: "Current address",
                    keys: [
                        "currentAddressLine1",
                        "currentAddressLine2",
                        "currentCity",
                        "currentState",
                        "currentCountry",
                        "currentPostalCode",
                    ],
                },
                {
                    sectionKey: "bank",
                    label: "Bank details",
                    keys: [
                        "bankName",
                        "accountName",
                        "accountNumber",
                        "ibanNumber",
                        "swiftCode",
                        "bankOtherDetails",
                        "bankAttachment",
                    ],
                },
            ];

            for (const check of coreDeleteChecks) {
                if (!isClearingProfileFields(updatePayload, check.keys)) continue;
                const denied = denyCoreEmployeeProfileDelete(check.sectionKey, check.label);
                if (denied) return res.status(denied.status).json(denied.body);
            }
        }

        // 5. If nothing to update
        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ message: "Nothing to update" });
        }

        /**
         * Queued HR preview: previousData must match the same fields as proposedData.
         * Salary lives on EmployeeSalary; bank on EmployeeBank; identity on EmployeeBasic.
         * (Old bug: always merged identity keys into previousData so "Current" showed name/email while "Edited" showed salary.)
         */
        const SALARY_PREVIOUS_KEYS = new Set([
            "basic",
            "houseRentAllowance",
            "otherAllowance",
            "additionalAllowances",
            "salaryHistory",
            "offerLetter",
            "monthlySalary",
            "totalSalary",
            "basicPercentage",
            "houseRentPercentage",
            "otherAllowancePercentage",
        ]);
        const BANK_PREVIOUS_KEYS = new Set([
            "bankName",
            "accountName",
            "accountNumber",
            "ibanNumber",
            "swiftCode",
            "ifscCode",
            "bankOtherDetails",
            "bankAttachment",
        ]);

        const buildBasicDetailsReactivationEntry = () => {
            const keysForSnapshot = Object.keys(updatePayload).filter((k) => allowedFields.includes(k));
            const previousData = {};
            for (const k of keysForSnapshot) {
                let v;
                if (SALARY_PREVIOUS_KEYS.has(k)) {
                    v = existingSalary?.[k];
                } else if (BANK_PREVIOUS_KEYS.has(k)) {
                    v = existingBank?.[k];
                } else if (existingBasic && Object.prototype.hasOwnProperty.call(existingBasic, k)) {
                    v = existingBasic[k];
                }
                if (v !== undefined) {
                    previousData[k] = v;
                }
            }

            const allSalary =
                keysForSnapshot.length > 0 && keysForSnapshot.every((k) => SALARY_PREVIOUS_KEYS.has(k));
            const allBank = keysForSnapshot.length > 0 && keysForSnapshot.every((k) => BANK_PREVIOUS_KEYS.has(k));
            const card = allSalary ? "Salary Details" : allBank ? "Bank Details" : "Basic Details";
            const reason = allSalary ? "Salary updated" : allBank ? "Bank details updated" : "Basic details updated";

            return {
                card,
                reason,
                section: "basicDetails",
                changeType: "update",
                targetIndex: null,
                previousData,
                proposedData: updatePayload,
            };
        };

        let updated = null;
        const basicChangeEntry = buildBasicDetailsReactivationEntry();
        const salaryTouchedEarly = [...SALARY_PREVIOUS_KEYS].some((k) =>
            Object.prototype.hasOwnProperty.call(updatePayload, k),
        );
        let salaryIncrementResult = { isIncrement: false, archived: false };
        const bankTouchedEarly = bankUpdateTouchesFields(updatePayload);
        // HR queue must never be bypassed by skipArchive (edit/add sends skipArchive: true).
        const applyLiveNow = !skipLive;

        if (salaryTouchedEarly && Object.prototype.hasOwnProperty.call(updatePayload, "salaryHistory")) {
            salaryIncrementResult = await archiveSalaryIncrementIfNeeded(employeeId, updatePayload);
        }

        if (bankTouchedEarly && applyLiveNow) {
            await archiveSupersededBankIfNeeded(employeeId, updatePayload, existingBank);
        }

        if (applyLiveNow) {
            updated = await saveEmployeeData(employeeId, updatePayload);

            if (!updated) {
                return res.status(404).json({ message: "Employee not found" });
            }

            const bankTouched = [...BANK_PREVIOUS_KEYS].some((k) =>
                Object.prototype.hasOwnProperty.call(updatePayload, k),
            );
            const salaryTouched = [...SALARY_PREVIOUS_KEYS].some((k) =>
                Object.prototype.hasOwnProperty.call(updatePayload, k),
            );

            if (salaryTouched) {
                await purgeSalaryOldDocumentsUnlessIncrement(employeeId, {
                    isIncrement: salaryIncrementResult.isIncrement,
                });
            }

            if (skipArchiveOnRequest) {
                const purgeTypes = [];
                if (Object.prototype.hasOwnProperty.call(updatePayload, "trainingDetails")) {
                    purgeTypes.push(...PURGE_TYPES.training);
                }

                if (purgeTypes.length) {
                    await purgeEmployeeOldDocuments(employeeId, {
                        types: purgeTypes,
                        purgeDeletedArchiveReason: true,
                    });
                }
            }

            await triggerProfileReactivationIfNeeded({
                employeeId,
                actor: req.user,
                reason: "Basic details updated",
                changeEntry: basicChangeEntry,
                trackDefaultChange: true,
            });
        } else {
            if (salaryTouchedEarly) {
                await purgeSalaryOldDocumentsUnlessIncrement(employeeId, {
                    isIncrement: salaryIncrementResult.isIncrement,
                });
            }
            await queueOrTriggerProfileChange({
                employeeId,
                actor: req.user,
                reason: "Basic details updated",
                employeeBasic: existingBasic,
                changeEntry: basicChangeEntry,
            });
            updated = await getCompleteEmployee(employeeId);
        }

        try {
            await markProfileActivationHoldResolvedForSection(employeeId, "basicDetails");
        } catch (_e) {
            /* non-fatal */
        }

        updated = await getCompleteEmployee(employeeId);
        if (!updated) {
            return res.status(404).json({ message: "Employee not found" });
        }

        delete updated.password;

        // 7. Return success
        return res.status(200).json({
            message: skipLive
                ? "Basic details change queued for HR activation approval."
                : "Basic details updated",
            queuedForHrApproval: !!skipLive,
            employee: updated,
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: err.message });
    }
};

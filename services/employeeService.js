import mongoose from "mongoose";
import EmployeeBasic from "../models/EmployeeBasic.js";
import EmployeeContact from "../models/EmployeeContact.js";
import EmployeePersonal from "../models/EmployeePersonal.js";
import EmployeePassport from "../models/EmployeePassport.js";
import EmployeeVisa from "../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../models/EmployeeDrivingLicense.js";
import EmployeeSalary from "../models/EmployeeSalary.js";
import EmployeeBank from "../models/EmployeeBank.js";
import EmployeeEducation from "../models/EmployeeEducation.js";
import EmployeeExperience from "../models/EmployeeExperience.js";
import EmployeeEmergencyContact from "../models/EmployeeEmergencyContact.js";
import EmployeeTraining from "../models/EmployeeTraining.js";
import User from "../models/User.js";
import { getSignedFileUrl } from "../utils/s3Upload.js";

/**
 * Get complete employee data by ID (can be _id or employeeId)
 * @param {string|ObjectId} id - Employee _id or employeeId
 * @returns {Promise<Object|null>} Complete employee object or null if not found
 */
export const getCompleteEmployee = async (id) => {
    try {
        // Query timeout options - prevent hanging queries
        const queryOptions = { maxTimeMS: 10000 }; // 10 second timeout per query

        // Determine if id is ObjectId or employeeId
        let employeeBasic;

        if (mongoose.Types.ObjectId.isValid(id) && id.toString().length === 24) {
            // It's an ObjectId
            employeeBasic = await EmployeeBasic.findById(id, null, queryOptions)
                .select('-documents.document.data -trainingDetails.certificate.data')
                .populate('reportingAuthority', 'firstName lastName employeeId email workEmail companyEmail')
                .populate('primaryReportee', 'firstName lastName employeeId email workEmail companyEmail')
                .populate('secondaryReportee', 'firstName lastName employeeId email workEmail companyEmail')
                .lean();
        } else {
            // It's an employeeId (string)
            employeeBasic = await EmployeeBasic.findOne({ employeeId: id }, null, queryOptions)
                .select('-documents.document.data -trainingDetails.certificate.data')
                .populate('reportingAuthority', 'firstName lastName employeeId email workEmail companyEmail')
                .populate('primaryReportee', 'firstName lastName employeeId email workEmail companyEmail')
                .populate('secondaryReportee', 'firstName lastName employeeId email workEmail companyEmail')
                .lean();

            // Support for legacy ID format (VEGA - XXXXX) during transition
            if (!employeeBasic && typeof id === 'string' && id.startsWith('VEGA - ') && !id.includes('-HR-')) {
                const legacyId = id.replace('VEGA - ', 'VEGA -HR- ');
                console.log(`[getCompleteEmployee] ID ${id} not found. Retrying with legacy mapping: ${legacyId}`);
                employeeBasic = await EmployeeBasic.findOne({ employeeId: legacyId }, null, queryOptions)
                    .select('-documents.document.data -trainingDetails.certificate.data')
                    .populate('reportingAuthority', 'firstName lastName employeeId email workEmail companyEmail')
                    .populate('primaryReportee', 'firstName lastName employeeId email workEmail companyEmail')
                    .populate('secondaryReportee', 'firstName lastName employeeId email workEmail companyEmail')
                    .lean();
            }
        }

        if (!employeeBasic) {
            return null;
        }

        const employeeId = employeeBasic.employeeId;

        // Fetch all related data in parallel with optimized field selection
        // Exclude large base64 document fields from initial queries to improve performance
        // Use Promise.allSettled to prevent one failure from breaking the entire request
        const [
            contactResult,
            personalResult,
            passportResult,
            visaResult,
            emiratesIdResult,
            labourCardResult,
            medicalInsuranceResult,
            drivingLicenseResult,
            salaryResult,
            bankResult,
            educationResult,
            experienceResult,
            emergencyContactResult,
            trainingResult
        ] = await Promise.allSettled([
            EmployeeContact.findOne({ employeeId }, null, queryOptions).select('-__v').lean(),
            EmployeePersonal.findOne({ employeeId }, null, queryOptions).select('-__v').lean(),
            EmployeePassport.findOne({ employeeId }, null, queryOptions).select('-__v -document.data').lean(),
            EmployeeVisa.findOne({ employeeId }, null, queryOptions).select('-__v -visit.document.data -employment.document.data -spouse.document.data').lean(),
            EmployeeEmiratesId.findOne({ employeeId }, null, queryOptions).select('-__v -emiratesId.document.data').lean(),
            EmployeeLabourCard.findOne({ employeeId }, null, queryOptions).select('-__v -labourCard.document.data').lean(),
            EmployeeMedicalInsurance.findOne({ employeeId }, null, queryOptions).select('-__v -medicalInsurance.document.data').lean(),
            EmployeeDrivingLicense.findOne({ employeeId }, null, queryOptions).select('-__v -drivingLicenceDetails.document.data').lean(),
            EmployeeSalary.findOne({ employeeId }, null, queryOptions).select('-__v -offerLetter.data -salaryHistory.attachment.data -salaryHistory.offerLetter.data').lean(),
            EmployeeBank.findOne({ employeeId }, null, queryOptions).select('-__v -bankAttachment.data').lean(),
            EmployeeEducation.findOne({ employeeId }, null, queryOptions).select('-__v -educationDetails.certificate.data').lean(),
            EmployeeExperience.findOne({ employeeId }, null, queryOptions).select('-__v -experienceDetails.certificate.data').lean(),
            EmployeeEmergencyContact.findOne({ employeeId }, null, queryOptions).select('-__v').lean(),
            EmployeeTraining.findOne({ employeeId }, null, queryOptions).select('-__v -trainingDetails.certificate.data').lean(),
        ]);

        // Extract values from Promise.allSettled results, handle errors gracefully
        const contact = contactResult.status === 'fulfilled' ? contactResult.value : null;
        const personal = personalResult.status === 'fulfilled' ? personalResult.value : null;
        const passport = passportResult.status === 'fulfilled' ? passportResult.value : null;
        const visa = visaResult.status === 'fulfilled' ? visaResult.value : null;
        const emiratesId = emiratesIdResult.status === 'fulfilled' ? emiratesIdResult.value : null;
        const labourCard = labourCardResult.status === 'fulfilled' ? labourCardResult.value : null;
        const medicalInsurance = medicalInsuranceResult.status === 'fulfilled' ? medicalInsuranceResult.value : null;
        const drivingLicense = drivingLicenseResult.status === 'fulfilled' ? drivingLicenseResult.value : null;
        const salary = salaryResult.status === 'fulfilled' ? salaryResult.value : null;
        const bank = bankResult.status === 'fulfilled' ? bankResult.value : null;
        const education = educationResult.status === 'fulfilled' ? educationResult.value : null;
        const experience = experienceResult.status === 'fulfilled' ? experienceResult.value : null;
        const emergencyContact = emergencyContactResult.status === 'fulfilled' ? emergencyContactResult.value : null;
        const training = trainingResult.status === 'fulfilled' ? trainingResult.value : null;

        // Log any failed queries (but don't fail the entire request)
        const failedQueries = [
            { name: 'contact', result: contactResult },
            { name: 'personal', result: personalResult },
            { name: 'passport', result: passportResult },
            { name: 'visa', result: visaResult },
            { name: 'emiratesId', result: emiratesIdResult },
            { name: 'labourCard', result: labourCardResult },
            { name: 'medicalInsurance', result: medicalInsuranceResult },
            { name: 'drivingLicense', result: drivingLicenseResult },
            { name: 'salary', result: salaryResult },
            { name: 'bank', result: bankResult },
            { name: 'education', result: educationResult },
            { name: 'experience', result: experienceResult },
            { name: 'emergencyContact', result: emergencyContactResult },
            { name: 'training', result: trainingResult },
        ].filter(item => item.result.status === 'rejected');

        if (failedQueries.length > 0) {
            console.warn(`[getCompleteEmployee] Some queries failed for employee ${employeeId}:`,
                failedQueries.map(q => `${q.name}: ${q.result.reason?.message || 'Unknown error'}`)
            );
        }

        // Combine all data into a single object
        // Exclude large base64 document fields from employeeBasic to reduce payload size (prevents connection reset)
        const { documents: basicDocuments, trainingDetails: basicTrainingDetails, ...employeeBasicWithoutDocs } = employeeBasic;

        // Helper to get signed URL if publicId exists, otherwise keep existing URL
        const resolveUrl = async (doc) => {
            if (!doc) return undefined;
            // If we have a publicId (S3 Key), generate a signed URL
            // If not, and we have a url, it might be legacy or external, keep it
            // Ideally we prioritized signed URL generation
            // But wait, the previous code structure for document object inside model was:
            // { name, mimeType, url, publicId, data }
            // In the aggregation below, we are constructing a safe object.
            // We need to resolve the URL here.

            // BUT, we can't easily run async inside the huge object literal construction below.
            // Strategy: Construct the object first with publicIds, then traverse and update URLs?
            // Or better: Resolve all URLs in parallel before constructing the object?
            // That's complex given the nested structure.

            // Let's construct the object as before, but include publicId in the safe object.
            // Then run a post-processing step to sign urls.
            return doc;
        };

        const completeEmployee = {
            ...employeeBasicWithoutDocs,
            // Include documents but exclude base64 data (metadata only) - reduces payload by ~90%
            documents: basicDocuments ? basicDocuments.map(doc => ({
                type: doc.type,
                description: doc.description,
                expiryDate: doc.expiryDate,
                createdAt: doc.createdAt,
                document: doc.document ? {
                    name: doc.document.name,
                    mimeType: doc.document.mimeType,
                    url: doc.document.url,
                    publicId: doc.document.publicId
                } : undefined,
            })) : [],
            // Include training details but exclude certificate base64 data
            trainingDetails: basicTrainingDetails ? basicTrainingDetails.map(training => ({
                trainingName: training.trainingName,
                trainingDetails: training.trainingDetails,
                provider: training.provider || training.trainingFrom,
                trainingDate: training.trainingDate,
                trainingCost: training.trainingCost,
                certificate: training.certificate ? {
                    name: training.certificate.name,
                    mimeType: training.certificate.mimeType,
                    url: training.certificate.url,
                    publicId: training.certificate.publicId
                } : undefined,
            })) : [],
            // Contact information
            ...(contact && {
                contactNumber: contact.contactNumber,
                addressLine1: contact.addressLine1,
                addressLine2: contact.addressLine2,
                country: contact.country,
                state: contact.state,
                city: contact.city,
                postalCode: contact.postalCode,
                currentAddressLine1: contact.currentAddressLine1,
                currentAddressLine2: contact.currentAddressLine2,
                currentCity: contact.currentCity,
                currentState: contact.currentState,
                currentCountry: contact.currentCountry,
                currentPostalCode: contact.currentPostalCode,
            }),
            // Personal details
            ...(personal && {
                gender: personal.gender,
                dateOfBirth: personal.dateOfBirth,
                age: personal.age,
                maritalStatus: personal.maritalStatus,
                numberOfDependents: personal.numberOfDependents,
                nationality: personal.nationality,
                fathersName: personal.fathersName,
            }),
            // Passport details - exclude large document.data field to reduce payload size
            ...(passport && {
                passportDetails: {
                    number: passport.number,
                    nationality: passport.nationality,
                    issueDate: passport.issueDate,
                    expiryDate: passport.expiryDate,
                    placeOfIssue: passport.placeOfIssue,
                    document: passport.document ? {
                        name: passport.document.name,
                        mimeType: passport.document.mimeType,
                        url: passport.document.url,
                        publicId: passport.document.publicId
                    } : undefined,
                    lastUpdated: passport.lastUpdated,
                },
                passportExp: passport.passportExp,
                eidExp: passport.eidExp,
                medExp: passport.medExp,
            }),
            // Visa details - exclude large document.data fields to reduce payload
            ...(visa && {
                visaDetails: {
                    visit: visa.visit ? {
                        number: visa.visit.number,
                        issueDate: visa.visit.issueDate,
                        expiryDate: visa.visit.expiryDate,
                        sponsor: visa.visit.sponsor,
                        document: visa.visit.document ? {
                            name: visa.visit.document.name,
                            mimeType: visa.visit.document.mimeType,
                            url: visa.visit.document.url,
                            publicId: visa.visit.document.publicId
                        } : undefined,
                        lastUpdated: visa.visit.lastUpdated,
                    } : undefined,
                    employment: visa.employment ? {
                        number: visa.employment.number,
                        issueDate: visa.employment.issueDate,
                        expiryDate: visa.employment.expiryDate,
                        sponsor: visa.employment.sponsor,
                        document: visa.employment.document ? {
                            name: visa.employment.document.name,
                            mimeType: visa.employment.document.mimeType,
                            url: visa.employment.document.url,
                            publicId: visa.employment.document.publicId
                        } : undefined,
                        lastUpdated: visa.employment.lastUpdated,
                    } : undefined,
                    spouse: visa.spouse ? {
                        number: visa.spouse.number,
                        issueDate: visa.spouse.issueDate,
                        expiryDate: visa.spouse.expiryDate,
                        sponsor: visa.spouse.sponsor,
                        document: visa.spouse.document ? {
                            name: visa.spouse.document.name,
                            mimeType: visa.spouse.document.mimeType,
                            url: visa.spouse.document.url,
                            publicId: visa.spouse.document.publicId
                        } : undefined,
                        lastUpdated: visa.spouse.lastUpdated,
                    } : undefined,
                },
            }),
            // Emirates ID details - exclude large document.data field
            ...(emiratesId && {
                emiratesIdDetails: emiratesId.emiratesId ? {
                    number: emiratesId.emiratesId.number,
                    issueDate: emiratesId.emiratesId.issueDate,
                    expiryDate: emiratesId.emiratesId.expiryDate,
                    document: emiratesId.emiratesId.document ? {
                        name: emiratesId.emiratesId.document.name,
                        mimeType: emiratesId.emiratesId.document.mimeType,
                        url: emiratesId.emiratesId.document.url,
                        publicId: emiratesId.emiratesId.document.publicId
                    } : undefined,
                    lastUpdated: emiratesId.emiratesId.lastUpdated,
                } : undefined,
            }),
            // Labour Card details - exclude large document.data field
            ...(labourCard && {
                labourCardDetails: labourCard.labourCard ? {
                    number: labourCard.labourCard.number,
                    issueDate: labourCard.labourCard.issueDate,
                    expiryDate: labourCard.labourCard.expiryDate,
                    document: labourCard.labourCard.document ? {
                        name: labourCard.labourCard.document.name,
                        mimeType: labourCard.labourCard.document.mimeType,
                        url: labourCard.labourCard.document.url,
                        publicId: labourCard.labourCard.document.publicId
                    } : undefined,
                    lastUpdated: labourCard.labourCard.lastUpdated,
                } : undefined,
            }),
            // Medical Insurance details - exclude large document.data field
            ...(medicalInsurance && {
                medicalInsuranceDetails: medicalInsurance.medicalInsurance ? {
                    provider: medicalInsurance.medicalInsurance.provider,
                    number: medicalInsurance.medicalInsurance.number,
                    issueDate: medicalInsurance.medicalInsurance.issueDate,
                    expiryDate: medicalInsurance.medicalInsurance.expiryDate,
                    document: medicalInsurance.medicalInsurance.document ? {
                        name: medicalInsurance.medicalInsurance.document.name,
                        mimeType: medicalInsurance.medicalInsurance.document.mimeType,
                        url: medicalInsurance.medicalInsurance.document.url,
                        publicId: medicalInsurance.medicalInsurance.document.publicId
                    } : undefined,
                    lastUpdated: medicalInsurance.medicalInsurance.lastUpdated,
                } : undefined,
            }),
            // Driving License details - exclude large document.data field
            ...(drivingLicense && {
                drivingLicenceDetails: drivingLicense.drivingLicenceDetails ? {
                    number: drivingLicense.drivingLicenceDetails.number,
                    issueDate: drivingLicense.drivingLicenceDetails.issueDate,
                    expiryDate: drivingLicense.drivingLicenceDetails.expiryDate,
                    document: drivingLicense.drivingLicenceDetails.document ? {
                        name: drivingLicense.drivingLicenceDetails.document.name,
                        mimeType: drivingLicense.drivingLicenceDetails.document.mimeType,
                        url: drivingLicense.drivingLicenceDetails.document.url,
                        publicId: drivingLicense.drivingLicenceDetails.document.publicId
                    } : undefined,
                    lastUpdated: drivingLicense.drivingLicenceDetails.lastUpdated,
                } : undefined,
            }),
            // Salary details
            ...(salary && {
                monthlySalary: salary.monthlySalary,
                totalSalary: salary.totalSalary || salary.monthlySalary,
                basic: salary.basic,
                basicPercentage: salary.basicPercentage,
                houseRentAllowance: salary.houseRentAllowance,
                houseRentPercentage: salary.houseRentPercentage,
                otherAllowance: salary.otherAllowance,
                otherAllowancePercentage: salary.otherAllowancePercentage,
                additionalAllowances: salary.additionalAllowances || [],
                // Exclude large attachment/offerLetter.data from salary history (but include URLs)
                salaryHistory: salary.salaryHistory ? salary.salaryHistory.map(entry => ({
                    ...entry,
                    attachment: entry.attachment ? {
                        url: entry.attachment.url,
                        publicId: entry.attachment.publicId,
                        name: entry.attachment.name,
                        mimeType: entry.attachment.mimeType,
                    } : undefined,
                    offerLetter: entry.offerLetter ? {
                        url: entry.offerLetter.url,
                        publicId: entry.offerLetter.publicId,
                        name: entry.offerLetter.name,
                        mimeType: entry.offerLetter.mimeType,
                    } : undefined,
                })) : [],
                // Exclude offerLetter.data - fetch separately if needed (but include URL)
                offerLetter: salary.offerLetter ? {
                    url: salary.offerLetter.url,
                    publicId: salary.offerLetter.publicId,
                    name: salary.offerLetter.name,
                    mimeType: salary.offerLetter.mimeType,
                } : undefined,
            }),
            // Bank details - exclude large bankAttachment.data
            ...(bank && {
                bankName: bank.bankName,
                accountName: bank.accountName,
                accountNumber: bank.accountNumber,
                ibanNumber: bank.ibanNumber,
                swiftCode: bank.swiftCode,
                bankOtherDetails: bank.bankOtherDetails,
                // Include bankAttachment.url for viewing, exclude bankAttachment.data to reduce payload
                bankAttachment: bank.bankAttachment ? {
                    name: bank.bankAttachment.name,
                    mimeType: bank.bankAttachment.mimeType,
                    url: bank.bankAttachment.url,
                    publicId: bank.bankAttachment.publicId
                } : undefined,
            }),
            // Education details - exclude large certificate.data fields
            ...(education && {
                educationDetails: education.educationDetails ? education.educationDetails.map(edu => ({
                    ...edu,
                    certificate: edu.certificate ? {
                        name: edu.certificate.name,
                        mimeType: edu.certificate.mimeType,
                        url: edu.certificate.url,
                        publicId: edu.certificate.publicId
                    } : undefined,
                })) : [],
            }),
            // Experience details - exclude large certificate.data fields
            ...(experience && {
                experienceDetails: experience.experienceDetails ? experience.experienceDetails.map(exp => ({
                    ...exp,
                    certificate: exp.certificate ? {
                        name: exp.certificate.name,
                        mimeType: exp.certificate.mimeType,
                        url: exp.certificate.url,
                        publicId: exp.certificate.publicId
                    } : undefined,
                })) : [],
            }),
            // Emergency contact details
            ...(emergencyContact && {
                emergencyContacts: emergencyContact.emergencyContacts || [],
                emergencyContactName: emergencyContact.emergencyContactName,
                emergencyContactRelation: emergencyContact.emergencyContactRelation,
                emergencyContactNumber: emergencyContact.emergencyContactNumber,
            }),
            // Training details from EmployeeTraining model (if exists, will override basic trainingDetails)
            ...(training && {
                trainingDetailsFromTraining: training.trainingDetails ? training.trainingDetails.map(t => ({
                    ...t,
                    certificate: t.certificate ? {
                        name: t.certificate.name,
                        mimeType: t.certificate.mimeType,
                        url: t.certificate.url,
                        publicId: t.certificate.publicId
                    } : undefined,
                })) : [],
            }),
        };

        // --- POST-PROCESSING: Signed URL Generation ---
        const signUrl = async (obj, context = 'unknown') => {
            if (!obj) return;

            let keyToSign = obj?.publicId;

            // Fallback: If no publicId, try to extract key from legacy URL
            if (!keyToSign && obj?.url && typeof obj.url === 'string' && obj.url.includes('idrivee2.com')) {
                try {
                    // Legacy URL format: https://[endpoint]/[bucket]/[key]
                    // or https://[bucket].[endpoint]/[key]

                    // Robust Legacy Key Extraction
                    const urlObj = new URL(obj.url);
                    let path = urlObj.pathname; // e.g. "/key" or "/bucket/key"

                    // Remove leading slash
                    if (path.startsWith('/')) path = path.substring(1);

                    // Check if path starts with bucket name (Path Style)
                    const bucketPrefix = `${process.env.IDRIVE_BUCKET_NAME}/`;
                    if (path.startsWith(bucketPrefix)) {
                        path = path.substring(bucketPrefix.length);
                    }

                    // Decode URI component (e.g. %20 -> space) to get actual key
                    keyToSign = decodeURIComponent(path);

                    // console.log(`[DEBUG] Extracted legacy key for ${context}:`, keyToSign);
                } catch (err) {
                    console.error(`[DEBUG] Error parsing legacy URL for ${context}:`, err);
                }
            }

            if (keyToSign) {
                try {
                    // Sanitize Key
                    keyToSign = decodeURIComponent(keyToSign);

                    // Remove leading slash
                    if (keyToSign.startsWith('/')) keyToSign = keyToSign.substring(1);

                    // Remove bucket name prefix if present
                    const bucketName = process.env.IDRIVE_BUCKET_NAME || 'verp-storage';
                    if (keyToSign.startsWith(`${bucketName}/`)) {
                        keyToSign = keyToSign.substring(bucketName.length + 1);
                    }

                    // Specific fix for malformed keys containing bucket name in middle (as reported)
                    // If key contains bucketName that is NOT at start, it might be a concatenation error
                    if (keyToSign.includes(bucketName)) {
                        // Example error: path/to/fileverp-storage/path/to/file
                        // We'll try to extract the clean path.
                        // Assuming path starts with 'employee-documents/'
                        const match = keyToSign.match(/^(employee-documents\/.*?)(?:verp-storage|$)/);
                        if (match && match[1]) {
                            keyToSign = match[1];
                        } else {
                            // Fallback: simple replace
                            keyToSign = keyToSign.replace(bucketName, '').replace('//', '/');
                        }
                    }

                    const signedUrl = await getSignedFileUrl(keyToSign);
                    if (signedUrl) {
                        obj.url = signedUrl;
                    } else if (context === 'profilePicture') {
                        // console.error(`[DEBUG] Profile Picture Signing Returned Null (Key: ${keyToSign})`);
                    }
                } catch (e) {
                    console.error(`[DEBUG] Failed to sign URL for ${context}:`, e.message);
                }
            }
        };

        const signingPromises = [];

        // Profile Picture
        if (completeEmployee.profilePicture) {
            // Handle profilePicture being a string URL directly
            if (typeof completeEmployee.profilePicture === 'string') {
                const url = completeEmployee.profilePicture;
                // Create a temporary object to pass to signUrl
                const tempObj = { url, publicId: null };

                // Helper to extract key from string URL if possible
                if (url.includes('idrivee2.com')) {
                    try {
                        const urlObj = new URL(url);
                        let path = urlObj.pathname;
                        if (path.startsWith('/')) path = path.substring(1);
                        const bucketPrefix = `${process.env.IDRIVE_BUCKET_NAME}/`;
                        if (path.startsWith(bucketPrefix)) {
                            path = path.substring(bucketPrefix.length);
                        }
                        tempObj.publicId = decodeURIComponent(path);
                    } catch (e) {
                        console.error('Error parsing profile URL for key:', e);
                    }
                }

                // Add to signing promises
                signingPromises.push(
                    signUrl(tempObj, 'profilePicture').then(() => {
                        // Update the profilePicture property with the new signed URL
                        if (tempObj.url !== url) {
                            completeEmployee.profilePicture = tempObj.url;
                        }
                    })
                );
            } else {
                // It's already an object (unlikely for profilePicture based on schema, but good for safety)
                signingPromises.push(signUrl(completeEmployee.profilePicture, 'profilePicture'));
            }
        }

        // Basic Documents
        if (completeEmployee.documents) {
            completeEmployee.documents.forEach((doc, idx) => {
                if (doc.document) signingPromises.push(signUrl(doc.document, `document[${idx}]`));
            });
        }
        // Basic Training
        if (completeEmployee.trainingDetails) {
            completeEmployee.trainingDetails.forEach((t, idx) => {
                if (t.certificate) signingPromises.push(signUrl(t.certificate, `training[${idx}]`));
            });
        }
        // Passport
        if (completeEmployee.passportDetails?.document) {
            signingPromises.push(signUrl(completeEmployee.passportDetails.document, 'passport'));
        }
        // Visa
        if (completeEmployee.visaDetails) {
            if (completeEmployee.visaDetails.visit?.document) signingPromises.push(signUrl(completeEmployee.visaDetails.visit.document, 'visa.visit'));
            if (completeEmployee.visaDetails.employment?.document) signingPromises.push(signUrl(completeEmployee.visaDetails.employment.document, 'visa.employment'));
            if (completeEmployee.visaDetails.spouse?.document) signingPromises.push(signUrl(completeEmployee.visaDetails.spouse.document, 'visa.spouse'));
        }
        // Emirates ID
        if (completeEmployee.emiratesIdDetails?.document) {
            signingPromises.push(signUrl(completeEmployee.emiratesIdDetails.document));
        }
        // Labour Card
        if (completeEmployee.labourCardDetails?.document) {
            signingPromises.push(signUrl(completeEmployee.labourCardDetails.document));
        }
        // Medical Insurance
        if (completeEmployee.medicalInsuranceDetails?.document) {
            signingPromises.push(signUrl(completeEmployee.medicalInsuranceDetails.document));
        }
        // Driving License
        if (completeEmployee.drivingLicenceDetails?.document) {
            signingPromises.push(signUrl(completeEmployee.drivingLicenceDetails.document));
        }
        // Salary
        if (completeEmployee.salaryHistory) {
            completeEmployee.salaryHistory.forEach(entry => {
                if (entry.attachment) signingPromises.push(signUrl(entry.attachment));
                if (entry.offerLetter) signingPromises.push(signUrl(entry.offerLetter));
            });
        }
        if (completeEmployee.offerLetter) {
            signingPromises.push(signUrl(completeEmployee.offerLetter));
        }
        // Bank
        if (completeEmployee.bankAttachment) {
            signingPromises.push(signUrl(completeEmployee.bankAttachment));
        }
        // Education
        if (completeEmployee.educationDetails) {
            completeEmployee.educationDetails.forEach(edu => {
                if (edu.certificate) signingPromises.push(signUrl(edu.certificate));
            });
        }
        // Experience
        if (completeEmployee.experienceDetails) {
            completeEmployee.experienceDetails.forEach(exp => {
                if (exp.certificate) signingPromises.push(signUrl(exp.certificate));
            });
        }
        // Training (External)
        if (completeEmployee.trainingDetailsFromTraining) {
            completeEmployee.trainingDetailsFromTraining.forEach(t => {
                // Map trainingFrom to provider if provider is missing (for external model)
                if (!t.provider && t.trainingFrom) t.provider = t.trainingFrom;
                if (t.certificate) signingPromises.push(signUrl(t.certificate));
            });
        }

        // Notice Request Attachment
        if (completeEmployee.noticeRequest?.attachment) {
            signingPromises.push(signUrl(completeEmployee.noticeRequest.attachment));
        }

        // Wait for all URLs to be signed
        await Promise.all(signingPromises);

        return completeEmployee;
    } catch (error) {
        console.error('[getCompleteEmployee] Error fetching employee:', id);
        console.error('[getCompleteEmployee] Error details:', error.message);
        console.error('[getCompleteEmployee] Stack trace:', error.stack);

        // Re-throw with more context
        const enhancedError = new Error(`Failed to fetch complete employee data: ${error.message}`);
        enhancedError.originalError = error;
        enhancedError.employeeId = id;
        throw enhancedError;
    }
};

/**
 * Save/update employee data across multiple collections
 * @param {string} employeeId - Employee ID
 * @param {Object} updatePayload - Fields to update
 * @returns {Promise<Object|null>} Updated complete employee object or null if not found
 */
export const saveEmployeeData = async (employeeId, updatePayload) => {
    try {
        // Check if employee exists
        const employee = await EmployeeBasic.findOne({ employeeId });
        if (!employee) {
            return null;
        }

        // Define field mappings to collections
        const basicFields = [
            'employeeId', 'firstName', 'lastName', 'role', 'department', 'designation',
            'status', 'probationPeriod', 'reportingAuthority', 'primaryReportee', 'secondaryReportee', 'overtime',
            'profileApprovalStatus', 'profileStatus', 'email', 'companyEmail', 'password',
            'enablePortalAccess', 'dateOfJoining', 'contractJoiningDate', 'profilePicture', 'documents', 'trainingDetails'
        ];

        const contactFields = [
            'contactNumber', 'addressLine1', 'addressLine2', 'country', 'state',
            'city', 'postalCode', 'currentAddressLine1', 'currentAddressLine2',
            'currentCity', 'currentState', 'currentCountry', 'currentPostalCode'
        ];

        const personalFields = [
            'gender', 'dateOfBirth', 'age', 'maritalStatus', 'numberOfDependents', 'nationality', 'fathersName'
        ];

        const passportFields = [
            'passportExp', 'eidExp', 'medExp'
        ];

        const salaryFields = [
            'monthlySalary', 'basic', 'basicPercentage', 'houseRentAllowance',
            'houseRentPercentage', 'otherAllowance', 'otherAllowancePercentage',
            'additionalAllowances', 'salaryHistory', 'offerLetter'
        ];

        const bankFields = [
            'bankName', 'accountName', 'accountNumber', 'ibanNumber',
            'swiftCode', 'bankOtherDetails', 'bankAttachment'
        ];

        // Separate fields by collection
        const basicUpdate = {};
        const contactUpdate = {};
        const personalUpdate = {};
        const passportUpdate = {};
        const salaryUpdate = {};
        const bankUpdate = {};

        Object.keys(updatePayload).forEach(field => {
            if (basicFields.includes(field)) {
                basicUpdate[field] = updatePayload[field];
            } else if (contactFields.includes(field)) {
                contactUpdate[field] = updatePayload[field];
            } else if (personalFields.includes(field)) {
                personalUpdate[field] = updatePayload[field];
            } else if (passportFields.includes(field)) {
                passportUpdate[field] = updatePayload[field];
            } else if (salaryFields.includes(field)) {
                salaryUpdate[field] = updatePayload[field];
            } else if (bankFields.includes(field)) {
                bankUpdate[field] = updatePayload[field];
            }
        });

        // Update collections in parallel
        const updatePromises = [];

        if (Object.keys(basicUpdate).length > 0) {
            updatePromises.push(
                EmployeeBasic.findOneAndUpdate(
                    { employeeId },
                    { $set: basicUpdate },
                    { new: true }
                )
            );
        }

        if (Object.keys(contactUpdate).length > 0) {
            updatePromises.push(
                EmployeeContact.findOneAndUpdate(
                    { employeeId },
                    { $set: contactUpdate },
                    { upsert: true, new: true }
                )
            );
        }

        if (Object.keys(personalUpdate).length > 0) {
            updatePromises.push(
                EmployeePersonal.findOneAndUpdate(
                    { employeeId },
                    { $set: personalUpdate },
                    { upsert: true, new: true }
                )
            );
        }

        if (Object.keys(passportUpdate).length > 0) {
            updatePromises.push(
                EmployeePassport.findOneAndUpdate(
                    { employeeId },
                    { $set: passportUpdate },
                    { upsert: true, new: true }
                )
            );
        }

        if (Object.keys(salaryUpdate).length > 0) {
            // Calculate total salary if salary fields are being updated
            if (salaryUpdate.salaryHistory && Array.isArray(salaryUpdate.salaryHistory)) {
                // Calculate total salary for each history entry
                salaryUpdate.salaryHistory = salaryUpdate.salaryHistory.map(entry => {
                    const basic = parseFloat(entry.basic) || 0;
                    const houseRentAllowance = parseFloat(entry.houseRentAllowance) || 0;
                    const otherAllowance = parseFloat(entry.otherAllowance) || 0;
                    const vehicleAllowance = parseFloat(entry.vehicleAllowance) || 0;
                    const fuelAllowance = parseFloat(entry.fuelAllowance) || 0;
                    // Calculate additional allowances excluding vehicle and fuel (already counted separately)
                    const additionalAllowances = Array.isArray(entry.additionalAllowances)
                        ? entry.additionalAllowances
                            .filter(item => !item.type?.toLowerCase().includes('vehicle') && !item.type?.toLowerCase().includes('fuel'))
                            .reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0)
                        : 0;

                    const totalSalary = basic + houseRentAllowance + otherAllowance + vehicleAllowance + fuelAllowance + additionalAllowances;

                    return {
                        ...entry,
                        totalSalary: totalSalary,
                        // Include all allowances in the entry
                        houseRentAllowance: houseRentAllowance,
                        vehicleAllowance: vehicleAllowance,
                        fuelAllowance: fuelAllowance,
                        additionalAllowances: entry.additionalAllowances || []
                    };
                });
            }

            // Also calculate total for current salary if basic/otherAllowance/houseRentAllowance are being updated
            if (salaryUpdate.basic !== undefined || salaryUpdate.otherAllowance !== undefined ||
                salaryUpdate.houseRentAllowance !== undefined || salaryUpdate.additionalAllowances !== undefined) {
                // Get current salary record to calculate total
                const currentSalary = await EmployeeSalary.findOne({ employeeId }).lean();
                const basic = parseFloat(salaryUpdate.basic !== undefined ? salaryUpdate.basic : (currentSalary?.basic || 0)) || 0;
                const houseRentAllowance = parseFloat(salaryUpdate.houseRentAllowance !== undefined ? salaryUpdate.houseRentAllowance : (currentSalary?.houseRentAllowance || 0)) || 0;
                const otherAllowance = parseFloat(salaryUpdate.otherAllowance !== undefined ? salaryUpdate.otherAllowance : (currentSalary?.otherAllowance || 0)) || 0;
                const additionalAllowances = salaryUpdate.additionalAllowances || currentSalary?.additionalAllowances || [];
                const additionalTotal = Array.isArray(additionalAllowances)
                    ? additionalAllowances.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0)
                    : 0;

                const calculatedTotal = basic + houseRentAllowance + otherAllowance + additionalTotal;
                salaryUpdate.monthlySalary = calculatedTotal;
                salaryUpdate.totalSalary = calculatedTotal; // Store totalSalary in DB
            }

            updatePromises.push(
                EmployeeSalary.findOneAndUpdate(
                    { employeeId },
                    { $set: salaryUpdate },
                    { upsert: true, new: true }
                )
            );
        }

        if (Object.keys(bankUpdate).length > 0) {
            updatePromises.push(
                EmployeeBank.findOneAndUpdate(
                    { employeeId },
                    { $set: bankUpdate },
                    { upsert: true, new: true }
                )
            );
        }

        await Promise.all(updatePromises);

        // Sync companyEmail to User model if updated
        if (basicUpdate.companyEmail !== undefined) {
            try {
                // Find linked User by employeeId and update their companyEmail
                await User.findOneAndUpdate(
                    { employeeId: employeeId },
                    { $set: { companyEmail: basicUpdate.companyEmail } }
                );
            } catch (err) {
                console.error(`[saveEmployeeData] Error syncing companyEmail to User record for ${employeeId}:`, err);
            }
        }

        // Return complete updated employee
        return await getCompleteEmployee(employeeId);
    } catch (error) {
        console.error('Error in saveEmployeeData:', error);
        throw error;
    }
};

/**
 * Delete employee data from all collections
 * @param {string} employeeId - Employee ID
 * @returns {Promise<void>}
 */
export const deleteEmployeeData = async (employeeId) => {
    try {
        // Delete from all collections in parallel
        await Promise.all([
            EmployeeBasic.findOneAndDelete({ employeeId }),
            EmployeeContact.findOneAndDelete({ employeeId }),
            EmployeePersonal.findOneAndDelete({ employeeId }),
            EmployeePassport.findOneAndDelete({ employeeId }),
            EmployeeVisa.findOneAndDelete({ employeeId }),
            EmployeeEmiratesId.findOneAndDelete({ employeeId }),
            EmployeeSalary.findOneAndDelete({ employeeId }),
            EmployeeBank.findOneAndDelete({ employeeId }),
            EmployeeEducation.findOneAndDelete({ employeeId }),
            EmployeeExperience.findOneAndDelete({ employeeId }),
            EmployeeEmergencyContact.findOneAndDelete({ employeeId }),
            EmployeeTraining.findOneAndDelete({ employeeId }),
        ]);
    } catch (error) {
        console.error('Error in deleteEmployeeData:', error);
        throw error;
    }
};

/**
 * Efficiently resolve employeeId from _id or employeeId string without fetching full data
 * @param {string} id - Employee _id or employeeId
 * @returns {Promise<Object|null>} Object with { _id, employeeId } or null
 */
export const resolveEmployeeId = async (id) => {
    try {
        let employee;

        if (mongoose.Types.ObjectId.isValid(id) && id.toString().length === 24) {
            employee = await EmployeeBasic.findById(id, null, { maxTimeMS: 5000 }).select('employeeId').lean();
        } else {
            employee = await EmployeeBasic.findOne({ employeeId: id }, null, { maxTimeMS: 5000 }).select('employeeId').lean();
        }

        if (!employee) return null;

        return {
            _id: employee._id,
            employeeId: employee.employeeId
        };
    } catch (error) {
        console.error('Error resolving employee ID:', error);
        return null;
    }
};

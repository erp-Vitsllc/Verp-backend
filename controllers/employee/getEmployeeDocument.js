import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeVisa from "../../models/EmployeeVisa.js";
import EmployeeEmiratesId from "../../models/EmployeeEmiratesId.js";
import EmployeeLabourCard from "../../models/EmployeeLabourCard.js";
import EmployeeMedicalInsurance from "../../models/EmployeeMedicalInsurance.js";
import EmployeeDrivingLicense from "../../models/EmployeeDrivingLicense.js";
import EmployeeEducation from "../../models/EmployeeEducation.js";
import EmployeeExperience from "../../models/EmployeeExperience.js";
import EmployeeTraining from "../../models/EmployeeTraining.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import EmployeeBank from "../../models/EmployeeBank.js";
import { resolveEmployeeId } from "../../services/employeeService.js";

export const getEmployeeDocument = async (req, res) => {
    const { id } = req.params;
    const { type, subType, docId } = req.query;

    if (!type) {
        return res.status(400).json({ message: "Document type is required" });
    }

    try {
        // Resolve employeeId
        const employee = await resolveEmployeeId(id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }
        const employeeId = employee.employeeId;

        let documentData = null;
        let documentName = null;
        let mimeType = null;

        switch (type) {
            case 'passport':
                const passport = await EmployeePassport.findOne({ employeeId }).select('document');
                if (passport?.document) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = passport.document.url || passport.document.data;
                    documentName = passport.document.name;
                    mimeType = passport.document.mimeType;
                }
                break;

            case 'visa':
            case 'visa-visit':
            case 'visa-employment':
            case 'visa-spouse':
                const visa = await EmployeeVisa.findOne({ employeeId });
                // Handle visa-visit, visa-employment, visa-spouse format
                const visaSubType = subType || (type.includes('-') ? type.split('-')[1] : null);
                if (visa && visaSubType && visa[visaSubType]?.document) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = visa[visaSubType].document.url || visa[visaSubType].document.data;
                    documentName = visa[visaSubType].document.name;
                    mimeType = visa[visaSubType].document.mimeType;
                }
                break;

            case 'emiratesId':
                const eid = await EmployeeEmiratesId.findOne({ employeeId });
                if (eid?.emiratesId?.document) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = eid.emiratesId.document.url || eid.emiratesId.document.data;
                    documentName = eid.emiratesId.document.name;
                    mimeType = eid.emiratesId.document.mimeType;
                }
                break;

            case 'labourCard':
                const labour = await EmployeeLabourCard.findOne({ employeeId });
                if (labour?.labourCard?.document) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = labour.labourCard.document.url || labour.labourCard.document.data;
                    documentName = labour.labourCard.document.name;
                    mimeType = labour.labourCard.document.mimeType;
                }
                break;

            case 'medicalInsurance':
                const med = await EmployeeMedicalInsurance.findOne({ employeeId });
                if (med?.medicalInsurance?.document) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = med.medicalInsurance.document.url || med.medicalInsurance.document.data;
                    documentName = med.medicalInsurance.document.name;
                    mimeType = med.medicalInsurance.document.mimeType;
                }
                break;

            case 'drivingLicense':
                const dl = await EmployeeDrivingLicense.findOne({ employeeId });
                if (dl?.drivingLicenceDetails?.document) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = dl.drivingLicenceDetails.document.url || dl.drivingLicenceDetails.document.data;
                    documentName = dl.drivingLicenceDetails.document.name;
                    mimeType = dl.drivingLicenceDetails.document.mimeType;
                }
                break;

            case 'education':
                if (!docId) return res.status(400).json({ message: "Document ID is required for education" });
                const edu = await EmployeeEducation.findOne({ employeeId });
                const eduItem = edu?.educationDetails?.id(docId);
                if (eduItem?.certificate) {
                    documentData = eduItem.certificate.data;
                    documentName = eduItem.certificate.name;
                    mimeType = eduItem.certificate.mimeType;
                }
                break;

            case 'experience':
                if (!docId) return res.status(400).json({ message: "Document ID is required for experience" });
                const exp = await EmployeeExperience.findOne({ employeeId });
                const expItem = exp?.experienceDetails?.id(docId);
                if (expItem?.certificate) {
                    documentData = expItem.certificate.data;
                    documentName = expItem.certificate.name;
                    mimeType = expItem.certificate.mimeType;
                }
                break;

            case 'training':
                if (!docId) return res.status(400).json({ message: "Document ID is required for training" });
                const training = await EmployeeTraining.findOne({ employeeId });
                const trainItem = training?.trainingDetails?.id(docId);
                if (trainItem?.certificate) {
                    documentData = trainItem.certificate.data;
                    documentName = trainItem.certificate.name;
                    mimeType = trainItem.certificate.mimeType;
                }
                break;

            case 'basic': // For documents array in EmployeeBasic
                if (!docId) return res.status(400).json({ message: "Document ID is required for basic documents" });
                const basic = await EmployeeBasic.findOne({ employeeId });
                const basicDoc = basic?.documents?.id(docId);
                if (basicDoc?.document) {
                    documentData = basicDoc.document.data;
                    documentName = basicDoc.document.name;
                    mimeType = basicDoc.document.mimeType;
                }
                break;

            case 'bankAttachment':
                const bank = await EmployeeBank.findOne({ employeeId });
                if (bank?.bankAttachment) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = bank.bankAttachment.url || bank.bankAttachment.data;
                    documentName = bank.bankAttachment.name;
                    mimeType = bank.bankAttachment.mimeType;
                }
                break;

            case 'offerLetter':
                const salary = await EmployeeSalary.findOne({ employeeId });
                if (salary?.offerLetter) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = salary.offerLetter.url || salary.offerLetter.data;
                    documentName = salary.offerLetter.name;
                    mimeType = salary.offerLetter.mimeType;
                }
                break;

            case 'salaryOfferLetter':
                if (!docId) return res.status(400).json({ message: "Document ID (salary history ID) is required for salaryOfferLetter" });
                const sl = await EmployeeSalary.findOne({ employeeId });
                if (!sl) {
                    return res.status(404).json({ message: "Salary record not found" });
                }
                // Try to find the history item by _id
                const historyItem = sl?.salaryHistory?.id(docId) ||
                    sl?.salaryHistory?.find(entry => entry._id?.toString() === docId.toString());
                if (historyItem?.offerLetter) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = historyItem.offerLetter.url || historyItem.offerLetter.data;
                    documentName = historyItem.offerLetter.name;
                    mimeType = historyItem.offerLetter.mimeType;
                } else {
                    return res.status(404).json({ message: "Offer letter not found for this salary history entry" });
                }
                break;

            case 'notice':
                const noticeEmp = await EmployeeBasic.findOne({ employeeId });
                if (noticeEmp?.noticeRequest?.attachment) {
                    // Check if it's a Cloudinary URL (new format) or base64 (old format)
                    documentData = noticeEmp.noticeRequest.attachment.url || noticeEmp.noticeRequest.attachment.data;
                    documentName = noticeEmp.noticeRequest.attachment.name;
                    mimeType = noticeEmp.noticeRequest.attachment.mimeType;
                }
                break;

            default:
                return res.status(400).json({ message: "Invalid document type" });
        }

        if (!documentData) {
            return res.status(404).json({ message: "Document not found" });
        }

        // Check if documentData is a Cloudinary URL (starts with http)
        const isCloudinaryUrl = documentData && (documentData.startsWith('http://') || documentData.startsWith('https://'));

        return res.json({
            name: documentName,
            mimeType: mimeType,
            data: documentData,
            isCloudinaryUrl: isCloudinaryUrl // Flag to indicate if it's a Remote URL (legacy name)
        });

    } catch (error) {
        console.error('Error fetching document:', error);
        return res.status(500).json({ message: "Failed to fetch document", error: error.message });
    }
};

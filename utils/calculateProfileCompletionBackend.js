import {
    employeeRequiresEmiratesId,
    employeeRequiresLabourCard,
    employeeRequiresBankDetails,
} from "./employeeRequiresEmiratesId.js";
import { isEmployeeUaeNationality } from "./employeeUaeNationality.js";

const checkField = (val) => {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string' && val.trim() === '') return false;
    if (val === '—') return false;
    return true;
};


export const calculateProfileCompletionBackend = (employee = {}) => {
    let totalFields = 0;
    let completedFields = 0;
    const pendingFields = [];

    // 1. Basic Details
    const basicFields = [
        { value: employee.employeeId, name: 'Employee ID', section: 'Basic Details' },
        { value: employee.firstName, name: 'First Name', section: 'Basic Details' },
        { value: employee.lastName, name: 'Last Name', section: 'Basic Details' },
        { value: employee.email || employee.workEmail || employee.companyEmail, name: 'Email', section: 'Basic Details' },
        { value: employee.contactNumber, name: 'Contact Number', section: 'Basic Details' },
        { value: employee.dateOfBirth, name: 'Date of Birth', section: 'Basic Details' },
        { value: employee.maritalStatus, name: 'Marital Status', section: 'Basic Details' },
        { value: employee.fathersName, name: "Father's Name", section: 'Basic Details' },
        { value: employee.nationality || employee.country, name: 'Nationality', section: 'Basic Details' },
        { value: employee.gender, name: 'Gender', section: 'Basic Details' },
        { value: employee.status, name: 'Status', section: 'Basic Details' },
        { value: employee.profilePicture || employee.profilePic || employee.avatar, name: 'Profile Picture', section: 'Basic Details' },
    ];

    if (String(employee.maritalStatus || '').toLowerCase() === 'married') {
        basicFields.push({ value: employee.numberOfDependents, name: 'Number of Dependents', section: 'Basic Details' });
    }

    basicFields.forEach(({ value, name, section }) => {
        totalFields++;
        if (checkField(value)) {
            completedFields++;
        } else {
            pendingFields.push({ section, field: name });
        }
    });

    if (employee.status === 'Probation') {
        totalFields++;
        if (checkField(employee.probationPeriod)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Basic Details', field: 'Probation Period' });
        }
    }

    // 2. Passport Details
    const passport = employee.passportDetails;
    if (passport && checkField(passport.number)) {
        const passportFields = [
            { value: passport.number, name: 'Passport Number', section: 'Passport' },
            { value: passport.issueDate, name: 'Passport Issue Date', section: 'Passport' },
            { value: passport.expiryDate, name: 'Passport Expiry Date', section: 'Passport' },
            { value: passport.placeOfIssue, name: 'Place of Issue', section: 'Passport' }
        ];
        passportFields.forEach(({ value, name, section }) => {
            totalFields++;
            if (checkField(value)) {
                completedFields++;
            } else {
                pendingFields.push({ section, field: name });
            }
        });
    } else {
        ['Passport Number', 'Passport Issue Date', 'Passport Expiry Date', 'Place of Issue'].forEach(name => {
            totalFields++;
            pendingFields.push({ section: 'Passport', field: name });
        });
    }

    // 3. Visa Details — required except UAE nationals (visa is optional for 100%)
    if (!isEmployeeUaeNationality(employee)) {
        const visaTypes = ['visit', 'employment', 'spouse'];
        const visaDetails = employee.visaDetails || {};
        let activeVisaType = null;
        let activeVisa = null;

        for (const type of visaTypes) {
            if (visaDetails[type] && checkField(visaDetails[type].number)) {
                activeVisaType = type;
                activeVisa = visaDetails[type];
                break;
            }
        }

        if (activeVisa) {
            const visaFields = [
                { value: activeVisa.number, name: 'Visa Number', section: 'Visa' },
                { value: activeVisa.issueDate, name: 'Visa Issue Date', section: 'Visa' },
                { value: activeVisa.expiryDate, name: 'Visa Expiry Date', section: 'Visa' }
            ];
            if (['employment', 'spouse'].includes(activeVisaType)) {
                visaFields.push({ value: activeVisa.sponsor, name: 'Sponsor', section: 'Visa' });
            }
            visaFields.forEach(({ value, name, section }) => {
                totalFields++;
                if (checkField(value)) {
                    completedFields++;
                } else {
                    pendingFields.push({ section, field: name });
                }
            });
        } else {
            ['Visa Number', 'Visa Issue Date', 'Visa Expiry Date'].forEach(name => {
                totalFields++;
                pendingFields.push({ section: 'Visa', field: name });
            });
        }
    }

    // 4. Emirates ID — not required for visit-visa-only employees
    if (employeeRequiresEmiratesId(employee)) {
        const eid = employee.emiratesIdDetails;
        if (eid && checkField(eid.number)) {
            const eidFields = [
                { value: eid.number, name: 'Emirates ID Number', section: 'Emirates ID' },
                { value: eid.issueDate, name: 'Emirates ID Issue Date', section: 'Emirates ID' },
                { value: eid.expiryDate, name: 'Emirates ID Expiry Date', section: 'Emirates ID' }
            ];
            eidFields.forEach(({ value, name, section }) => {
                totalFields++;
                if (checkField(value)) {
                    completedFields++;
                } else {
                    pendingFields.push({ section, field: name });
                }
            });
        } else {
            ['Emirates ID Number', 'Emirates ID Issue Date', 'Emirates ID Expiry Date'].forEach(name => {
                totalFields++;
                pendingFields.push({ section: 'Emirates ID', field: name });
            });
        }
    }

    // 5. Labour Card Details — not required for visit-visa-only employees
    if (employeeRequiresLabourCard(employee)) {
        const lc = employee.labourCardDetails;
        const hasLabourDoc = Boolean(lc?.document?.url || lc?.document?.data);
        const hasLabourContract = Boolean(
            lc?.labourContractAttachment?.url || lc?.labourContractAttachment?.data,
        );
        if (lc && checkField(lc.number)) {
            const lcFields = [
                { value: lc.number, name: 'Labour Card Number', section: 'Labour Card' },
                { value: lc.issueDate, name: 'Labour Card Issue Date', section: 'Labour Card' },
                { value: lc.expiryDate, name: 'Labour Card Expiry Date', section: 'Labour Card' },
                { value: lc.noticePeriodMonths, name: 'Notice Period', section: 'Labour Card' },
                { value: hasLabourDoc ? 'Uploaded' : null, name: 'Labour Card Document', section: 'Labour Card' },
                {
                    value: hasLabourContract ? 'Uploaded' : null,
                    name: 'Labour Contract Attachment',
                    section: 'Labour Card',
                },
            ];
            lcFields.forEach(({ value, name, section }) => {
                totalFields++;
                if (checkField(value)) {
                    completedFields++;
                } else {
                    pendingFields.push({ section, field: name });
                }
            });
        } else {
            [
                'Labour Card Number',
                'Labour Card Issue Date',
                'Labour Card Expiry Date',
                'Notice Period',
                'Labour Card Document',
                'Labour Contract Attachment',
            ].forEach((name) => {
                totalFields++;
                pendingFields.push({ section: 'Labour Card', field: name });
            });
        }
    }

    // 6. Salary Details — required for all employees
    {
        const activeHistory = Array.isArray(employee.salaryHistory)
            ? employee.salaryHistory.find((entry) => !entry.toDate) || employee.salaryHistory[0]
            : null;
        const salaryMonth = activeHistory?.fromDate || activeHistory?.month || employee.salaryMonth;
        const basicSalary = activeHistory?.basic || employee.basic || 0;

        totalFields++;
        if (checkField(salaryMonth)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Salary Details', field: 'For Month' });
        }

        totalFields++;
        if (basicSalary > 0) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Salary Details', field: 'Basic Salary' });
        }

        let hasSalaryAttachment = false;
        if (employee.offerLetter?.url || employee.offerLetter?.data) {
            hasSalaryAttachment = true;
        }
        if (!hasSalaryAttachment && Array.isArray(employee.salaryHistory)) {
            hasSalaryAttachment = employee.salaryHistory.some(
                (entry) => entry?.offerLetter?.url || entry?.offerLetter?.data,
            );
        }

        totalFields++;
        if (checkField(hasSalaryAttachment ? 'Uploaded' : null)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Salary Details', field: 'Salary Letter' });
        }
    }

    // 7. Bank Details — not required for visit-visa-only employees
    if (employeeRequiresBankDetails(employee)) {
        const bankName = employee.bankName || employee.bank;
        const accountName = employee.accountName || employee.bankAccountName;
        const accountNumber = employee.accountNumber || employee.bankAccountNumber;
        const ibanNumber = employee.ibanNumber;

        totalFields++;
        if (checkField(bankName)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Bank Details', field: 'Bank Name' });
        }

        totalFields++;
        if (checkField(accountName)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Bank Details', field: 'Account Name' });
        }

        totalFields++;
        if (checkField(accountNumber) || checkField(ibanNumber)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Bank Details', field: 'Account Number / IBAN' });
        }
    }

    // 8. Emergency Contact
    const contacts = employee.emergencyContacts || [];
    const hasContactName = checkField(employee.emergencyContactName);
    const hasContactNumber = checkField(employee.emergencyContactNumber);

    if (contacts.length > 0) {
        const firstContact = contacts[0];
        totalFields++;
        if (checkField(firstContact.name)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Emergency Contact', field: 'Contact Name' });
        }

        totalFields++;
        if (checkField(firstContact.number)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Emergency Contact', field: 'Contact Number' });
        }
    } else if (hasContactName || hasContactNumber) {
        totalFields++;
        if (hasContactName) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Emergency Contact', field: 'Contact Name' });
        }

        totalFields++;
        if (hasContactNumber) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Emergency Contact', field: 'Contact Number' });
        }
    } else {
        totalFields += 2;
        pendingFields.push({ section: 'Emergency Contact', field: 'Contact Name' });
        pendingFields.push({ section: 'Emergency Contact', field: 'Contact Number' });
    }

    // 9. Work Details
    totalFields++;
    if (checkField(employee.company)) {
        completedFields++;
    } else {
        pendingFields.push({ section: 'Work Details', field: 'Company' });
    }

    totalFields++;
    if (checkField(employee.dateOfJoining)) {
        completedFields++;
    } else {
        pendingFields.push({ section: 'Work Details', field: 'Date of Joining' });
    }

    // Contract Joining Date is auto-derived from visa — not required for 100% profile progress.

    // Skip Primary Reportee check for General Manager or CEO (Management)
    const isManagementExempt = (employee.department && /management/i.test(employee.department)) &&
        ['ceo', 'c.e.o', 'c.e.o.', 'chief executive officer', 'director', 'managing director', 'general manager', 'gm', 'g.m', 'g.m.'].includes(employee.designation?.toLowerCase());

    if (!isManagementExempt) {
        totalFields++;
        if (checkField(employee.primaryReportee)) {
            completedFields++;
        } else {
            pendingFields.push({ section: 'Work Details', field: 'Primary Reportee' });
        }
    }

    totalFields++;
    if (checkField(employee?.signature?.url || employee?.signature?.data || employee?.signature?.name)) {
        completedFields++;
    } else {
        pendingFields.push({ section: 'Work Details', field: 'Digital Signature' });
    }

    const percentage = totalFields === 0 ? 0 : Math.round((completedFields / totalFields) * 100);
    return { percentage, pendingFields };
};

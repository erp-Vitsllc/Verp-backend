import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeContact from "../../models/EmployeeContact.js";
import EmployeePersonal from "../../models/EmployeePersonal.js";
import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";
import { getCompleteEmployee } from "../../services/employeeService.js";
import {
    validateEmployeeAddBody,
    assertActiveCompany,
} from "../../utils/employeeAddValidation.js";
import { recordActivityAsync } from "../../utils/activityLog.js";

// Calculate age from date of birth
const calculateAge = (dateOfBirth) => {
    if (!dateOfBirth) return null;
    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
};

// Add new employee
export const addEmployee = async (req, res) => {
    try {
        const {
            // Basic Info
            firstName,
            lastName,
            employeeId,
            role,
            department,
            designation,
            status,
            probationPeriod,
            reportingAuthority,

            // Login & Access
            email,
            companyEmail,
            enablePortalAccess,

            // Employment Info
            dateOfJoining,
            contractJoiningDate,
            contractExpiryDate,

            // Contact Info
            contactNumber,
            addressLine1,
            addressLine2,
            country,
            state,
            city,
            postalCode,

            // Personal Details
            gender,
            dateOfBirth,
            nationality,
            fathersName,

            // Document Expiry Details
            passportExp,
            eidExp,
            medExp,

            // Salary Structure
            monthlySalary,
            basic,
            basicPercentage,
            houseRentAllowance,
            houseRentPercentage,
            otherAllowance,
            otherPercentage,
            additionalAllowances,
            company,
        } = req.body;

        // Validate required fields
        // Check for empty strings, null, undefined, or whitespace-only strings
        const isEmpty = (val) => !val || (typeof val === 'string' && val.trim() === '');

        const validation = validateEmployeeAddBody(req.body);
        if (validation.errors.length > 0) {
            return res.status(400).json({
                message: validation.errors[0],
                errors: validation.errors,
            });
        }

        const companyError = await assertActiveCompany(company);
        if (companyError) {
            return res.status(400).json({ message: companyError });
        }

        // Sanitize Employee ID: uppercase, no spaces
        if (employeeId && typeof employeeId === 'string') {
            req.body.employeeId = employeeId.replace(/\s+/g, '').toUpperCase();
        }
        const cleanedEmployeeId = req.body.employeeId;
        const cleanedEmail = validation.normalized.email;

        if (enablePortalAccess && cleanedEmail) {
            const existingUser = await User.findOne({ email: cleanedEmail }).lean();
            if (existingUser) {
                return res.status(400).json({
                    message: "A user account with this email already exists. Disable portal access or use another email.",
                });
            }
        }

        // Check if employee ID already exists
        const existingEmployeeId = await EmployeeBasic.findOne({ employeeId: cleanedEmployeeId });
        if (existingEmployeeId) {
            return res.status(400).json({ message: "Employee ID already exists" });
        }

        // Check if email already exists (using sanitized email)
        if (cleanedEmail) {
            const existingEmail = await EmployeeBasic.findOne({ email: cleanedEmail });
            if (existingEmail) {
                return res.status(400).json({ message: "Email already exists" });
            }
        }

        // Calculate age from date of birth
        const age = calculateAge(dateOfBirth);

        // Normalize status to allowed values; default to Probation if invalid/absent
        const allowedStatuses = ['Probation', 'Permanent', 'Temporary', 'Notice'];
        let normalizedStatus = allowedStatuses.includes(status) ? status : 'Probation';

        // Rule 1: Tenure >= probation period (contract joining date is set later from first visa)
        const refJoiningDate = dateOfJoining;
        const refExpiryDate = contractExpiryDate;
        let criteriaMetForPermanent = false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const activeProbationPeriod = parseInt(probationPeriod) || 6;

        if (refJoiningDate) {
            const joiningDateObj = new Date(refJoiningDate);
            const probationEndDate = new Date(joiningDateObj);
            probationEndDate.setMonth(probationEndDate.getMonth() + activeProbationPeriod);
            probationEndDate.setHours(0, 0, 0, 0);
            if (probationEndDate <= today) criteriaMetForPermanent = true;
        }

        // Rule 2: duration after contract's expiry (user requirement)
        if (!criteriaMetForPermanent && refExpiryDate) {
            const expiryDateObj = new Date(refExpiryDate);
            const periodAfterExpiry = new Date(expiryDateObj);
            periodAfterExpiry.setMonth(periodAfterExpiry.getMonth() + activeProbationPeriod);
            periodAfterExpiry.setHours(0, 0, 0, 0);
            if (periodAfterExpiry <= today) criteriaMetForPermanent = true;
        }

        if (criteriaMetForPermanent) {
            normalizedStatus = 'Permanent';
            console.log(`[AddEmployee] Auto-setting status to Permanent for ${firstName} ${lastName}`);
        } else {
            // Keep the provided status if it's valid, otherwise default to Probation
            normalizedStatus = allowedStatuses.includes(status) ? status : 'Probation';
        }

        // Use designation as role if role is not provided
        const employeeRole = role || designation || '';

        // Calculate salary values before Promise.all
        const basicAmount = parseFloat(basic) || 0;
        const hraAmount = parseFloat(houseRentAllowance) || 0;
        const otherAmount = parseFloat(otherAllowance) || 0;
        const additionalTotal = Array.isArray(additionalAllowances)
            ? additionalAllowances.reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0)
            : 0;
        const calculatedTotal = basicAmount + hraAmount + otherAmount + additionalTotal;

        // Create initial salary history entry
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const joiningDate = dateOfJoining ? new Date(dateOfJoining) : new Date();
        const firstDayOfMonth = new Date(joiningDate.getFullYear(), joiningDate.getMonth(), 1);
        const month = `${monthNames[joiningDate.getMonth()]} ${joiningDate.getFullYear()}`;

        // Extract vehicle allowance from additionalAllowances
        const vehicleAllowance = additionalAllowances?.find(a => a.type?.toLowerCase().includes('vehicle'))?.amount
            ? parseFloat(additionalAllowances.find(a => a.type?.toLowerCase().includes('vehicle')).amount)
            : 0;

        // Extract fuel allowance from additionalAllowances
        const fuelAllowance = additionalAllowances?.find(a => a.type?.toLowerCase().includes('fuel'))?.amount
            ? parseFloat(additionalAllowances.find(a => a.type?.toLowerCase().includes('fuel')).amount)
            : 0;

        const initialSalaryHistory = [{
            month: month,
            fromDate: joiningDate, // Use exact joining date instead of 1st of month
            toDate: null, // Active entry
            basic: basicAmount,
            houseRentAllowance: hraAmount,
            otherAllowance: otherAmount,
            vehicleAllowance: vehicleAllowance,
            fuelAllowance: fuelAllowance,
            additionalAllowances: additionalAllowances || [],
            totalSalary: calculatedTotal,
            // Add offer letter to history if it exists (handling both structure types)
            offerLetter: req.body.offerLetter ? {
                url: req.body.offerLetter.url,
                data: req.body.offerLetter.data,
                name: req.body.offerLetter.name,
                mimeType: req.body.offerLetter.mimeType
            } : undefined,
            createdAt: joiningDate,
            isInitial: true
        }];

        // Create records in all collections
        const [basicRecord, contactRecord, personalRecord, passportRecord, salaryRecord] = await Promise.all([
            // 1. EmployeeBasic
            EmployeeBasic.create({
                firstName,
                lastName,
                employeeId: cleanedEmployeeId,
                role: employeeRole,
                department,
                designation,
                status: normalizedStatus,
                probationPeriod: status === 'Probation' ? (probationPeriod || 6) : null, // Default 6 months if not provided
                reportingAuthority: reportingAuthority || null,
                profileApprovalStatus: 'draft',
                profileStatus: 'inactive',
                email: cleanedEmail,
                companyEmail: companyEmail || '',
                enablePortalAccess: enablePortalAccess || false,
                dateOfJoining,
                company: company || null,
                contractJoiningDate: null,
                contractExpiryDate: contractExpiryDate || null,
            }),

            // 2. EmployeeContact
            contactNumber ? EmployeeContact.create({
                employeeId: cleanedEmployeeId,
                contactNumber,
                addressLine1: addressLine1 || '',
                addressLine2: addressLine2 || '',
                country: country || '',
                state: state || '',
                city: city || '',
                postalCode: postalCode || '',
            }) : null,

            // 3. EmployeePersonal
            gender ? EmployeePersonal.create({
                employeeId: cleanedEmployeeId,
                gender,
                dateOfBirth: dateOfBirth || null,
                age: age || null,
                nationality: nationality || '',
                fathersName: fathersName || '',
            }) : null,

            // 4. EmployeePassport (if expiry dates provided)
            (passportExp || eidExp || medExp) ? EmployeePassport.create({
                employeeId: cleanedEmployeeId,
                passportExp: passportExp || null,
                eidExp: eidExp || null,
                medExp: medExp || null,
            }) : null,

            // 5. EmployeeSalary
            EmployeeSalary.create({
                employeeId: cleanedEmployeeId,
                monthlySalary: calculatedTotal,
                totalSalary: calculatedTotal,
                basic: basicAmount,
                basicPercentage: basicPercentage || 60,
                houseRentAllowance: hraAmount,
                houseRentPercentage: houseRentPercentage || 20,
                otherAllowance: otherAmount,
                otherAllowancePercentage: otherPercentage || 20,
                additionalAllowances: additionalAllowances || [],
                salaryHistory: initialSalaryHistory, // Add initial history entry
            }),
        ]);

        // If department is "administrator"/"administration", automatically make them admin
        const isAdministrator = department && typeof department === 'string' && (department.toLowerCase() === 'administrator' || department.toLowerCase() === 'administration');
        // Get complete employee data for response
        const savedEmployee = await getCompleteEmployee(cleanedEmployeeId);

        const employeeDisplayName = [firstName, lastName].filter(Boolean).join(' ').trim() || cleanedEmployeeId;
        recordActivityAsync({
            req,
            module: 'HRM',
            action: 'create',
            entityType: 'Employee',
            entityId: cleanedEmployeeId,
            summary: `created employee ${employeeDisplayName}`,
            viewHref: `/emp/${encodeURIComponent(cleanedEmployeeId)}`,
            metadata: {
                employeeId: cleanedEmployeeId,
                department: department || '',
                designation: designation || '',
                isAdministrator: !!isAdministrator,
            },
        });

        return res.status(201).json({
            message: "Employee added successfully",
            employee: savedEmployee
        });
    } catch (error) {
        console.error('Error adding employee:', error);
        if (error.code === 11000) {
            // Duplicate key error
            const field = Object.keys(error.keyPattern)[0];
            return res.status(400).json({
                message: `${field} already exists`
            });
        }
        return res.status(500).json({
            message: error.message || 'Internal server error',
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};


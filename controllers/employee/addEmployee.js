import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeContact from "../../models/EmployeeContact.js";
import EmployeePersonal from "../../models/EmployeePersonal.js";
import EmployeePassport from "../../models/EmployeePassport.js";
import EmployeeSalary from "../../models/EmployeeSalary.js";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";
import { getCompleteEmployee } from "../../services/employeeService.js";

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
            profileApprovalStatus,
            profileStatus,

            // Login & Access
            email,
            enablePortalAccess,

            // Employment Info
            dateOfJoining,

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
            otherAllowancePercentage,
            additionalAllowances,
        } = req.body;

        // Validate required fields
        // Check for empty strings, null, undefined, or whitespace-only strings
        const isEmpty = (val) => !val || (typeof val === 'string' && val.trim() === '');
        // Only keep the minimal must-have fields to align with the simplified form
        // Validate required fields and types
        if (typeof firstName !== 'string' || !firstName.trim() ||
            typeof lastName !== 'string' || !lastName.trim() ||
            typeof employeeId !== 'string' || !employeeId.trim()) {
            return res.status(400).json({
                message: "First Name, Last Name, and Employee ID are required and must be valid strings"
            });
        }

        // Check if employee ID already exists
        const existingEmployeeId = await EmployeeBasic.findOne({ employeeId });
        if (existingEmployeeId) {
            return res.status(400).json({ message: "Employee ID already exists" });
        }

        // Check if email already exists
        const existingEmail = await EmployeeBasic.findOne({ email });
        if (existingEmail) {
            return res.status(400).json({ message: "Email already exists" });
        }

        // Calculate age from date of birth
        const age = calculateAge(dateOfBirth);

        // Normalize status to allowed values; default to Probation if invalid/absent
        const allowedStatuses = ['Probation', 'Permanent', 'Temporary', 'Notice'];
        let normalizedStatus = allowedStatuses.includes(status) ? status : 'Probation';

        // AUTOMATION: If Date of Joining is > 6 months ago, force Permanent
        if (dateOfJoining) {
            const joiningDateObj = new Date(dateOfJoining);
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

            if (joiningDateObj <= sixMonthsAgo) {
                normalizedStatus = 'Permanent';
                console.log(`[AddEmployee] Auto-setting status to Permanent for ${firstName} ${lastName} (Joined: ${dateOfJoining})`);
            }
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
        const month = monthNames[joiningDate.getMonth()];

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
            fromDate: firstDayOfMonth,
            toDate: null, // Active entry
            basic: basicAmount,
            houseRentAllowance: hraAmount,
            otherAllowance: otherAmount,
            vehicleAllowance: vehicleAllowance,
            fuelAllowance: fuelAllowance,
            additionalAllowances: additionalAllowances || [],
            totalSalary: calculatedTotal,
            createdAt: joiningDate,
            isInitial: true
        }];

        // Create records in all collections
        const [basicRecord, contactRecord, personalRecord, passportRecord, salaryRecord] = await Promise.all([
            // 1. EmployeeBasic
            EmployeeBasic.create({
                firstName,
                lastName,
                employeeId,
                role: employeeRole,
                department,
                designation,
                status: normalizedStatus,
                probationPeriod: status === 'Probation' ? (probationPeriod || 6) : null, // Default 6 months if not provided
                reportingAuthority: reportingAuthority || null,
                profileApprovalStatus: profileApprovalStatus || 'draft',
                profileStatus: profileStatus || 'inactive',
                email,
                enablePortalAccess: enablePortalAccess || false,
                dateOfJoining,
            }),

            // 2. EmployeeContact
            contactNumber ? EmployeeContact.create({
                employeeId,
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
                employeeId,
                gender,
                dateOfBirth: dateOfBirth || null,
                age: age || null,
                nationality: nationality || '',
                fathersName: fathersName || '',
            }) : null,

            // 4. EmployeePassport (if expiry dates provided)
            (passportExp || eidExp || medExp) ? EmployeePassport.create({
                employeeId,
                passportExp: passportExp || null,
                eidExp: eidExp || null,
                medExp: medExp || null,
            }) : null,

            // 5. EmployeeSalary
            EmployeeSalary.create({
                employeeId,
                monthlySalary: calculatedTotal,
                totalSalary: calculatedTotal,
                basic: basicAmount,
                basicPercentage: basicPercentage || 60,
                houseRentAllowance: hraAmount,
                houseRentPercentage: houseRentPercentage || 20,
                otherAllowance: otherAmount,
                otherAllowancePercentage: otherAllowancePercentage || 20,
                additionalAllowances: additionalAllowances || [],
                salaryHistory: initialSalaryHistory, // Add initial history entry
            }),
        ]);

        // If department is "administrator" or "administration", automatically create a user with full permissions
        if (department && typeof department === 'string' && (department.toLowerCase() === 'administrator' || department.toLowerCase() === 'administration') && email) {
            try {
                // Check if user already exists for this employee
                const existingUser = await User.findOne({
                    $or: [
                        { employeeId },
                        { email: email.toLowerCase().trim() }
                    ]
                });

                if (!existingUser) {
                    // Generate username from first name
                    let username = firstName ? firstName.toLowerCase().trim() : employeeId.toLowerCase();

                    // Remove spaces and special characters from username
                    username = username.replace(/[^a-z0-9]/g, '');

                    // If username is empty after cleaning, use employeeId
                    if (!username) {
                        username = employeeId.toLowerCase();
                    }

                    // Check if username already exists, if so append employeeId
                    let finalUsername = username;
                    let usernameExists = await User.findOne({ username: finalUsername });
                    let counter = 1;
                    while (usernameExists) {
                        finalUsername = `${username}${counter}`;
                        usernameExists = await User.findOne({ username: finalUsername });
                        counter++;
                    }

                    // Generate a default password (can be changed later)
                    // Generate a random string as fallback instead of hardcoded password
                    const randomString = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-10);
                    const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || `AutoGen${randomString}!`;

                    // Hash password
                    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

                    // Calculate password expiry date (180 days from now)
                    const passwordExpiryDate = new Date();
                    passwordExpiryDate.setDate(passwordExpiryDate.getDate() + 180);

                    // Create user for administrator
                    const newUser = new User({
                        username: finalUsername,
                        name: `${firstName} ${lastName}`.trim(),
                        email: email.toLowerCase().trim(),
                        password: hashedPassword,
                        employeeId: employeeId,
                        group: null, // Administrators don't need groups, they get full permissions
                        groupName: null,
                        status: 'Active',
                        enablePortalAccess: true,
                        isAdmin: true, // Mark as admin to get all permissions
                        passwordExpiryDate: passwordExpiryDate,
                    });

                    await newUser.save();
                    console.log(`User created automatically for administrator employee: ${employeeId} with username: ${finalUsername}`);
                }
            } catch (userError) {
                // Log error but don't fail the employee creation
                console.error('Error creating user for administrator:', userError);
                // Continue with employee creation even if user creation fails
            }
        }

        // Get complete employee data for response
        const savedEmployee = await getCompleteEmployee(employeeId);

        return res.status(201).json({
            message: "Employee added successfully",
            employee: savedEmployee,
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


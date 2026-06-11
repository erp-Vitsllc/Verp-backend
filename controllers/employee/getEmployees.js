import EmployeeBasic from "../../models/EmployeeBasic.js";
import EmployeeVisa from "../../models/EmployeeVisa.js";
import mongoose from "mongoose";
import { getSignedFileUrl, normalizeS3Key } from "../../utils/s3Upload.js";
import { escapeRegex } from "../../utils/regexHelper.js";
import { ensureProbationRequestForEmployee } from "../../utils/sendProbationWorkflowEmail.js";
import { buildEmployeeListStatusMatch } from "../../utils/applyEmployeeLeftUserStatus.js";
import {
    employeeProfileStatusNeedsRepair,
    normalizeEmployeeProfileStatusForApi,
} from "../../utils/employeeProfileStatusLock.js";

// Get all employees (lightweight list response with optional pagination)
export const getEmployees = async (req, res) => {
    // Check database connection first
    if (mongoose.connection.readyState !== 1) {
        console.error('Database not connected. Connection state:', mongoose.connection.readyState);
        return res.status(503).json({
            message: 'Database not connected. Please check server logs and ensure MongoDB is running.'
        });
    }

    // Set a timeout for the entire request
    const timeout = setTimeout(() => {
        if (!res.headersSent) {
            return res.status(504).json({
                message: 'Request timeout. Database query took too long.'
            });
        }
    }, 25000); // 25 seconds timeout (less than axios 30s timeout)

    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
        const skip = (page - 1) * limit;

        // Basic query/filter hooks (can be expanded later without breaking clients)
        const filters = { employeeId: { $ne: 'VEGA-HR-0000' } };
        const { department, designation, status, profileStatus, search } = req.query;

        if (department) filters.department = department;
        if (designation) filters.designation = designation;
        Object.assign(filters, buildEmployeeListStatusMatch(status));
        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            filters.$or = [
                { firstName: regex },
                { lastName: regex },
                { employeeId: regex },
                { email: regex },
            ];
        }
        if (profileStatus) {
            const ps = String(profileStatus).toLowerCase();
            const activatedClause =
                ps === "active"
                    ? {
                          $or: [
                              { profileStatus: "active" },
                              { profileApprovalStatus: "active" },
                              { "profileWorkflow.status": "active" },
                          ],
                      }
                    : ps === "inactive"
                      ? {
                            $and: [
                                { profileStatus: { $ne: "active" } },
                                { profileApprovalStatus: { $ne: "active" } },
                                { "profileWorkflow.status": { $ne: "active" } },
                            ],
                        }
                      : { profileStatus: profileStatus };
            if (filters.$or) {
                const searchOr = filters.$or;
                delete filters.$or;
                filters.$and = [...(filters.$and || []), { $or: searchOr }, activatedClause];
            } else if (activatedClause.$and) {
                filters.$and = [...(filters.$and || []), ...activatedClause.$and];
            } else {
                Object.assign(filters, activatedClause);
            }
        }

        // Add query timeout options
        const queryOptions = { maxTimeMS: 20000 }; // 20 seconds max query time

        // Optimize: Exclude large fields (documents, profilePicture base64) for list view
        // Use populate with options to handle invalid references gracefully
        const rosterCountFilter = {
            employeeId: { $ne: "VEGA-HR-0000" },
            status: { $ne: "Left User" },
        };

        const [employees, total, activeRosterTotal, leftUserTotal] = await Promise.all([
            EmployeeBasic.aggregate([
                { $match: filters },
                {
                    $addFields: {
                        sortPriority: {
                            $switch: {
                                branches: [
                                    { case: { $eq: ["$employeeId", "VEGA-HR-0000"] }, then: 0 },
                                    { case: { $and: [{ $eq: ["$status", "Notice"] }, { $eq: ["$profileStatus", "inactive"] }] }, then: 1 },
                                    { case: { $and: [{ $eq: ["$status", "Notice"] }, { $eq: ["$profileStatus", "active"] }] }, then: 2 },
                                    { case: { $and: [{ $eq: ["$status", "Probation"] }, { $eq: ["$profileStatus", "inactive"] }] }, then: 3 },
                                    { case: { $and: [{ $eq: ["$status", "Probation"] }, { $eq: ["$profileStatus", "active"] }] }, then: 4 },
                                    { case: { $and: [{ $eq: ["$status", "Permanent"] }, { $eq: ["$profileStatus", "inactive"] }] }, then: 5 },
                                    { case: { $and: [{ $eq: ["$status", "Permanent"] }, { $eq: ["$profileStatus", "active"] }] }, then: 6 }
                                ],
                                default: 7
                            }
                        }
                    }
                },
                { $sort: { sortPriority: 1, createdAt: -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                    $lookup: {
                        from: "employeepersonals",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "personalInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$personalInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "employeecontacts",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "contactInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$contactInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "employeelabourcards",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "labourCardInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$labourCardInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "employeepassports",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "passportInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$passportInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "employeeemiratesids",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "eidInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$eidInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "employeemedicalinsurances",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "medInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$medInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $lookup: {
                        from: "employeebasics",
                        localField: "reportingAuthority",
                        foreignField: "_id",
                        as: "reportingAuthority"
                    }
                },
                {
                    $unwind: {
                        path: "$reportingAuthority",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $project: {
                        password: 0,
                        trainingDetails: 0,
                        __v: 0,
                        "reportingAuthority.password": 0,
                        "reportingAuthority.documents": 0,
                        "reportingAuthority.trainingDetails": 0,
                        "reportingAuthority.__v": 0,
                        "reportingAuthority.salaryHistory": 0,
                        "reportingAuthority.bankOtherDetails": 0,
                    }
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "employeeId",
                        foreignField: "employeeId",
                        as: "userInfo"
                    }
                },
                {
                    $addFields: {
                        // Dynamically calculate portal access based on linked user and company email
                        hasActiveUser: {
                            $gt: [{
                                $size: {
                                    $filter: {
                                        input: "$userInfo",
                                        as: "u",
                                        cond: { $eq: ["$$u.status", "Active"] }
                                    }
                                }
                            }, 0]
                        }
                    }
                },
                {
                    $lookup: {
                        from: "companies",
                        localField: "company",
                        foreignField: "_id",
                        as: "companyInfo"
                    }
                },
                {
                    $unwind: {
                        path: "$companyInfo",
                        preserveNullAndEmptyArrays: true
                    }
                },
                {
                    $project: {
                        firstName: 1, lastName: 1, employeeId: 1, role: 1, department: 1, designation: 1,
                        status: 1, probationPeriod: 1, overtime: 1, profileApprovalStatus: 1, profileStatus: 1,
                        profileWorkflow: 1,
                        email: 1, companyEmail: 1,
                        // Update enablePortalAccess to be true if they have an active user OR manual flag, AND a company email
                        enablePortalAccess: {
                            $and: [
                                { $or: [{ $ifNull: ["$enablePortalAccess", false] }, "$hasActiveUser"] },
                                { $gt: [{ $strLenCP: { $ifNull: ["$companyEmail", ""] } }, 0] }
                            ]
                        },
                        dateOfJoining: 1, contractJoiningDate: 1, contractExpiryDate: 1,
                        company: 1,
                        companyName: "$companyInfo.name",
                        companyNickName: "$companyInfo.nickName",

                        // Fields from contactInfo
                        contactNumber: "$contactInfo.contactNumber",
                        addressLine1: "$contactInfo.addressLine1",
                        addressLine2: "$contactInfo.addressLine2",
                        country: "$contactInfo.country",
                        state: "$contactInfo.state",
                        city: "$contactInfo.city",
                        postalCode: "$contactInfo.postalCode",
                        currentAddressLine1: "$contactInfo.currentAddressLine1",
                        currentAddressLine2: "$contactInfo.currentAddressLine2",
                        currentCity: "$contactInfo.currentCity",
                        currentState: "$contactInfo.currentState",
                        currentCountry: "$contactInfo.currentCountry",
                        currentPostalCode: "$contactInfo.currentPostalCode",

                        // Fields from personalInfo
                        gender: "$personalInfo.gender",
                        dateOfBirth: "$personalInfo.dateOfBirth",
                        age: "$personalInfo.age",
                        maritalStatus: "$personalInfo.maritalStatus",
                        nationality: "$personalInfo.nationality",
                        fathersName: "$personalInfo.fathersName",

                        // Generic Documents (projection for chart statistics)
                        documents: {
                            $map: {
                                input: "$documents",
                                as: "doc",
                                in: {
                                    expiryDate: "$$doc.expiryDate",
                                    type: "$$doc.type"
                                }
                            }
                        },

                        // Expiry Fields (Prioritize dedicated models over legacy fields)
                        passportExp: { $ifNull: ["$passportInfo.passportExp", "$passportInfo.expiryDate"] },
                        eidExp: { $ifNull: ["$eidInfo.emiratesId.expiryDate", "$passportInfo.eidExp"] },
                        medExp: { $ifNull: ["$medInfo.medicalInsurance.expiryDate", "$passportInfo.medExp"] },

                        labourCardExp: "$labourCardInfo.labourCard.expiryDate",

                        passportDetails: {
                            expiryDate: "$passportInfo.expiryDate",
                            number: "$passportInfo.number"
                        },
                        visaDetails: 1,
                        monthlySalary: 1, basic: 1, basicPercentage: 1, houseRentAllowance: 1, houseRentPercentage: 1,
                        otherAllowance: 1, otherAllowancePercentage: 1, additionalAllowances: 1,
                        profilePicture: 1,
                        bankName: 1, accountName: 1, accountNumber: 1, ibanNumber: 1, swiftCode: 1,
                        emergencyContacts: 1, educationDetails: 1, experienceDetails: 1, salaryHistory: 1,
                        createdAt: 1, updatedAt: 1,
                        reportingAuthority: { _id: 1, firstName: 1, lastName: 1, employeeId: 1 },
                        primaryReportee: 1,
                        secondaryReportee: 1
                    }
                }
            ]).option(queryOptions), // Passing options to aggregate
            EmployeeBasic.countDocuments(filters, queryOptions),
            EmployeeBasic.countDocuments(rosterCountFilter, queryOptions),
            EmployeeBasic.countDocuments(
                { employeeId: { $ne: "VEGA-HR-0000" }, status: "Left User" },
                queryOptions,
            ),
        ]);

        // AUTOMATION: Create probation-change requests after probation period completes.
        // Status will no longer auto-switch to Permanent; workflow approval is required.
        const probationCandidates = employees.filter(
            (emp) => emp?.status === "Probation" && emp?.dateOfJoining
        );
        if (probationCandidates.length > 0) {
            const docs = await EmployeeBasic.find({
                _id: { $in: probationCandidates.map((e) => e._id) },
            });
            for (const doc of docs) {
                await ensureProbationRequestForEmployee(doc);
            }
        }

        // Populate visa details for each employee (only if we have employees)
        // Optimize: Exclude document fields from visa data for list view
        let employeesWithVisas = employees;
        if (employees.length > 0) {
            const employeeIds = employees.map(emp => emp.employeeId);
            const visas = await EmployeeVisa.find(
                { employeeId: { $in: employeeIds } },
                null,
                queryOptions
            )
                .select('employeeId visit.number visit.issueDate visit.expiryDate visit.sponsor employment.number employment.issueDate employment.expiryDate employment.sponsor spouse.number spouse.issueDate spouse.expiryDate spouse.sponsor')
                .lean();
            const visaMap = {};
            visas.forEach(visa => {
                // Only include visa metadata, exclude large document fields
                const visitVisa = visa.visit ? {
                    number: visa.visit.number,
                    issueDate: visa.visit.issueDate,
                    expiryDate: visa.visit.expiryDate,
                    sponsor: visa.visit.sponsor
                } : undefined;
                const employmentVisa = visa.employment ? {
                    number: visa.employment.number,
                    issueDate: visa.employment.issueDate,
                    expiryDate: visa.employment.expiryDate,
                    sponsor: visa.employment.sponsor
                } : undefined;
                const spouseVisa = visa.spouse ? {
                    number: visa.spouse.number,
                    issueDate: visa.spouse.issueDate,
                    expiryDate: visa.spouse.expiryDate,
                    sponsor: visa.spouse.sponsor
                } : undefined;

                visaMap[visa.employeeId] = {
                    ...(visitVisa && { visit: visitVisa }),
                    ...(employmentVisa && { employment: employmentVisa }),
                    ...(spouseVisa && { spouse: spouseVisa }),
                };
            });

            // Attach visa details to employees
            employeesWithVisas = employees.map(emp => ({
                ...emp,
                visaDetails: visaMap[emp.employeeId] || null,
            }));
        }

        // Check and sign profile pictures for all employees
        // This is necessary because profile pictures are now private and need signed URLs
        await Promise.all(employeesWithVisas.map(async (emp) => {
            if (emp.profilePicture && typeof emp.profilePicture === 'string' && !emp.profilePicture.startsWith('data:')) {
                try {
                    const key = normalizeS3Key(emp.profilePicture);
                    if (!key) return;
                    const signedUrl = await getSignedFileUrl(key);
                    if (signedUrl) {
                        emp.profilePicture = signedUrl;
                    }
                } catch (err) {
                    console.error(`Failed to sign profile picture for employee ${emp.employeeId}:`, err);
                }
            }
        }));

        const repairIds = employeesWithVisas
            .filter((emp) => employeeProfileStatusNeedsRepair(emp))
            .map((emp) => emp._id)
            .filter(Boolean);
        if (repairIds.length > 0) {
            await EmployeeBasic.updateMany({ _id: { $in: repairIds } }, { $set: { profileStatus: "active" } });
        }
        employeesWithVisas.forEach((emp) => normalizeEmployeeProfileStatusForApi(emp));

        // Calculate companies with employees using only valid (existing) company references.
        // This prevents deleted/orphaned company IDs from inflating dashboard company counts.
        const companiesWithEmployeesCountResult = await EmployeeBasic.aggregate([
            {
                $match: {
                    employeeId: { $ne: 'VEGA-HR-0000' },
                    company: { $ne: null }
                }
            },
            {
                $lookup: {
                    from: "companies",
                    localField: "company",
                    foreignField: "_id",
                    as: "companyInfo"
                }
            },
            {
                $match: {
                    "companyInfo.0": { $exists: true }
                }
            },
            {
                $group: {
                    _id: "$company"
                }
            },
            {
                $count: "total"
            }
        ]);
        const companiesWithEmployeesCount = companiesWithEmployeesCountResult[0]?.total || 0;

        clearTimeout(timeout);
        return res.status(200).json({
            message: "Employees fetched successfully",
            employees: employeesWithVisas,
            companiesWithEmployeesCount, // Added this field
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
            activeRosterTotal,
            leftUserTotal,
        });
    } catch (error) {
        clearTimeout(timeout);

        // Enhanced error logging
        console.error('Error in getEmployees:', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            code: error.code,
            errno: error.errno
        });

        // Check if it's a timeout error
        if (error.name === 'MongoServerError' && error.message?.includes('operation exceeded time limit')) {
            return res.status(504).json({
                message: 'Database query timeout. Please try again or contact support.'
            });
        }

        // Check if it's a database connection error
        if (error.name === 'MongoServerSelectionError' || error.message?.includes('connection')) {
            return res.status(503).json({
                message: 'Database connection error. Please check if MongoDB is running.'
            });
        }

        // Check if it's a Mongoose error
        if (error.name === 'CastError' || error.name === 'ValidationError') {
            return res.status(400).json({
                message: `Invalid data: ${error.message}`
            });
        }

        return res.status(500).json({
            message: error.message || 'Failed to fetch employees',
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};




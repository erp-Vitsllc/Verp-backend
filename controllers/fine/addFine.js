import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { sendFineApprovalEmail } from "../../utils/sendFineApprovalEmail.js";

/**
 * Generate unique random fine ID (4 digits)
 */
const generateFineId = async () => {
    try {
        const generateRandomId = () => {
            return Math.floor(1000 + Math.random() * 9000).toString();
        };

        let newFineId = generateRandomId();
        let exists = await Fine.findOne({ fineId: newFineId }).lean();
        let attempts = 0;
        const maxAttempts = 100;

        while (exists && attempts < maxAttempts) {
            newFineId = generateRandomId();
            exists = await Fine.findOne({ fineId: newFineId }).lean();
            attempts++;
        }

        if (attempts >= maxAttempts || exists) {
            return Date.now().toString().slice(-4);
        }

        return newFineId;
    } catch (error) {
        console.error('Error generating fine ID:', error);
        return Date.now().toString().slice(-4);
    }
};

export const addFine = async (req, res) => {
    try {
        const { isBulk, employees, ...commonData } = req.body;

        // --- BULK CREATION LOGIC ---
        // Support various array names: employees (new std), assignedEmployees (Project Damage), selectedEmployees (Other Damage)
        const bulkList = employees || commonData.assignedEmployees || commonData.selectedEmployees;

        if (isBulk && Array.isArray(bulkList) && bulkList.length > 0) {
            console.log(`[AddFine] Processing Bulk Request. Count: ${bulkList.length}`);
            const fineId = await generateFineId();
            const createdFines = [];
            const errors = [];

            // Process attachment once if possible
            let attachmentData = null;
            if (commonData.attachment && commonData.attachment.data) {
                try {
                    const attachmentDataStr = typeof commonData.attachment.data === 'string' ? commonData.attachment.data : String(commonData.attachment.data);
                    const uploadResult = await uploadDocumentToS3(
                        attachmentDataStr,
                        `fines/bulk_${fineId}`,
                        commonData.attachment.name || 'fine-attachment.pdf',
                        'raw'
                    );
                    attachmentData = {
                        url: uploadResult.url,
                        publicId: uploadResult.publicId,
                        name: commonData.attachment.name || '',
                        mimeType: commonData.attachment.mimeType || 'application/pdf'
                    };
                } catch (e) {
                    console.error('[AddFine] Bulk upload error:', e);
                    attachmentData = {
                        data: typeof commonData.attachment.data === 'string' ? commonData.attachment.data : String(commonData.attachment.data),
                        name: commonData.attachment.name || '',
                        mimeType: commonData.attachment.mimeType || 'application/pdf'
                    };
                }
            }

            // Pre-calculate shares if not provided per-item
            const count = bulkList.length;
            const totalFine = parseFloat(commonData.fineAmount) || 0;
            const totalEmp = parseFloat(commonData.employeeAmount) || 0;
            const totalComp = parseFloat(commonData.companyAmount) || 0;

            const defFineShare = count > 0 ? (totalFine / count) : 0;
            const defEmpShare = count > 0 ? (totalEmp / count) : 0;
            const defCompShare = count > 0 ? (totalComp / count) : 0;

            // Construct full assignedEmployees list with calculated/provided shares
            const fullAssignedList = await Promise.all(bulkList.map(async (empData) => {
                let eName = empData.employeeName || '';
                if (!eName && empData.employeeId) {
                    const emp = await EmployeeBasic.findOne({ employeeId: empData.employeeId }).select('firstName lastName').lean();
                    if (emp) eName = `${emp.firstName} ${emp.lastName}`;
                }

                const isPassed = (empData.fineAmount !== undefined);
                return {
                    employeeId: empData.employeeId,
                    employeeName: eName || 'Unknown',
                    // Store item-specific details in the array objects if schema allows 
                    // (Schema currently has employeeId, employeeName, daysWorked. 
                    // To store individual amounts, schema update would be needed, 
                    // BUT for now we rely on the fact that for bulk fines, shares are usually equal 
                    // or calculated on the fly. Ideally we should add 'amount' to assignedEmployees schema, 
                    // but user said "store inside employee array assigned employees".
                    // The current schema strictly validates assignedEmployees. 
                    // We will fit what we can.)
                    daysWorked: empData.daysWorked || 0
                };
            }));

            // Use the first employee as the "Primary" for indexing, or a placeholder if needed.
            // Since employeeId is required and usually indexed, picking the first one is safe for now 
            // as getFines searches assignedEmployees too.
            const primaryEmp = fullAssignedList[0];

            const finePayload = {
                fineId,
                // employeeId: primaryEmp.employeeId, // REMOVED
                // employeeName: primaryEmp.employeeName, // REMOVED
                fineType: commonData.fineType || 'Other',
                fineStatus: commonData.fineStatus || 'Pending',
                fineAmount: totalFine, // Total for the whole group
                description: commonData.description || '',
                awardedDate: commonData.awardedDate ? new Date(commonData.awardedDate) : new Date(),
                remarks: commonData.remarks || '',
                attachment: attachmentData,
                category: commonData.category || 'Other',
                subCategory: commonData.subCategory || '',
                vehicleId: commonData.vehicleId || null,
                projectId: commonData.projectId || null,
                projectName: commonData.projectName || '',
                engineerName: commonData.engineerName || '',
                assignedEmployees: fullAssignedList,
                responsibleFor: commonData.responsibleFor || null,
                employeeAmount: totalEmp,
                companyAmount: totalComp,
                payableDuration: parseInt(commonData.payableDuration) || null,
                monthStart: commonData.monthStart || '',
                createdBy: req.user._id // Add Creator
            };

            console.log(`[AddFine] Saving SINGLE Bulk Fine. ID: ${fineId}, Group Size: ${fullAssignedList.length}, Total Amount: ${totalFine}`);

            try {
                const newFine = new Fine(finePayload);
                await newFine.save();
                createdFines.push(newFine);

                // Send Email Notification
                sendFineApprovalEmail(newFine, fullAssignedList).catch(err => console.error(err));
            } catch (err) {
                console.error(`[AddFine] Error saving bulk fine:`, err);
                errors.push({ error: err.message });
            }

            return res.status(201).json({
                message: `Bulk fine created.`,
                fines: createdFines,
                errors
            });
        }

        // --- SINGLE CREATION LOGIC (Legacy / Single Modal) ---
        const {
            employeeId,
            fineType,
            fineStatus,
            fineAmount,
            description,
            awardedDate,
            remarks,
            attachment,
            category,
            subCategory,
            vehicleId,
            projectId,
            projectName,
            engineerName,
            assignedEmployees,
            responsibleFor,
            employeeAmount,
            companyAmount,
            payableDuration,
            monthStart
        } = req.body;

        if (!employeeId) {
            return res.status(400).json({ message: "Employee ID is required" });
        }

        if (!fineType) {
            return res.status(400).json({ message: "Fine Type is required" });
        }

        // Strict > 0 check only if NOT 0-liability logic (e.g. company paid)
        // Check implies: if Total Fine > 0, it's valid.
        // fineAmount usually comes as Total.
        if ((!fineAmount || isNaN(fineAmount) || fineAmount < 0) && (!companyAmount || companyAmount <= 0)) {
            // Allow fineAmount=0 IF companyAmount > 0
            /* 
               Refined Logic:
               User passes fineAmount (Employee Share usually in frontend logic causing error).
               We should verify: Is there ANY money involved?
            */
            const totalMoney = (parseFloat(fineAmount) || 0) + (parseFloat(companyAmount) || 0);
            if (totalMoney <= 0) {
                return res.status(400).json({ message: "Fine Amount is required and must be greater than zero" });
            }
        }

        let employeeName = '';
        if (employeeId === 'PENDING') {
            employeeName = 'Project Damage (Pending)';
        } else {
            const employee = await EmployeeBasic.findOne({ employeeId })
                .select('firstName lastName employeeId')
                .lean();

            if (!employee) {
                return res.status(404).json({ message: "Employee not found" });
            }
            employeeName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
        }

        const fineId = await generateFineId();

        let attachmentData = null;
        if (attachment && attachment.data) {
            try {
                // Upload to IDrive (S3)
                // Note: s3Upload utility handles base64 prefixes automatically, but we can pass raw string too
                const attachmentDataStr = typeof attachment.data === 'string' ? attachment.data : String(attachment.data);

                const uploadResult = await uploadDocumentToS3(
                    attachmentDataStr,
                    `fines/${employeeId}`,
                    attachment.name || 'fine-attachment.pdf',
                    'raw'
                );

                attachmentData = {
                    url: uploadResult.url,
                    publicId: uploadResult.publicId,
                    name: attachment.name || '',
                    mimeType: attachment.mimeType || 'application/pdf'
                };
            } catch (uploadError) {
                console.error('Error uploading attachment to IDrive:', uploadError);
                // Fallback: store base64 data directly if upload fails
                attachmentData = {
                    data: typeof attachment.data === 'string' ? attachment.data : String(attachment.data),
                    name: attachment.name || '',
                    mimeType: attachment.mimeType || 'application/pdf'
                };
            }
        }

        const fineData = {
            fineId,
            // employeeId, // REMOVED
            // employeeName, // REMOVED
            fineType: subCategory || fineType || 'Other',
            fineStatus: fineStatus || 'Pending',
            fineAmount: parseFloat(fineAmount) || 0, // Allow 0
            description: description || '',
            awardedDate: awardedDate ? new Date(awardedDate) : new Date(),
            remarks: remarks || '',
            attachment: attachmentData,
            category: category || 'Other',
            subCategory: subCategory || '',
            vehicleId: vehicleId || null,
            projectId: projectId || null,
            projectName: projectName || '',
            engineerName: engineerName || '',
            // Ensure assignedEmployees exists, even for single fine
            assignedEmployees: (assignedEmployees && assignedEmployees.length > 0) ? assignedEmployees : [{
                employeeId,
                employeeName,
                daysWorked: 0
            }],
            responsibleFor: responsibleFor || null,
            employeeAmount: parseFloat(employeeAmount) || 0,
            companyAmount: parseFloat(companyAmount) || 0,
            companyAmount: parseFloat(companyAmount) || 0,
            payableDuration: parseInt(payableDuration) || null,
            monthStart: monthStart || '',
            createdBy: req.user._id // Add Creator
        };

        // SNAPSHOT LOGIC: Find Reportee's USER Object for "submittedTo"
        // Use the first assigned employee to determine the manager
        const targetEmpId = (fineData.assignedEmployees && fineData.assignedEmployees.length > 0)
            ? fineData.assignedEmployees[0].employeeId
            : employeeId;

        if (targetEmpId && targetEmpId !== 'PENDING') {
            const employeeForSnapshot = await EmployeeBasic.findOne({ employeeId: targetEmpId })
                .select('primaryReportee')
                .lean();

            if (employeeForSnapshot && employeeForSnapshot.primaryReportee) {
                // Determine Manager
                const managerBasic = await EmployeeBasic.findById(employeeForSnapshot.primaryReportee)
                    .select('employeeId companyEmail email workEmail firstName lastName')
                    .lean();

                if (managerBasic) {
                    // Find Manager User Account
                    let reporteeUser = null;

                    if (managerBasic.employeeId) {
                        // Fix: Prefer the logged-in user if they are the manager
                        if (req.user && req.user.employeeId === managerBasic.employeeId) {
                            reporteeUser = req.user;
                            console.log(`[AddFine] Manager is the requesting user. Using req.user (Preferred): ${req.user._id}`);
                        } else {
                            reporteeUser = await User.findOne({ employeeId: managerBasic.employeeId });
                        }
                    }

                    if (!reporteeUser) {
                        const managerEmail = managerBasic.companyEmail || managerBasic.workEmail || managerBasic.email;
                        if (managerEmail) {
                            console.log(`[AddFine] Manager User not found by ID. Trying email: ${managerEmail}`);
                            reporteeUser = await User.findOne({
                                $or: [
                                    { email: managerEmail },
                                    { username: managerEmail }
                                ]
                            });
                        }
                    }

                    if (reporteeUser) {
                        fineData.submittedTo = reporteeUser._id;
                        // WORKFLOW: Initial Pending Step (Pushed to Dashboard)
                        fineData.workflow = [{
                            role: 'Reportee', // or Manager
                            assignedTo: reporteeUser._id,
                            status: 'Pending',
                            assignedAt: new Date()
                        }];
                        console.log(`[AddFine] Dashboard Request Pushed for Manager: ${reporteeUser.username}`);

                        // SNAPSHOT: Log Dashboard State
                        const currentPendingFines = await Fine.countDocuments({
                            workflow: { $elemMatch: { assignedTo: reporteeUser._id, status: 'Pending' } },
                            fineStatus: { $nin: ['Approved', 'Rejected', 'Withdrawn', 'Completed'] }
                        });

                        console.log(`
===================================================
[DASHBOARD PREVIEW - FINE]
---------------------------------------------------
Target Manager    : ${reporteeUser.username}
Target User ID    : ${reporteeUser._id}
Target Emp ID     : ${managerBasic.employeeId}
Target Email      : ${reporteeUser.email || reporteeUser.companyEmail}
---------------------------------------------------
Pending Fines (Pre-Save)   : ${currentPendingFines}
New Item Pushed            : +1
---------------------------------------------------
TOTAL PENDING ON DASHBOARD : ${currentPendingFines + 1}
===================================================`);
                    } else {
                        console.warn(`[AddFine] Manager (ID: ${managerBasic.employeeId}) has no User account linked. Dashboard request cannot be created.`);
                    }
                } else {
                    console.warn(`[AddFine] Primary Reportee (ID: ${employeeForSnapshot.primaryReportee}) not found in EmployeeBasic.`);
                }
            }
        }

        const fine = new Fine(fineData);
        const savedFine = await fine.save();

        // Send Email Notification
        // Use fineData.assignedEmployees as it was standardized in the payload construction above
        sendFineApprovalEmail(savedFine, fineData.assignedEmployees).catch(err => console.error(err));

        return res.status(201).json({
            message: "Fine created successfully",
            fine: savedFine
        });
    } catch (error) {
        console.error('Error creating fine:', error);
        return res.status(500).json({
            message: error.message || "Failed to create fine",
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

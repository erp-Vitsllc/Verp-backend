import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import User from "../../models/User.js";
import { uploadDocumentToS3 } from "../../utils/s3Upload.js";
import { sendFineApprovalEmail } from "../../utils/sendFineApprovalEmail.js";

/**
 * Generate unique random fine ID (4 digits)
 */
export const generateFineIdInternal = async () => {
    try {
        // Find all fines with the VEGA-FNE- or VEGA-FINE- format
        const fines = await Fine.find({
            fineId: /VEGA-(FINE|FNE)-(\d+)/i
        }).select('fineId').lean();

        let maxNum = 0;

        if (fines.length > 0) {
            fines.forEach(f => {
                const match = f.fineId.match(/VEGA-(FINE|FNE)-(\d+)/i);
                if (match && match[2]) {
                    const num = parseInt(match[2], 10);
                    if (num > maxNum) maxNum = num;
                }
            });
        }

        const nextNum = maxNum + 1;
        return `VEGA-FINE-${nextNum.toString().padStart(4, '0')}`;
    } catch (error) {
        console.error('Error generating fine ID:', error);
        return `fine${Date.now().toString().slice(-4)}`;
    }
};

export const addFine = async (req, res) => {
    try {
        // --- UNIFIED INTERCEPT: Separate Company Share into Individual Record ---
        // Whether Single or Bulk, if there is a "Company Amount", we transform it into 
        // a separate "Employee" record for the company (VEGA-HR-0000).

        let workingEmployees = [];

        // 1. Resolve initial list
        if (req.body.isBulk && Array.isArray(req.body.employees) && req.body.employees.length > 0) {
            workingEmployees = [...req.body.employees];
        } else if (req.body.employees && req.body.employees.length > 0) {
            // Sometimes isBulk is false but employees array is sent (rare, but handle safely)
            workingEmployees = [...req.body.employees];
        } else if (req.body.employeeId) {
            // Single Request conversion
            workingEmployees = [{
                employeeId: req.body.employeeId,
                // If single request, 'fineAmount' usually is Total. 'employeeAmount' is specifically their share.
                // We prefer 'employeeAmount' if available, else 'fineAmount' IF 'companyAmount' is handled separately.
                // However, logic below calculates distinct amounts if creating new structure.
                fineAmount: parseFloat(req.body.employeeAmount) || 0,
                employeeAmount: parseFloat(req.body.employeeAmount) || 0,
                companyAmount: 0 // Explicitly 0, as company share moves to separate record
            }];

            // Edge case: If ResponsibleFor = 'Employee' and no explicit employeeAmount, use total fineAmount
            if (!req.body.employeeAmount && req.body.responsibleFor === 'Employee') {
                const total = parseFloat(req.body.fineAmount) || 0;
                workingEmployees[0].fineAmount = total;
                workingEmployees[0].employeeAmount = total;
            }
        }

        const rawCompAmt = parseFloat(req.body.companyAmount) || 0;
        const totalFineAmt = parseFloat(req.body.fineAmount) || 0;
        const inputResponsibleFor = req.body.responsibleFor;

        // Determine effective Company Liability
        let compLiability = 0;
        if (rawCompAmt > 0) {
            compLiability = rawCompAmt;
        } else if (inputResponsibleFor === 'Company' || inputResponsibleFor === 'Both') {
            // If 'Both', we expect rawCompAmt to be > 0. If not, ambiguous.
            // If 'Company', they take the full hit.
            if (inputResponsibleFor === 'Company') compLiability = totalFineAmt;
        }

        if (compLiability > 0) {
            console.log(`[AddFine] Transforming Company Share (${compLiability}) into VEGA-HR-0000 record.`);

            // Create Company "Employee" Record
            // Insert at HEAD to ensure it gets Suffix 'A'
            workingEmployees.unshift({
                employeeId: 'VEGA-HR-0000',
                employeeName: 'Vega Digital IT Solutions',
                fineAmount: compLiability,     // Total Amount for this record
                employeeAmount: compLiability, // It is their liability
                companyAmount: 0,              // Zero out field so it doesn't look like a shared fine
                responsibleFor: 'Employee',    // Treat as individual liability
                daysWorked: 0
            });

            // Update Request Body to reflect transformation
            req.body.isBulk = true;
            req.body.employees = workingEmployees;

            // IMPORTANT: Clear the global companyAmount so the Bulk Logic doesn't 
            // try to distribute it across the other employees again.
            req.body.companyAmount = 0;
        } else {
            // If no company liability but we resolved a Single request into workingEmployees array
            // we should consistency-check if we need to set isBulk=true (e.g. if we want to use the loop logic)
            // But preserving existing path if not company split is also fine.
            // However, to be safe, if we populated 'workingEmployees' from a single ID, we can just use the bulk logic 
            // if we update standard fields.

            if (req.body.employeeId && !req.body.isBulk) {
                // For standard single requests without company split, we can let them fall through 
                // to the "SINGLE CREATION LOGIC" block (lines 271+) UNLESS we force bulk here.
                // The original code passed 'isSingleRequest && isCompanyInvolved'. 
                // If NOT company involved, original code did nothing.
                // So we do nothing here, let it fall through.
            } else if (req.body.isBulk) {
                // If it was already bulk, ensure we pass the spread workingEmployees in case we modified anything (unlikely here)
            }
        }

        const { isBulk, employees, ...commonData } = req.body;

        // --- BULK CREATION LOGIC ---
        // Support various array names: employees (new std), assignedEmployees (Project Damage), selectedEmployees (Other Damage)
        const bulkList = employees || commonData.assignedEmployees || commonData.selectedEmployees;

        if (isBulk && Array.isArray(bulkList) && bulkList.length > 0) {
            console.log(`[AddFine] Processing Bulk Request. Count: ${bulkList.length}`);

            let employeesWithCompany = [];
            const bulkIds = bulkList.map(e => e.employeeId).filter(id => id && id !== 'VEGA-HR-0000');
            if (bulkIds.length > 0) {
                employeesWithCompany = await EmployeeBasic.find({
                    employeeId: { $in: bulkIds }
                }).select('firstName lastName employeeId company').populate('company', 'name').lean();

                const invalidEmployees = employeesWithCompany.filter(e => !e.company);

                if (invalidEmployees.length > 0) {
                    const noCompany = invalidEmployees.map(e => `${e.firstName} ${e.lastName || ''}`.trim());
                    return res.status(400).json({
                        message: `Users with no company: ${noCompany.join(', ')}. Please fix this in their profile before creating the fine.`
                    });
                }

                // NEW: Ensure all belong to the SAME COMPANY
                const companyIds = [...new Set(employeesWithCompany.map(e => String(e.company?._id || e.company)))];
                if (companyIds.length > 1) {
                    return res.status(400).json({
                        message: "All employees in a group fine must belong to the same company."
                    });
                }
            }

            const baseFineId = await generateFineIdInternal(); // e.g. VEGA-FNE-0001
            const createdFines = [];
            const errors = [];

            // Process attachment once if possible
            let attachmentData = null;
            if (commonData.attachment && commonData.attachment.data) {
                try {
                    const attachmentDataStr = typeof commonData.attachment.data === 'string' ? commonData.attachment.data : String(commonData.attachment.data);
                    const uploadResult = await uploadDocumentToS3(
                        attachmentDataStr,
                        `fines/bulk_${baseFineId}`,
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

            // Pre-calculate shares
            const count = bulkList.length;
            const totalFine = parseFloat(commonData.fineAmount) || 0;
            const totalEmp = parseFloat(commonData.employeeAmount) || 0;
            const totalComp = parseFloat(commonData.companyAmount) || 0;

            // If we are splitting into individual records, we need to split the AMOUNTS too.
            // Assuming the input amounts are TOTALs for the whole group.
            const fineShare = count > 0 ? (totalFine / count) : 0;
            const empShare = count > 0 ? (totalEmp / count) : 0;
            const compShare = count > 0 ? (totalComp / count) : 0;

            // Suffix generation helper
            const getSuffix = (index) => {
                const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
                // Simple A-Z support. For >26, maybe AA, AB? For now assume < 26.
                if (index < 26) return `-${letters[index]}`;
                return `-${index}`; // Fallback for huge lists
            };

            // Process each employee as an INDIVIDUAL FINE record
            for (let i = 0; i < count; i++) {
                const empData = bulkList[i];
                let eName = empData.employeeName || '';
                if (!eName && empData.employeeId) {
                    const emp = await EmployeeBasic.findOne({ employeeId: empData.employeeId }).select('firstName lastName').lean();
                    if (emp) eName = `${emp.firstName} ${emp.lastName}`;
                }

                // Generate Unique ID for this specific record
                // If count > 1, append suffix. If count == 1, use base ID.
                const uniqueFineId = (count > 1) ? `${baseFineId}${getSuffix(i)}` : baseFineId;

                // Use individual amounts if provided by frontend, otherwise fallback to equal distribution
                const individualFineAmount = (empData.fineAmount !== undefined && empData.fineAmount !== null) ? parseFloat(empData.fineAmount) : fineShare;
                const individualEmpAmount = (empData.employeeAmount !== undefined && empData.employeeAmount !== null) ? parseFloat(empData.employeeAmount) : empShare;
                const individualCompAmount = (empData.companyAmount !== undefined && empData.companyAmount !== null) ? parseFloat(empData.companyAmount) : compShare;

                const finePayload = {
                    fineId: uniqueFineId,
                    // Store as single assigned employee
                    assignedEmployees: [{
                        employeeId: empData.employeeId,
                        employeeName: eName || 'Unknown',
                        daysWorked: empData.daysWorked || 0,
                        individualAmount: individualEmpAmount // Store individual amount here too
                    }],
                    fineType: commonData.fineType || 'Other',
                    fineStatus: (commonData.fineStatus === 'Pending' || !commonData.fineStatus) ? 'Pending HR' : commonData.fineStatus,

                    // Use Individual Amounts
                    fineAmount: individualFineAmount,
                    employeeAmount: individualEmpAmount,
                    companyAmount: individualCompAmount,

                    description: commonData.description || '',
                    awardedDate: commonData.awardedDate ? new Date(commonData.awardedDate) : new Date(),
                    remarks: commonData.remarks || '',
                    attachment: attachmentData,
                    category: commonData.category || 'Other',
                    subCategory: commonData.subCategory || '',
                    company: employeesWithCompany.find(e => e.employeeId === empData.employeeId)?.company?._id || (employeesWithCompany.length > 0 ? employeesWithCompany[0].company?._id : null),
                    companyName: employeesWithCompany.find(e => e.employeeId === empData.employeeId)?.company?.name || (employeesWithCompany.length > 0 ? employeesWithCompany[0].company?.name : ''),
                    vehicleId: commonData.vehicleId || null,
                    assetId: commonData.assetId || null,
                    assetName: commonData.assetName || '',
                    projectId: commonData.projectId || null,
                    projectName: commonData.projectName || '',
                    engineerName: commonData.engineerName || '',
                    responsibleFor: commonData.responsibleFor || null,
                    payableDuration: parseInt(empData.payableDuration || commonData.payableDuration) || null,
                    monthStart: commonData.monthStart || '',
                    createdBy: req.user._id
                };

                // BULK: Route directly to HR (no reportee step)
                if (finePayload.fineStatus !== 'Draft') {
                    try {
                        const { getDepartmentHOD } = await import('../../utils/getDepartmentHOD.js');
                        const hrHOD = await getDepartmentHOD('hr', empData.employeeId);
                        if (hrHOD) {
                            const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                            if (hrUser) {
                                finePayload.submittedTo = hrUser._id;
                                finePayload.fineStatus = 'Pending HR';
                                finePayload.workflow = [{
                                    role: 'HR',
                                    assignedTo: hrUser._id,
                                    status: 'Pending',
                                    assignedAt: new Date()
                                }];
                            }
                        }
                    } catch (snapErr) {
                        console.error('[AddFine] Error resolving HR for:', empData.employeeId, snapErr);
                    }
                }

                try {
                    const fineModel = new Fine(finePayload);
                    const savedFineRecord = await fineModel.save();
                    createdFines.push(savedFineRecord);

                    // Dashboard/Email sync moved OUTSIDE the loop for bulk fines
                } catch (err) {
                    console.error(`[AddFine] Error saving individual fine ${uniqueFineId}:`, err);
                    errors.push({ employeeId: empData.employeeId, error: err.message });
                }
            }

            console.log(`[AddFine] Bulk Processing Complete. Created: ${createdFines.length}, Errors: ${errors.length}`);

            // === GROUP DASHBOARD ACTION & EMAIL ===
            if (createdFines.length > 0 && String(createdFines[0].fineStatus) !== 'Draft') {
                const firstFine = createdFines[0];
                const reporteeStep = firstFine.workflow?.find(w => w.status === 'Pending');

                if (reporteeStep) {
                    try {
                        const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
                        await syncDashboardAction({
                            requestId: firstFine._id, // Dashboard will link to the FIRST fine in the group
                            requestType: 'Group Fine Request',
                            assignedTo: reporteeStep.assignedTo,
                            status: 'Pending',
                            subjectName: `Group Fine - ${createdFines.length} Employees`,
                            extra1: firstFine.fineType,
                            extra2: `Total: AED ${totalFine}`
                        });
                    } catch (err) {
                        console.error('[AddFine] Error matching group dashboard action:', err);
                    }
                }

                // Prepare a unified assignedEmployees array for the email
                const allAssigned = createdFines.map(f => f.assignedEmployees[0]);
                sendFineApprovalEmail(firstFine, allAssigned).catch(err => console.error(err));
            }

            return res.status(201).json({
                message: `Bulk fine processing complete. Created ${createdFines.length} records.`,
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
            assetId,
            assetName,
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
                .select('firstName lastName employeeId company primaryReportee')
                .populate('company', 'name')
                .lean();

            if (!employee) {
                return res.status(404).json({ message: "Employee not found" });
            }
            if (!employee.company) {
                return res.status(400).json({ message: "Employee is not linked to any company. Cannot proceed." });
            }
            // Removed: primaryReportee check — fine goes directly to HR now
            employeeName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
        }

        const fineId = await generateFineIdInternal();

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
            fineStatus: (fineStatus === 'Pending' || !fineStatus) ? 'Pending HR' : fineStatus,
            fineAmount: parseFloat(fineAmount) || 0, // Allow 0
            description: description || '',
            awardedDate: awardedDate ? new Date(awardedDate) : new Date(),
            remarks: remarks || '',
            attachment: attachmentData,
            category: category || 'Other',
            subCategory: subCategory || '',
            company: employee?.company?._id || null,
            companyName: employee?.company?.name || '',
            vehicleId: vehicleId || null,
            assetId: assetId || null,
            assetName: assetName || '',
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
            fineAmount: parseFloat(fineAmount) || (parseFloat(employeeAmount) || 0) + (parseFloat(companyAmount) || 0),
            employeeAmount: parseFloat(employeeAmount) || 0,
            companyAmount: parseFloat(companyAmount) || 0,
            payableDuration: parseInt(payableDuration) || null,
            monthStart: monthStart || '',
            createdBy: req.user._id // Add Creator
        };

        // SINGLE: Route directly to HR (no reportee step)
        if (fineData.fineStatus !== 'Draft') {
            const targetEmpId = (fineData.assignedEmployees && fineData.assignedEmployees.length > 0)
                ? fineData.assignedEmployees[0].employeeId
                : employeeId;

            if (targetEmpId && targetEmpId !== 'PENDING') {
                try {
                    const { getDepartmentHOD } = await import('../../utils/getDepartmentHOD.js');
                    const hrHOD = await getDepartmentHOD('hr', targetEmpId);
                    if (hrHOD) {
                        const hrUser = await User.findOne({ employeeId: hrHOD.employeeId });
                        if (hrUser) {
                            fineData.submittedTo = hrUser._id;
                            fineData.fineStatus = 'Pending HR';
                            fineData.workflow = [{
                                role: 'HR',
                                assignedTo: hrUser._id,
                                status: 'Pending',
                                assignedAt: new Date()
                            }];
                            console.log(`[AddFine] Fine routed directly to HR: ${hrUser._id}`);
                        }
                    }
                } catch (snapErr) {
                    console.error('[AddFine] Error resolving HR:', snapErr);
                }
            }
        }

        const fine = new Fine(fineData);
        const savedFine = await fine.save();

        // === SYNC DASHBOARD ACTION (SINGLE) ===
        if (savedFine.fineStatus !== 'Draft') {
            const { syncDashboardAction } = await import("../../utils/syncDashboard.js");
            const reporteeStep = savedFine.workflow?.find(w => w.status === 'Pending');
            if (reporteeStep) {
                const targetEmpId = (savedFine.assignedEmployees && savedFine.assignedEmployees.length > 0)
                    ? savedFine.assignedEmployees[0].employeeId
                    : employeeId;
                const subjectEmp = await EmployeeBasic.findOne({ employeeId: targetEmpId });
                await syncDashboardAction({
                    requestId: savedFine._id,
                    requestType: 'Fine',
                    assignedTo: reporteeStep.assignedTo,
                    status: 'Pending',
                    subjectEmployee: subjectEmp,
                    extra1: savedFine.fineType,
                    extra2: `AED ${savedFine.fineAmount}`
                });
            }
            sendFineApprovalEmail(savedFine, fineData.assignedEmployees).catch(err => console.error(err));
        }

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

import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import { getSignedFileUrl, refreshStoredAttachmentUrls, repairStoredAttachments } from "../../utils/s3Upload.js";
import { getDepartmentHOD } from "../../utils/getDepartmentHOD.js";
import { getManagementHOD } from "../../utils/getManagementHOD.js";
import { isUserAdministrator } from "../../services/permissionService.js";
import { synthesizeSingleRecordGroupFineView } from "../../utils/fineGroupClassification.js";

/** Per-party service charge (sibling rows store their share; group view has full SC on parent). */
function partyServiceShare(fine, entry = {}) {
    const perRecord = parseFloat(entry.serviceCharge ?? 0) || 0;
    if (perRecord > 0) return perRecord;

    const total = parseFloat(fine.serviceCharge || 0) || 0;
    if (total <= 0) return 0;

    const rf = (fine.responsibleFor || 'Employee').trim();
    const partyCount = (fine.assignedEmployees || []).filter(
        (ae) => ae?.employeeId && ae.employeeId !== 'PENDING',
    ).length;

    if (rf === 'Company') return total;
    if (rf !== 'Employee & Company') return total;

    if (!fine.isGroupView && partyCount <= 1) return total;

    const n = Math.max(partyCount, 2);
    return total / n;
}

/** Fix legacy L&D saves where base was stored as (wrongGrand − serviceCharge). */
function normalizeFineBaseAmounts(fine) {
    if (!fine) return fine;

    const sc = parseFloat(fine.serviceCharge || 0);
    let emp = parseFloat(fine.employeeAmount || 0);
    const comp = parseFloat(fine.companyAmount || 0);

    if (emp < 0 && sc > 0) {
        emp = emp + sc;
        fine.employeeAmount = emp.toFixed(2);
    }

    const computedTotal = emp + comp + sc;
    const storedTotal = parseFloat(fine.totalFineAmount || fine.fineAmount || 0);
    if (computedTotal > 0 && (storedTotal <= 0 || storedTotal < computedTotal - 0.01)) {
        fine.totalFineAmount = computedTotal.toFixed(2);
    }

    if (Array.isArray(fine.assignedEmployees) && fine.assignedEmployees.length > 0) {
        fine.assignedEmployees = fine.assignedEmployees.map((e) => {
            let rowBase = parseFloat(e.employeeAmount ?? fine.employeeAmount ?? 0);
            if (rowBase < 0 && sc > 0) rowBase = rowBase + sc;
            const partySc = partyServiceShare(fine, e);
            const individualAmt = rowBase > 0
                ? rowBase + partySc
                : (parseFloat(e.individualAmount || 0) || 0);
            return {
                ...e,
                employeeAmount: rowBase,
                fineAmount: rowBase,
                individualAmount: individualAmt,
                serviceCharge: partySc,
            };
        });
    }

    return fine;
}

export const getFineById = async (req, res) => {
    try {
        let { id } = req.params;

        // Clean ID: strip artifacts like ":1"
        if (id && typeof id === 'string') {
            try {
                id = decodeURIComponent(id);
            } catch (e) {
                // ignore
            }
            if (id.includes(':')) {
                id = id.split(':')[0];
            }
            id = id.trim();
        }

        let fine;
        let relatedFines = [];

        // Check if id is a valid MongoDB ObjectId
        const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(id);

        if (isValidObjectId) {
            fine = await Fine.findOne({
                $or: [{ _id: id }, { fineId: id }]
            })
                .populate('createdBy', 'name firstName lastName email department designation')
                .populate('managerApprovedBy', 'name firstName lastName email department designation employeeId')
                .populate('hrApprovedBy', 'name firstName lastName email department designation employeeId')
                .populate('accountsApprovedBy', 'name firstName lastName email department designation employeeId')
                .populate('approvedBy', 'name firstName lastName email department designation employeeId')
                .populate('rejectedBy', 'name firstName lastName email department designation')
                .populate('submittedTo', 'name firstName lastName email department designation employeeId')
                .populate('workflow.assignedTo', 'name firstName lastName employeeId')
                .populate('company', 'companyId _id name') // Populate company to get companyId and name
                .lean();
        } else {
            fine = await Fine.findOne({ fineId: id })
                .populate('createdBy', 'name firstName lastName email department designation')
                .populate('hrApprovedBy', 'name firstName lastName email department designation employeeId')
                .populate('accountsApprovedBy', 'name firstName lastName email department designation employeeId')
                .populate('approvedBy', 'name firstName lastName email department designation employeeId')
                .populate('submittedTo', 'name firstName lastName email department designation employeeId')
                .populate('workflow.assignedTo', 'name firstName lastName employeeId')
                .populate('company', 'companyId _id name') // Populate company to get companyId and name
                .lean();
        }

        // --- SYNTHESIZE GROUPED FINE IF SIBLINGS EXIST ---
        // Determine the base ID
        let baseIdToUse = id;
        if (fine) {
            baseIdToUse = fine.fineId.split('-').length > 3 ? fine.fineId.split('-').slice(0, 3).join('-') : fine.fineId;
        } else {
            baseIdToUse = id.split('-').length > 3 ? id.split('-').slice(0, 3).join('-') : id;
        }

        const baseIdRegex = new RegExp(`^${baseIdToUse}(-[A-Z0-9]+)?$`, 'i');
        relatedFines = await Fine.find({ fineId: baseIdRegex })
            .populate('createdBy', 'name firstName lastName email department designation')
            .populate('hrApprovedBy', 'name firstName lastName email department designation employeeId')
            .populate('accountsApprovedBy', 'name firstName lastName email department designation employeeId')
            .populate('approvedBy', 'name firstName lastName email department designation employeeId')
            .populate('rejectedBy', 'name firstName lastName email department designation')
            .populate('submittedTo', 'name firstName lastName email department designation employeeId')
            .populate('workflow.assignedTo', 'name firstName lastName employeeId')
            .populate('company', 'companyId _id name') // Populate company to get companyId and name
            .sort({ fineId: 1 })
            .lean();

        if (relatedFines.length > 1) {
            // Group Fine synthesized view
            const first = relatedFines[0];
            fine = { ...first }; // copy common props

            const allAssigned = [];
            let totalFineAmt = 0;
            let totalEmpAmt = 0;
            let totalCompAmt = 0;
            let totalServiceCharge = 0;

            relatedFines.forEach(rf => {
                if (rf.assignedEmployees) {
                    // Enrich each entry with its specific record fineId and amounts for edit modal
                    const enriched = rf.assignedEmployees.map(e => {
                        const isCompanyRecord = e.employeeId === 'VEGA-HR-0000';
                        // individualAmount = total (base + service charge) for display
                        let individualAmt = e.individualAmount;
                        const baseEmp = parseFloat(rf.employeeAmount) || 0;
                        const baseComp = parseFloat(rf.companyAmount) || 0;
                        const sc = parseFloat(rf.serviceCharge) || 0;
                        const expectedWithSc = (isCompanyRecord || baseComp <= 0)
                            ? baseEmp + sc
                            : baseEmp + baseComp + sc;
                        if (!individualAmt || parseFloat(individualAmt) < expectedWithSc - 0.01) {
                            individualAmt = expectedWithSc;
                        }
                        // Base amount (without service charge) - for edit form per-person input
                        const baseAmount = baseEmp;
                        return {
                            ...e,
                            fineId: rf.fineId,
                            fineRecordId: rf._id,
                            fineStatus: rf.fineStatus,
                            individualAmount: individualAmt,
                            // Display / payable total always includes this party's service charge
                            fineAmount: individualAmt,
                            employeeAmount: baseAmount,
                            serviceCharge: sc,
                            payableDuration: rf.payableDuration || e.payableDuration,
                            expenseAccountId: rf.expenseAccountId || e.expenseAccountId || '',
                            expenseAccountName: rf.expenseAccountName || e.expenseAccountName || '',
                            payableConfirmed: Boolean(rf.payableConfirmed),
                        };
                    });
                    allAssigned.push(...enriched);
                }

                // FIX: If this record is the company's portion (VEGA-HR-0000), 
                // its employeeAmount IS the company liability.
                const hasCompanyPlaceholder = rf.assignedEmployees?.some(e => e.employeeId === 'VEGA-HR-0000');
                
                if (hasCompanyPlaceholder) {
                    totalCompAmt += parseFloat(rf.employeeAmount) || 0;
                } else {
                    totalEmpAmt += parseFloat(rf.employeeAmount) || 0;
                    totalCompAmt += parseFloat(rf.companyAmount) || 0;
                }
                
                // Sum service charge from all records (it's already distributed per employee)
                totalServiceCharge += parseFloat(rf.serviceCharge) || 0;
                
                // fineAmount already includes service charge per record, so sum it up
                totalFineAmt += parseFloat(rf.fineAmount) || 0;
                
                // Ensure company ID and details are preserved
                if (rf.company && !fine.company) {
                    fine.company = rf.company;
                } else if (rf.company && fine.company && !fine.company.companyId && rf.company.companyId) {
                    // Merge company details if missing
                    fine.company = { ...fine.company, ...rf.company };
                }
            });

            // Update synthesized fields
            fine.fineId = baseIdToUse; // use base ID
            fine.isGroupView = true;
            fine.assignedEmployees = allAssigned;
            fine.fineAmount = totalFineAmt.toFixed(2); // Total includes service charge (sum of all rf.fineAmount)
            fine.employeeAmount = totalEmpAmt.toFixed(2);
            fine.companyAmount = totalCompAmt.toFixed(2);
            fine.serviceCharge = totalServiceCharge.toFixed(2); // Total service charge for the group
            // Calculate totalFineAmount from components: employeeAmount + companyAmount + serviceCharge
            fine.totalFineAmount = (totalEmpAmt + totalCompAmt + totalServiceCharge).toFixed(2);

            // Prefer any sibling's Accounts vendor / Fine Source for Management billing
            for (const rf of relatedFines) {
                if (!fine.fineSource && rf.fineSource) fine.fineSource = rf.fineSource;
                if (!fine.zohoVendorId && rf.zohoVendorId) fine.zohoVendorId = rf.zohoVendorId;
                if (!fine.zohoVendorName && rf.zohoVendorName) fine.zohoVendorName = rf.zohoVendorName;
                if (!fine.zohoOrganizationId && rf.zohoOrganizationId) {
                    fine.zohoOrganizationId = rf.zohoOrganizationId;
                }
            }
        } else if (relatedFines.length === 1 && !fine) {
            fine = relatedFines[0];
            // Ensure totalFineAmount is set for single fines too
            if (!fine.totalFineAmount) {
                const empAmt = parseFloat(fine.employeeAmount || 0);
                const compAmt = parseFloat(fine.companyAmount || 0);
                const servCharge = parseFloat(fine.serviceCharge || 0);
                fine.totalFineAmount = (empAmt + compAmt + servCharge).toFixed(2);
            }
            // Enrich assignedEmployees for edit: add employeeAmount (base) per person
            if (fine.assignedEmployees && fine.assignedEmployees.length > 0) {
                fine.assignedEmployees = fine.assignedEmployees.map(e => {
                    const baseEmp = parseFloat(e.employeeAmount ?? fine.employeeAmount ?? 0);
                    const baseComp = parseFloat(e.companyAmount ?? fine.companyAmount ?? 0);
                    const sc = parseFloat(fine.serviceCharge || 0);
                    const isSplitShare = (fine.responsibleFor || '') === 'Employee & Company' && baseComp > 0;
                    const expectedWithSc = isSplitShare
                        ? baseEmp + (sc / 2)
                        : baseEmp + baseComp + sc;
                    let individualAmt = e.individualAmount;
                    if (!individualAmt || parseFloat(individualAmt) < expectedWithSc - 0.01) {
                        individualAmt = expectedWithSc;
                    }
                    return {
                        ...e,
                        employeeAmount: e.employeeAmount ?? fine.employeeAmount,
                        fineAmount: (e.employeeAmount ?? fine.employeeAmount) ?? e.fineAmount,
                        individualAmount: individualAmt,
                        payableDuration: e.payableDuration ?? fine.payableDuration
                    };
                });
            }
        }

        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        // Visibility: Draft - only creator sees; Admin sees all
        const isAdmin = await isUserAdministrator(req.user?.id);
        const isCreator = fine.createdBy && (fine.createdBy._id?.toString() || fine.createdBy.toString()) === req.user?.id;
        if (!isAdmin && fine.fineStatus === 'Draft' && !isCreator) {
            return res.status(403).json({ message: "Access denied. Draft fines are visible only to the creator." });
        }

        // Ensure totalFineAmount is always set (fallback for any edge cases)
        normalizeFineBaseAmounts(fine);

        if (!fine.isGroupView) {
            synthesizeSingleRecordGroupFineView(fine);
        }

        // Generate signed URL if attachment exists; repair legacy inline data → S3
        if (fine.attachment?.data || fine.attachment?.base64) {
            await repairStoredAttachments(fine.attachment, {
                folder: `fines/${fine.fineId || fine._id}`,
                fileName: fine.attachment.name || 'fine-attachment.pdf',
                resourceType: 'raw',
            });
            if (fine.attachment?.publicId && fine._id) {
                await Fine.updateOne(
                    { _id: fine._id },
                    {
                        $set: {
                            'attachment.publicId': fine.attachment.publicId,
                            'attachment.url': fine.attachment.url,
                            'attachment.name': fine.attachment.name,
                            'attachment.mimeType': fine.attachment.mimeType,
                        },
                        $unset: { 'attachment.data': '', 'attachment.base64': '' },
                    },
                );
            }
        }
        if (fine.attachment?.publicId) {
            try {
                const signedUrl = await getSignedFileUrl(fine.attachment.publicId);
                if (signedUrl) fine.attachment.url = signedUrl;
            } catch (err) {
                console.error("Error signing attachment URL:", err);
            }
        } else if (fine.attachment?.url) {
            await refreshStoredAttachmentUrls([fine.attachment]);
        }

        if (Array.isArray(fine.attachments) && fine.attachments.length > 0) {
            await repairStoredAttachments(fine.attachments, {
                folder: `fines/${fine.fineId || fine._id}`,
                fileName: 'fine-attachment',
                resourceType: 'auto',
            });

            await Promise.all(
                fine.attachments.map(async (item, index) => {
                    if (!item) return;
                    if (item.publicId) {
                        try {
                            const signedUrl = await getSignedFileUrl(item.publicId);
                            if (signedUrl) item.url = signedUrl;
                        } catch (err) {
                            console.error(`Error signing attachment URL [${index}]:`, err);
                        }
                    } else if (item.url) {
                        await refreshStoredAttachmentUrls([item]);
                    }
                }),
            );
        }

        if (Array.isArray(fine.approvalAttachments) && fine.approvalAttachments.length > 0) {
            await refreshStoredAttachmentUrls(fine.approvalAttachments);
        }

        if (Array.isArray(fine.approvalAttachmentHistory) && fine.approvalAttachmentHistory.length > 0) {
            await refreshStoredAttachmentUrls(fine.approvalAttachmentHistory);
        }

        if (
            !fine.accessoryExcludedAt &&
            Array.isArray(fine.excludedAccessoryIds) &&
            fine.excludedAccessoryIds.length > 0
        ) {
            const accessoryHistory = (fine.approvalAttachmentHistory || [])
                .filter((a) => a.trigger === 'accessory-edit' && a.addedAt)
                .sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
            if (accessoryHistory.length > 0) {
                fine.accessoryExcludedAt = accessoryHistory[accessoryHistory.length - 1].addedAt;
            }
        }

        // Populate Manager Info for Frontend Permission Check
        if (fine.assignedEmployees && fine.assignedEmployees.length > 0) {
            const empIds = fine.assignedEmployees.map(e => e.employeeId);
            const employees = await EmployeeBasic.find({ employeeId: { $in: empIds } })
                .select('employeeId primaryReportee')
                .populate('primaryReportee', 'email companyEmail firstName lastName employeeId')
                .lean();

            // Merge back
            fine.assignedEmployees = fine.assignedEmployees.map(assigned => {
                const empDetails = employees.find(e => e.employeeId === assigned.employeeId);
                return {
                    ...assigned,
                    managerInfo: empDetails?.primaryReportee || null
                };
            });
        }

        // Determine the primary employee for context (Context Aware)
        // Skip 'VEGA-HR-0000' (Company share record) to find the actual company of the group
        const realEmployee = fine.assignedEmployees?.find(e => e.employeeId && e.employeeId !== 'VEGA-HR-0000');
        const targetEmployeeId = realEmployee?.employeeId || (fine.assignedEmployees?.[0]?.employeeId) || fine.employeeId;

        // Fetch current HODs for display fallbacks in tracker
        // Passes the employee ID to find THEIR company's specific responsibilities
        const hrHOD = await getDepartmentHOD('hr', targetEmployeeId);
        const accountsHOD = await getDepartmentHOD('finance', targetEmployeeId);
        const ceoHOD = await getManagementHOD(targetEmployeeId);

        // Reassign flowchart HR/Accounts/Management → update pending workflow + task bar to new assignee
        if (fine?._id) {
            try {
                const { syncPendingFineAssigneeFromFlowchart } = await import('../../utils/fineStageAuth.js');
                const FineModel = (await import('../../models/Fine.js')).default;
                const freshDoc = await FineModel.findById(fine._id);
                if (freshDoc) {
                    await syncPendingFineAssigneeFromFlowchart(freshDoc);
                    const synced = await FineModel.findById(fine._id)
                        .populate('workflow.assignedTo', 'name firstName lastName employeeId')
                        .populate('submittedTo', 'name firstName lastName email department designation employeeId')
                        .lean();
                    if (synced) {
                        fine.workflow = synced.workflow;
                        fine.submittedTo = synced.submittedTo;
                    }
                }
            } catch (syncErr) {
                console.error('[getFineById] Flowchart assignee sync failed:', syncErr?.message || syncErr);
            }
        }

        // Reflect Zoho bill Paid / Not Paid → Fine "Paid to Vendor" on every refresh.
        if (fine?._id && String(fine.zohoBillId || '').trim()) {
            try {
                const { syncFineVendorBillStatusFromZoho } = await import(
                    '../../utils/markFineVendorBillsPaidFromZoho.js'
                );
                // unpaidOnly: live-check when ERP still shows Not Paid (heals already-paid Zoho bills).
                await syncFineVendorBillStatusFromZoho(fine, { fetchLive: 'unpaidOnly' });
                const FineModel = (await import('../../models/Fine.js')).default;
                const paidDoc = await FineModel.findById(fine._id)
                    .select('vendorBillStatus vendorBillPaidAt zohoVendorPaymentId zohoVendorPaymentNumber')
                    .lean();
                if (paidDoc) {
                    fine.vendorBillStatus = paidDoc.vendorBillStatus;
                    fine.vendorBillPaidAt = paidDoc.vendorBillPaidAt;
                    fine.zohoVendorPaymentId = paidDoc.zohoVendorPaymentId;
                    fine.zohoVendorPaymentNumber = paidDoc.zohoVendorPaymentNumber;
                }
            } catch (vendorSyncErr) {
                console.error(
                    '[getFineById] Vendor bill Paid/Not Paid sync failed:',
                    vendorSyncErr?.message || vendorSyncErr,
                );
            }
        }

        const hrHODName = hrHOD ? `${hrHOD.firstName} ${hrHOD.lastName}` : 'Unknown';
        const accountsHODName = accountsHOD ? `${accountsHOD.firstName} ${accountsHOD.lastName}` : 'Unknown';
        const ceoName = ceoHOD ? `${ceoHOD.firstName} ${ceoHOD.lastName}` : 'Unknown';

        let formSummary = null;
        try {
            const { buildFineFormSummary } = await import('../../utils/buildFineFormSummary.js');
            formSummary = await buildFineFormSummary(fine, {
                employeeId: targetEmployeeId,
                hrHODName,
                accountsHODName,
                ceoName,
            });
        } catch (summaryErr) {
            console.error('[getFineById] formSummary build failed:', summaryErr?.message || summaryErr);
        }

        return res.status(200).json({
            ...fine,
            hrHODName,
            hrHODId: hrHOD ? hrHOD.employeeId : null,
            accountsHODName,
            accountsHODId: accountsHOD ? accountsHOD.employeeId : null,
            ceoName,
            ceoEmployeeId: ceoHOD ? ceoHOD.employeeId : null,
            formSummary,
        });
    } catch (error) {
        console.error('Error fetching fine:', error);
        return res.status(500).json({
            message: "Failed to fetch fine details",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

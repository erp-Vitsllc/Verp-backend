import Fine from "../../models/Fine.js";
import mongoose from "mongoose";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { isUserAdministrator } from "../../services/permissionService.js";

export const getFines = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 1000,
            search = '',
            status,
            type,
            startDate,
            endDate,
            employeeId,
            vehicleId,
            assetId,
            companyId
        } = req.query;

        const query = {};

        // Search by employee name or fine ID
        const searchConditions = [];
        if (search) {
            searchConditions.push(
                { fineId: { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeName': { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeId': { $regex: search, $options: 'i' } }
            );
        }

        // Filter by Company ID: Show ONLY approved/paid company-responsible fines (not employee fines)
        // Company fines are identified by:
        // 1. assignedEmployees contains VEGA-HR-0000 (company record)
        // 2. OR responsibleFor === 'Company' AND company matches
        // 3. AND status must be Approved, Active, Completed, or Paid
        const companyConditions = [];
        if (companyId) {
            const approvedStatuses = ['Approved', 'Active', 'Completed', 'Paid'];
            companyConditions.push(
                // Company record (VEGA-HR-0000) - this is the company's fine record
                { 
                    'assignedEmployees.employeeId': 'VEGA-HR-0000', 
                    company: companyId,
                    fineStatus: { $in: approvedStatuses }
                },
                // Direct company responsibility
                { 
                    responsibleFor: 'Company', 
                    company: companyId,
                    fineStatus: { $in: approvedStatuses }
                }
            );
        }

        // Combine search and company conditions
        if (searchConditions.length > 0 && companyConditions.length > 0) {
            query.$and = [
                { $or: searchConditions },
                { $or: companyConditions }
            ];
        } else if (searchConditions.length > 0) {
            query.$or = searchConditions;
        } else if (companyConditions.length > 0) {
            query.$or = companyConditions;
        }

        if (status) query.fineStatus = status;
        if (type) query.fineType = type;

        // Filter by Employee ID: Check only assigned list
        if (employeeId) {
            query['assignedEmployees.employeeId'] = employeeId;
        }
        if (vehicleId) query.vehicleId = vehicleId;
        if (assetId) query.assetId = assetId;

        if (startDate || endDate) {
            query.awardedDate = {};
            if (startDate) query.awardedDate.$gte = new Date(startDate);
            if (endDate) query.awardedDate.$lte = new Date(endDate);
        }

        // Visibility: Draft - only creator sees; Pending+ - everyone. Admin sees all.
        const isAdmin = await isUserAdministrator(req.user?.id);
        if (!isAdmin && req.user?.id) {
            query.$and = query.$and || [];
            query.$and.push({
                $or: [
                    { fineStatus: { $ne: 'Draft' } },
                    { createdBy: new mongoose.Types.ObjectId(req.user.id) }
                ]
            });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const fines = await Fine.find(query)
            .populate('company', 'companyId _id name') // Populate company to get companyId string
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Sign Attachment URLs & Auto-fill missing company names
        const EmployeeBasic = (await import('../../models/EmployeeBasic.js')).default;

        const signedFines = await Promise.all(fines.map(async (fine) => {
            if (fine.attachment?.publicId) {
                const signedUrl = await getSignedFileUrl(fine.attachment.publicId);
                fine.attachment.url = signedUrl;
            }

            // Auto-heal missing company details from employee profile
            if ((!fine.companyName || fine.companyName === 'N/A') && fine.assignedEmployees?.length > 0) {
                const empId = fine.assignedEmployees[0].employeeId;
                if (empId) {
                    const emp = await EmployeeBasic.findOne({ employeeId: empId }).populate('company').lean();
                    if (emp?.company && emp.company.name) {
                        fine.companyName = emp.company.name;
                        fine.company = emp.company._id;
                        // Update the database record to permanently fix it
                        await Fine.updateOne({ _id: fine._id }, { companyName: fine.companyName, company: fine.company });
                    }
                }
            }

            return fine;
        }));

        const total = await Fine.countDocuments(query);

        return res.status(200).json({
            fines: signedFines,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching fines:', error);
        return res.status(500).json({
            message: "Failed to fetch fines",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

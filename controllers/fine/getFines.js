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

        const searchConditions = [];
        if (search) {
            searchConditions.push(
                { fineId: { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeName': { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeId': { $regex: search, $options: 'i' } }
            );
        }

        // Company profile Fine tab: fines where this company has liability
        const companyConditions = [];
        if (companyId) {
            const companyOid = mongoose.Types.ObjectId.isValid(companyId)
                ? new mongoose.Types.ObjectId(companyId)
                : companyId;

            companyConditions.push(
                {
                    company: companyOid,
                    'assignedEmployees.employeeId': 'VEGA-HR-0000',
                },
                {
                    company: companyOid,
                    responsibleFor: 'Company',
                },
                {
                    company: companyOid,
                    responsibleFor: 'Employee & Company',
                    companyAmount: { $gt: 0 },
                    'assignedEmployees.employeeId': { $ne: 'VEGA-HR-0000' },
                    fineId: { $not: /VEGA-FINE-\d+-[A-Z]$/i },
                }
            );
        }

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
            .populate('company', 'companyId _id name')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const EmployeeBasic = (await import('../../models/EmployeeBasic.js')).default;

        const signedFines = await Promise.all(fines.map(async (fine) => {
            if (fine.attachment?.publicId) {
                const signedUrl = await getSignedFileUrl(fine.attachment.publicId);
                if (signedUrl) fine.attachment.url = signedUrl;
            }

            if (Array.isArray(fine.attachments) && fine.attachments.length > 0) {
                fine.attachments = await Promise.all(
                    fine.attachments.map(async (attachment) => {
                        if (!attachment) return attachment;
                        if (attachment.publicId) {
                            const signedUrl = await getSignedFileUrl(attachment.publicId);
                            return { ...attachment, url: signedUrl || attachment.url };
                        }
                        return attachment;
                    }),
                );
            }

            if ((!fine.companyName || fine.companyName === 'N/A') && fine.assignedEmployees?.length > 0) {
                const empId = fine.assignedEmployees[0].employeeId;
                if (empId && empId !== 'VEGA-HR-0000') {
                    const emp = await EmployeeBasic.findOne({ employeeId: empId }).populate('company').lean();
                    if (emp?.company && emp.company.name) {
                        fine.companyName = emp.company.name;
                        fine.company = emp.company._id;
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

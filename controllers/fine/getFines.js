import Fine from "../../models/Fine.js";
import { getSignedFileUrl } from "../../utils/s3Upload.js";

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
            assetId
        } = req.query;

        const query = {};

        // Search by employee name or fine ID
        if (search) {
            query.$or = [
                { fineId: { $regex: search, $options: 'i' } },
                // Search inside assigned employees
                { 'assignedEmployees.employeeName': { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeId': { $regex: search, $options: 'i' } }
            ];
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

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const fines = await Fine.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Sign Attachment URLs
        const signedFines = await Promise.all(fines.map(async (fine) => {
            if (fine.attachment?.publicId) {
                const signedUrl = await getSignedFileUrl(fine.attachment.publicId);
                fine.attachment.url = signedUrl;
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

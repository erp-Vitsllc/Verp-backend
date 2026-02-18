import Reward from "../../models/Reward.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";
import mongoose from "mongoose";
import { getSignedFileUrl } from "../../utils/s3Upload.js";
import { escapeRegex } from "../../utils/regexHelper.js";

export const getRewards = async (req, res) => {
    // Check database connection first
    if (mongoose.connection.readyState !== 1) {
        console.error('Database not connected. Connection state:', mongoose.connection.readyState);
        return res.status(503).json({
            message: 'Database not connected. Please check server logs and ensure MongoDB is running.'
        });
    }

    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const skip = (page - 1) * limit;

        // Query filters
        const filters = {};
        const { employeeId, rewardType, rewardStatus, search, reporteeOf } = req.query;

        if (employeeId) filters.employeeId = employeeId;
        if (rewardType) filters.rewardType = rewardType;
        if (rewardStatus) filters.rewardStatus = rewardStatus;

        // Rule 5: Only show rewards for employees who report directly to the user (if reporteeOf is provided)
        if (reporteeOf) {
            // Find all employees who have this user as their primaryReportee
            // We need to find the Employee ObjectId for the given reporteeOf (which might be an employeeId string)
            // Assuming reporteeOf is the logged-in user's Employee ID (string, e.g. VITS001)

            // First, find the _id of the manager (if reporteeOf is a string ID)
            const manager = await EmployeeBasic.findOne({
                $or: [{ employeeId: reporteeOf }, { _id: mongoose.Types.ObjectId.isValid(reporteeOf) ? reporteeOf : null }]
            }).select('_id');

            if (manager) {
                // Find all employees reporting to this manager
                const reportees = await EmployeeBasic.find({ primaryReportee: manager._id }).select('employeeId');
                const reporteeIds = reportees.map(r => r.employeeId);

                // Add to filters
                if (filters.employeeId) {
                    // If employeeId filter already exists, ensure it's one of the reportees
                    if (!reporteeIds.includes(filters.employeeId)) {
                        // User trying to access a non-reportee, return empty
                        return res.status(200).json({
                            message: "Rewards fetched successfully",
                            rewards: [],
                            pagination: { page, limit, total: 0, totalPages: 1 }
                        });
                    }
                } else {
                    // Filter rewards where employeeId is in the list of reportees
                    filters.employeeId = { $in: reporteeIds };
                }
            } else {
                // Manager not found, return empty or handle as error?
                // Returning empty is safer
                return res.status(200).json({
                    message: "Rewards fetched successfully",
                    rewards: [],
                    pagination: { page, limit, total: 0, totalPages: 1 }
                });
            }
        }

        if (search) {
            const regex = new RegExp(escapeRegex(search), 'i');
            filters.$or = [
                { rewardId: regex },
                { employeeId: regex },
                { employeeName: regex },
                { description: regex }
            ];
        }

        const queryOptions = { maxTimeMS: 20000 }; // 20 seconds max query time

        const [rewards, total] = await Promise.all([
            Reward.find(filters, null, queryOptions)
                .select('-__v')
                .populate({
                    path: 'approvedBy',
                    select: 'name username',
                    options: { lean: true }
                })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Reward.countDocuments(filters, queryOptions),
        ]);

        // Sign Attachment URLs
        const signedRewards = await Promise.all(rewards.map(async (reward) => {
            if (reward.attachment?.publicId) {
                const signedUrl = await getSignedFileUrl(reward.attachment.publicId);
                reward.attachment.url = signedUrl;
            }
            return reward;
        }));

        return res.status(200).json({
            message: "Rewards fetched successfully",
            rewards: signedRewards,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });
    } catch (error) {
        console.error('Error fetching rewards:', error);

        if (error.name === 'CastError' || error.name === 'ValidationError') {
            return res.status(400).json({
                message: `Invalid data: ${error.message}`
            });
        }

        return res.status(500).json({
            message: error.message || 'Failed to fetch rewards'
        });
    }
};

















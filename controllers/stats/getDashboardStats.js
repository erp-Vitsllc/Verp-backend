import Loan from "../../models/Loan.js";
import Reward from "../../models/Reward.js";
import Fine from "../../models/Fine.js";
import EmployeeBasic from "../../models/EmployeeBasic.js";

export const getDashboardStats = async (req, res) => {
    try {
        const currentUser = req.user;

        // 1. Loans Stats
        const totalLoans = await Loan.countDocuments({});
        const pendingLoans = await Loan.countDocuments({ status: 'Pending' });
        const pendingAuthLoans = await Loan.countDocuments({ status: 'Pending Authorization' });
        const approvedLoans = await Loan.countDocuments({ status: 'Approved' });

        // Detailed Loan Stats: Total Amount Disbursed (Approved)
        const loanAmountAgg = await Loan.aggregate([
            { $match: { status: 'Approved' } },
            { $group: { _id: null, totalAmount: { $sum: "$amount" } } }
        ]);
        const totalLoanAmount = loanAmountAgg[0]?.totalAmount || 0;

        // 2. Rewards Stats
        const totalRewards = await Reward.countDocuments({});
        const currentMonth = new Date();
        const startOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
        const rewardsThisMonth = await Reward.countDocuments({ createdAt: { $gte: startOfMonth } });

        // Detailed Reward Stats: Total Cost
        const rewardAmountAgg = await Reward.aggregate([
            { $match: { rewardStatus: 'Active' } },
            { $group: { _id: null, totalAmount: { $sum: "$amount" } } }
        ]);
        const totalRewardAmount = rewardAmountAgg[0]?.totalAmount || 0;

        // 3. Fines Stats
        const totalFines = await Fine.countDocuments({});
        const pendingFines = await Fine.countDocuments({ status: { $in: ['Pending', 'Submitted for Authorization'] } });

        // Detailed Fine Stats: By Category & Total Amount
        const fineStatsAgg = await Fine.aggregate([
            {
                $group: {
                    _id: "$category",
                    count: { $sum: 1 },
                    totalAmount: { $sum: "$fineAmount" }
                }
            }
        ]);

        // 4. Notices Stats
        const pendingNotices = await EmployeeBasic.countDocuments({
            "noticeRequest.status": "Pending",
            "noticeRequest.requestedAt": { $exists: true }
        });

        // 5. Employees Stats
        const totalEmployees = await EmployeeBasic.countDocuments({ profileStatus: 'active' });

        // Employee Breakdown by Department
        const employeesByDept = await EmployeeBasic.aggregate([
            { $match: { profileStatus: 'active' } },
            { $group: { _id: "$department", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 } // Top 5 departments
        ]);

        res.status(200).json({
            loans: {
                total: totalLoans,
                pending: pendingLoans,
                pendingAuth: pendingAuthLoans,
                approved: approvedLoans,
                totalDisbursed: totalLoanAmount
            },
            rewards: {
                total: totalRewards,
                thisMonth: rewardsThisMonth,
                totalAmount: totalRewardAmount
            },
            fines: {
                total: totalFines,
                pending: pendingFines,
                byCategory: fineStatsAgg
            },
            notices: {
                pending: pendingNotices
            },
            employees: {
                total: totalEmployees,
                byDept: employeesByDept
            }
        });

    } catch (error) {
        console.error("Dashboard Stats Error:", error);
        res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
};

import express from 'express';
import mongoose from 'mongoose';
import { createAssetType, getAssetTypes, deleteAssetType, getAssetTypeById, uploadInvoice, updateAssetItem, submitAssetForApproval } from '../controllers/assetTypeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';

const requireAssetControllerOrAdmin = async (req, res, next) => {
    try {
        const isAdmin = req.user.isAdmin === true || req.user.role === 'Admin' || req.user.role === 'ROOT';
        if (isAdmin) return next();

        if (await isUserInFlowchart(req.user, 'assetcontroller')) return next();

        const { id } = req.params;
        if (id && mongoose.Types.ObjectId.isValid(id)) {
            const AssetItem = (await import('../models/AssetItem.js')).default;
            const asset = await AssetItem.findById(id);

            if (asset) {
                const currentUserId = req.user._id?.toString() || req.user.id?.toString();
                const isCreator = asset.createdBy?.toString() === currentUserId;
                const isEditableDraft = asset.status === 'Draft' && !asset.actionRequiredBy;

                // Allow creator only for editable Draft (before submission)
                if (isCreator && isEditableDraft) {
                    return next();
                }

                // Allow assigned user to update accessories on their assigned asset (PUT with accessories)
                const norm = (s) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
                let currentEmpObjectId = req.user.employeeObjectId?.toString?.() || null;
                if (!currentEmpObjectId && req.user.employeeId) {
                    const userNorm = norm(req.user.employeeId);
                    if (userNorm) {
                        const empRow = await EmployeeBasic.findOne({
                            $expr: {
                                $eq: [
                                    {
                                        $replaceAll: {
                                            input: { $toLower: { $ifNull: ['$employeeId', ''] } },
                                            find: ' ',
                                            replacement: ''
                                        }
                                    },
                                    userNorm
                                ]
                            }
                        }).select('_id').lean();
                        if (empRow?._id) currentEmpObjectId = empRow._id.toString();
                    }
                }

                const isAssignedUser =
                    !!currentEmpObjectId &&
                    !!asset.assignedTo &&
                    asset.assignedTo.toString() === currentEmpObjectId;

                // Assigner (asset.assignedBy) full permission for assigned assets
                const isAssigner =
                    !!currentEmpObjectId &&
                    !!asset.assignedBy &&
                    asset.assignedBy.toString() === currentEmpObjectId;

                // If assignee has NO portal/login access (or no companyEmail), allow primaryReportee delegate
                let isPrimaryReporteeDelegate = false;
                if (
                    !!currentEmpObjectId &&
                    asset.assignedToType === 'Employee' &&
                    !!asset.assignedTo
                ) {
                    const assigneeDoc = await EmployeeBasic.findById(asset.assignedTo)
                        .select('companyEmail primaryReportee employeeId')
                        .lean()
                        .catch(() => null);

                    const hasCompanyEmail = !!(assigneeDoc?.companyEmail && String(assigneeDoc.companyEmail).trim().length > 0);
                    let hasPortalAccess = null;
                    if (assigneeDoc?.employeeId) {
                        const linkedUser = await User.findOne({ employeeId: assigneeDoc.employeeId, status: 'Active' })
                            .select('enablePortalAccess')
                            .lean()
                            .catch(() => null);
                        hasPortalAccess = !!(linkedUser && linkedUser.enablePortalAccess);
                    }
                    const primaryId = assigneeDoc?.primaryReportee?._id
                        ? assigneeDoc.primaryReportee._id.toString()
                        : assigneeDoc?.primaryReportee?.toString?.() || assigneeDoc?.primaryReportee || null;

                    isPrimaryReporteeDelegate = !!(
                        primaryId &&
                        primaryId.toString() === currentEmpObjectId &&
                        (!hasCompanyEmail || hasPortalAccess === false)
                    );
                }
                const isPutRequest = req.method === 'PUT';
                if ((isAssignedUser || isAssigner || isPrimaryReporteeDelegate) && isPutRequest) {
                    // Assigned employee / assigner / delegated primaryReportee can edit their assigned asset
                    return next();
                }
            }
        }

        return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can perform this operation.' });
    } catch (error) {
        next(error);
    }
};

const router = express.Router();

router.route('/')
    .post(protect, createAssetType)
    .get(protect, getAssetTypes);

router.route('/upload')
    .post(protect, uploadInvoice);

router.route('/:id')
    .delete(protect, requireAssetControllerOrAdmin, deleteAssetType)
    .get(protect, getAssetTypeById)
    .put(protect, requireAssetControllerOrAdmin, updateAssetItem);

router.put('/:id/submit-approval', protect, submitAssetForApproval);

export default router;

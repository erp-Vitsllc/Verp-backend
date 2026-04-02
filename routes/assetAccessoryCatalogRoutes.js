import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { isUserAdministrator } from '../services/permissionService.js';
import {
    getAccessoryCatalog,
    getAccessoryCatalogHistory,
    createAccessoryCatalog,
    updateAccessoryCatalog,
    deleteAccessoryCatalog,
    requestAttachAccessoryCatalog
} from '../controllers/assetAccessoryCatalogController.js';

const requireAssetControllerOrAdmin = async (req, res, next) => {
    try {
        const isAdmin =
            req.user.isAdmin === true ||
            req.user.role === 'Admin' ||
            req.user.role === 'ROOT' ||
            await isUserAdministrator(req.user?.id);
        if (isAdmin) return next();
        if (await isUserInFlowchart(req.user, 'assetcontroller')) return next();
        return res.status(403).json({ message: 'Access denied. Only Asset Controller or Admin can manage the accessories catalog.' });
    } catch (error) {
        next(error);
    }
};

const router = express.Router();

router.get('/:id/history', protect, getAccessoryCatalogHistory);

router.route('/')
    .get(protect, getAccessoryCatalog)
    .post(protect, requireAssetControllerOrAdmin, createAccessoryCatalog);

router.route('/:id')
    .put(protect, requireAssetControllerOrAdmin, updateAccessoryCatalog)
    .delete(protect, requireAssetControllerOrAdmin, deleteAccessoryCatalog);

router.put('/:id/request-attach', protect, requireAssetControllerOrAdmin, requestAttachAccessoryCatalog);

export default router;

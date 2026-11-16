import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import {
    createWorkOrder,
    getNextWorkOrderNo,
    getWorkOrder,
    getWorkOrderSalespeople,
    getWorkOrders,
    updateWorkOrder,
} from '../controllers/workOrderController.js';

const router = express.Router();

router.use(protect);

router.get('/next-no', checkPermission('production', 'view'), getNextWorkOrderNo);
router.get('/salespeople', checkPermission('production', 'view'), getWorkOrderSalespeople);
router.get('/', checkPermission('production', 'view'), getWorkOrders);
router.post('/', checkPermissionAny('production', ['create', 'view']), createWorkOrder);
router.get('/:id', checkPermission('production', 'view'), getWorkOrder);
router.patch('/:id', checkPermissionAny('production', ['edit', 'create', 'view']), updateWorkOrder);

export default router;

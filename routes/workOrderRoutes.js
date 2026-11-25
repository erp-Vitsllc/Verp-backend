import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import {
    applyWorkOrderQuotationChanges,
    createWorkOrder,
    getNextWorkOrderNo,
    getWorkOrder,
    getWorkOrderActualBoq,
    getWorkOrderCustomers,
    getWorkOrderQuotationChanges,
    getWorkOrderQuotationFile,
    getWorkOrderQuotationUse,
    getWorkOrderSalespeople,
    getWorkOrderVendors,
    getWorkOrders,
    updateWorkOrder,
    updateWorkOrderBudget,
} from '../controllers/workOrderController.js';

const router = express.Router();

router.use(protect);

router.get('/next-no', checkPermission('production', 'view'), getNextWorkOrderNo);
router.get('/salespeople', checkPermission('production', 'view'), getWorkOrderSalespeople);
router.get('/customers', checkPermission('production', 'view'), getWorkOrderCustomers);
router.get('/vendors', checkPermission('production', 'view'), getWorkOrderVendors);
router.get('/quotation-used', checkPermission('production', 'view'), getWorkOrderQuotationUse);
router.get('/', checkPermission('production', 'view'), getWorkOrders);
router.post('/', checkPermissionAny('production', ['create', 'view']), createWorkOrder);
router.post('/:id/budget', checkPermissionAny('production', ['edit', 'create', 'view']), updateWorkOrderBudget);
router.get('/:id/quotation-changes', checkPermission('production', 'view'), getWorkOrderQuotationChanges);
router.get('/:id/quotation-file', checkPermission('production', 'view'), getWorkOrderQuotationFile);
router.get('/:id/actual-boq', checkPermission('production', 'view'), getWorkOrderActualBoq);
router.post('/:id/quotation-changes', checkPermissionAny('production', ['edit', 'create', 'view']), applyWorkOrderQuotationChanges);
router.get('/:id', checkPermission('production', 'view'), getWorkOrder);
router.patch('/:id', checkPermissionAny('production', ['edit', 'create', 'view']), updateWorkOrder);

export default router;

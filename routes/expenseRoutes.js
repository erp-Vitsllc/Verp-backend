import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission } from '../middleware/permissionMiddleware.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import {
    listPartyExpenses,
    upsertPartyExpenseFromVendorPayment,
} from '../controllers/expense/partyExpenseController.js';

const router = express.Router();

router.use(protect);

async function canViewExpenses(req, res, next) {
    try {
        const userId = req.user?.id || req.user?._id;
        if (!userId) {
            return res.status(401).json({ message: 'Not authorized' });
        }
        if (isJwtSystemSuperUser(req.user)) return next();

        const { hasPermission, isUserAdministrator } = await import(
            '../services/permissionService.js'
        );
        if (await isUserAdministrator(userId)) return next();

        const modules = ['accounts', 'hrm_employees_view_salary', 'hrm_employees', 'hrm_asset'];
        for (const moduleId of modules) {
            if (await hasPermission(userId, moduleId, 'view')) return next();
            if (await hasPermission(userId, moduleId, 'full')) return next();
        }
        return res.status(403).json({ message: 'Access denied for expenses.' });
    } catch (err) {
        console.error('[canViewExpenses]', err);
        return res.status(500).json({ message: 'Error checking permissions' });
    }
}

router.get('/', canViewExpenses, listPartyExpenses);
router.post(
    '/from-vendor-payment',
    checkPermission('accounts', 'create'),
    upsertPartyExpenseFromVendorPayment,
);

export default router;

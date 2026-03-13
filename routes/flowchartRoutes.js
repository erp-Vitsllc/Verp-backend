import express from 'express';
import {
    getFlowchartResponsibilities,
    addFlowchartResponsibility,
    respondToResponsibility,
    deleteFlowchartResponsibility,
    getEmployeesForFlowchart
} from '../controllers/flowchartController.js';

import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/')
    .get(getFlowchartResponsibilities)
    .post(addFlowchartResponsibility);

router.put('/respond-responsibility', respondToResponsibility);

router.route('/employees')
    .get(getEmployeesForFlowchart);

router.route('/:id')
    .delete(deleteFlowchartResponsibility);

router.route('/category/:category')
    .delete(deleteFlowchartResponsibility);

export default router;

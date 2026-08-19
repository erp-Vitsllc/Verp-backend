import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    requireFlowchartHr,
    listFuelVehicles,
    listVehicleFuelBills,
    lookupVehicleFuel,
    addVehicleFuel,
    updateVehicleFuel,
    closeVehicleFuel,
    getVehicleFuelAttachment,
} from '../controllers/vehicleFuelController.js';

const router = express.Router();

router.get('/vehicles', protect, listFuelVehicles);
router.get('/lookup', protect, lookupVehicleFuel);
router.get('/vehicle/:vehicleId', protect, listVehicleFuelBills);
router.post('/', protect, requireFlowchartHr, addVehicleFuel);
router.post('/close', protect, requireFlowchartHr, closeVehicleFuel);
router.put('/:id', protect, requireFlowchartHr, updateVehicleFuel);
router.post('/:id/close', protect, requireFlowchartHr, closeVehicleFuel);
router.get('/:id/attachment', protect, getVehicleFuelAttachment);

export default router;

import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    requireCanManageFuel,
    listFuelVehicles,
    listAccessFuel,
    listFuelGpsStats,
    listVehicleFuelBills,
    lookupVehicleFuel,
    addVehicleFuel,
    updateVehicleFuel,
    updateVehicleFuelEntry,
    closeVehicleFuel,
    deleteVehicleFuel,
    getVehicleFuelAttachment,
} from '../controllers/vehicleFuelController.js';

const router = express.Router();

router.get('/vehicles', protect, listFuelVehicles);
router.get('/access-list', protect, listAccessFuel);
router.get('/gps-stats', protect, listFuelGpsStats);
router.get('/lookup', protect, lookupVehicleFuel);
router.get('/vehicle/:vehicleId', protect, listVehicleFuelBills);
router.post('/', protect, requireCanManageFuel, addVehicleFuel);
router.post('/close', protect, requireCanManageFuel, closeVehicleFuel);
router.put('/:id/entries/:entryId', protect, requireCanManageFuel, updateVehicleFuelEntry);
router.put('/:id', protect, requireCanManageFuel, updateVehicleFuel);
router.post('/:id/close', protect, requireCanManageFuel, closeVehicleFuel);
router.delete('/:id', protect, deleteVehicleFuel);
router.get('/:id/attachment', protect, getVehicleFuelAttachment);

export default router;

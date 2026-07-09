import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { getLocatorLatestPositions } from '../controllers/locator/getLocatorLatestPositions.js';
import { getLocatorLiveByImei } from '../controllers/locator/getLocatorLiveByImei.js';
import { getLocatorStatus } from '../controllers/locator/getLocatorStatus.js';
import { getLocatorCachedPositions } from '../controllers/locator/getLocatorCachedPositions.js';
import { getLocatorFleetDashboard } from '../controllers/locator/getLocatorFleetDashboard.js';
import { getLocatorVehicleList } from '../controllers/locator/getLocatorVehicleList.js';
import { getLocatorVehicleDetail } from '../controllers/locator/getLocatorVehicleDetail.js';
import { getLocatorDeviceOverlay } from '../controllers/locator/getLocatorDeviceOverlay.js';
import { postLocatorVehiclePlate } from '../controllers/locator/postLocatorVehiclePlate.js';
import { postLocatorFixAssignment } from '../controllers/locator/postLocatorFixAssignment.js';
import { postLocatorEnsureVehicle } from '../controllers/locator/postLocatorEnsureVehicle.js';

const router = express.Router();

router.get('/vehicle-list', protect, getLocatorVehicleList);
router.get('/vehicle-detail/:deviceId', protect, getLocatorVehicleDetail);
router.get('/device-overlay/:deviceId', protect, getLocatorDeviceOverlay);
router.post('/vehicle-plate', protect, postLocatorVehiclePlate);
router.post('/ensure-vehicle', protect, postLocatorEnsureVehicle);
router.post('/fix-assignment', protect, postLocatorFixAssignment);
router.get('/fleet-dashboard', protect, getLocatorFleetDashboard);
router.get('/status', protect, getLocatorStatus);
router.get('/positions/latest', protect, getLocatorLatestPositions);
router.get('/positions/cached', protect, getLocatorCachedPositions);
router.post('/live', protect, getLocatorLiveByImei);

export default router;

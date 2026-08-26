import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import {
    getWorkLocations,
    postWorkLocation,
    removeWorkLocation,
} from '../controllers/workLocationController.js';

const router = express.Router();

router.get('/', protect, getWorkLocations);
router.post('/', protect, postWorkLocation);
router.delete('/:id', protect, removeWorkLocation);

export default router;

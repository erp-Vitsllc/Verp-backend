import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
    createOutsideUaeDocumentType,
    getOutsideUaeDocumentTypes,
} from "../controllers/outsideUaeDocumentTypeController.js";

const router = express.Router();

router.get("/", protect, getOutsideUaeDocumentTypes);
router.post("/", protect, createOutsideUaeDocumentType);

export default router;

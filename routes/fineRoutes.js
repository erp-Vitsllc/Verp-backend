import express from "express";
import { addFine } from "../controllers/fine/addFine.js";
import { getFines } from "../controllers/fine/getFines.js";
import { getFineById } from "../controllers/fine/getFineById.js";
import { updateFine } from "../controllers/fine/updateFine.js";
import { deleteFine } from "../controllers/fine/deleteFine.js";
import { approveFine } from "../controllers/fine/approveFine.js";
import { protect } from "../middleware/authMiddleware.js";
import { checkPermission } from "../middleware/permissionMiddleware.js";

import { downloadFinePdf } from "../controllers/fine/downloadFinePdf.js";

const router = express.Router();

// All fine routes require authentication
router.use(protect);

// Get all fines - temporarily open for all authenticated users
router.get("/", getFines);

// Get fine by ID - temporarily open for all authenticated users
router.get("/:id", getFineById);

// Download Fine PDF - temporarily open for all authenticated users
router.get("/:id/pdf", downloadFinePdf);

// Add fine - requires create permission
router.post("/", checkPermission('hrm_fine', 'create'), addFine);

// Update fine - requires edit permission
router.patch("/:id", checkPermission('hrm_fine', 'edit'), updateFine);
router.put("/:id", checkPermission('hrm_fine', 'edit'), updateFine);
router.put("/:id/approve", approveFine); // Granular approval logic handles permission internally

// Delete fine - requires delete permission
router.delete("/:id", checkPermission('hrm_fine', 'delete'), deleteFine);

export default router;

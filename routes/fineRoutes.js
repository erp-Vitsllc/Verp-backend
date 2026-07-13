import express from "express";
import { addFine } from "../controllers/fine/addFine.js";
import { getFines } from "../controllers/fine/getFines.js";
import { getFineById } from "../controllers/fine/getFineById.js";
import { updateFine } from "../controllers/fine/updateFine.js";
import { deleteFine } from "../controllers/fine/deleteFine.js";
import { approveFine } from "../controllers/fine/approveFine.js";
import { protect } from "../middleware/authMiddleware.js";
import {
    checkFineMutatePermission,
    checkFineViewPermission,
} from "../middleware/permissionMiddleware.js";

import { downloadFinePdf } from "../controllers/fine/downloadFinePdf.js";
import { downloadFineApprovedReportPdf } from "../controllers/fine/downloadFineApprovedReportPdf.js";
import { getPendingFineDashboardInbox } from "../controllers/fine/getPendingFineDashboardInbox.js";

const router = express.Router();

// All fine routes require authentication
router.use(protect);

router.get("/dashboard/pending-inbox", getPendingFineDashboardInbox);

// List / detail / PDF — Fine View (or Add Fine child)
router.get("/", checkFineViewPermission(), getFines);
router.get("/:id", checkFineViewPermission(), getFineById);
router.get("/:id/approved-report-pdf", checkFineViewPermission(), downloadFineApprovedReportPdf);
router.get("/:id/pdf", checkFineViewPermission(), downloadFinePdf);

// Create / update / delete — Add Fine child (parent Fine is View-only in the chart)
router.post("/", checkFineMutatePermission(), addFine);
router.patch("/:id", checkFineMutatePermission(), updateFine);
router.put("/:id", checkFineMutatePermission(), updateFine);
router.delete("/:id", checkFineMutatePermission(), deleteFine);

// Approval — workflow validates actor inside the handler
router.put("/:id/approve", approveFine);

export default router;

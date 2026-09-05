import express from "express";
import { addFine } from "../controllers/fine/addFine.js";
import { getFines } from "../controllers/fine/getFines.js";
import { getFineById } from "../controllers/fine/getFineById.js";
import { updateFine } from "../controllers/fine/updateFine.js";
import { deleteFine } from "../controllers/fine/deleteFine.js";
import { approveFine } from "../controllers/fine/approveFine.js";
import { accountsFinePayment } from "../controllers/fine/accountsFinePayment.js";
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

// Workflow + Accounts (parent Fine View) — same pattern as Loan party-payable / status
router.put("/:id/approve", checkFineViewPermission(), approveFine);
router.put("/:id/accounts-payment", checkFineViewPermission(), accountsFinePayment);
router.put("/:id/reject", checkFineViewPermission(), (req, res) => {
    req.body = { ...(req.body || {}), fineStatus: "Rejected" };
    return updateFine(req, res);
});
router.put("/:id/status", checkFineViewPermission(), updateFine);
router.put("/:id/party-payable", checkFineViewPermission(), updateFine);

// Create / update / delete — Add Fine child (parent Fine is View-only in the chart)
router.post("/", checkFineMutatePermission(), addFine);
router.patch("/:id", checkFineMutatePermission(), updateFine);
router.put("/:id", checkFineMutatePermission(), updateFine);
router.delete("/:id", checkFineMutatePermission(), deleteFine);

export default router;

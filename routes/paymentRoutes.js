import express from "express";
import { getPayments } from "../controllers/payment/getPayments.js";
import { addPayment } from "../controllers/payment/addPayment.js";
import { deletePayment } from "../controllers/payment/deletePayment.js";
import { respondToPayment } from "../controllers/payment/respondToPayment.js";
import { protect } from "../middleware/authMiddleware.js";
import { checkPermission } from "../middleware/permissionMiddleware.js";

const router = express.Router();

// All payment routes require authentication
router.use(protect);

// Get all payments - requires view permission
router.get("/", checkPermission('accounts', 'view'), getPayments);

// Add payment - requires create permission
router.post("/", checkPermission('accounts', 'create'), addPayment);

// Delete payment - requires delete permission (admin only)
router.delete("/:id", checkPermission('accounts', 'delete'), deletePayment);

// Respond to payment (Approve/Reject) - requires edit permission
router.put("/:id/respond", checkPermission('accounts', 'edit'), respondToPayment);

export default router;

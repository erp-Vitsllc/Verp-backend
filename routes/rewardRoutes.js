import express from "express";
import { addReward } from "../controllers/reward/addReward.js";
import { getRewards } from "../controllers/reward/getRewards.js";
import { getRewardById } from "../controllers/reward/getRewardById.js";
import { updateReward } from "../controllers/reward/updateReward.js";
import { updateRewardPartyPayable } from "../controllers/reward/updateRewardPartyPayable.js";
import { deleteReward } from "../controllers/reward/deleteReward.js";
import { getPendingRewardDashboardInbox } from "../controllers/reward/getPendingRewardDashboardInbox.js";
import { protect } from "../middleware/authMiddleware.js";
import {
    checkPermission,
    checkRewardMutatePermission,
    checkRewardViewPermission,
} from "../middleware/permissionMiddleware.js";

const router = express.Router();

// All reward routes require authentication
router.use(protect);

// Must be registered before /:id
router.get("/dashboard/pending-inbox", getPendingRewardDashboardInbox);

// List / detail — Reward View (or Create Reward child)
router.get("/", checkRewardViewPermission(), getRewards);
router.get("/:id", checkRewardViewPermission(), getRewardById);

/** Accounts party fields — View (same pattern as Loan party-payable) */
router.put(
    "/:id/party-payable",
    checkRewardViewPermission(),
    updateRewardPartyPayable,
);

/** Approve / reject / submit — View (workflow assignee gate is inside updateReward) */
router.put("/:id/status", checkRewardViewPermission(), updateReward);
router.patch("/:id/status", checkRewardViewPermission(), updateReward);

// Create / content update / delete — Create Reward child (parent is View-only)
router.post("/", checkRewardMutatePermission(), addReward);
router.patch("/:id", checkRewardMutatePermission(), updateReward);
router.put("/:id", checkRewardMutatePermission(), updateReward);
router.delete("/:id", checkRewardMutatePermission(), deleteReward);

export default router;

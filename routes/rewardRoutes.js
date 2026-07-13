import express from "express";
import { addReward } from "../controllers/reward/addReward.js";
import { getRewards } from "../controllers/reward/getRewards.js";
import { getRewardById } from "../controllers/reward/getRewardById.js";
import { updateReward } from "../controllers/reward/updateReward.js";
import { deleteReward } from "../controllers/reward/deleteReward.js";
import { getPendingRewardDashboardInbox } from "../controllers/reward/getPendingRewardDashboardInbox.js";
import { protect } from "../middleware/authMiddleware.js";
import {
    checkPermission,
    checkRewardMutatePermission,
} from "../middleware/permissionMiddleware.js";

const router = express.Router();

// All reward routes require authentication
router.use(protect);

// Must be registered before /:id
router.get("/dashboard/pending-inbox", getPendingRewardDashboardInbox);

// List / detail — parent Reward View
router.get("/", checkPermission("hrm_reward", "view"), getRewards);
router.get("/:id", checkPermission("hrm_reward", "view"), getRewardById);

// Create / update / delete — Create Reward child (parent is View-only in the chart)
router.post("/", checkRewardMutatePermission(), addReward);
router.patch("/:id", checkRewardMutatePermission(), updateReward);
router.put("/:id", checkRewardMutatePermission(), updateReward);
router.delete("/:id", checkRewardMutatePermission(), deleteReward);

export default router;

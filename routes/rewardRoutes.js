import express from "express";
import { addReward } from "../controllers/reward/addReward.js";
import { getRewards } from "../controllers/reward/getRewards.js";
import { getRewardById } from "../controllers/reward/getRewardById.js";
import { updateReward } from "../controllers/reward/updateReward.js";
import { deleteReward } from "../controllers/reward/deleteReward.js";
import { protect } from "../middleware/authMiddleware.js";
import { checkPermission } from "../middleware/permissionMiddleware.js";

const router = express.Router();

// All reward routes require authentication
router.use(protect);

// Get all rewards - requires view permission
router.get("/", checkPermission('hrm_reward', 'view'), getRewards);

// Get reward by ID - requires view permission
router.get("/:id", checkPermission('hrm_reward', 'view'), getRewardById);

// Add reward - requires create permission
router.post("/", checkPermission('hrm_reward', 'create'), addReward);

// Update reward - requires edit permission
router.patch("/:id", checkPermission('hrm_reward', 'edit'), updateReward);
router.put("/:id", checkPermission('hrm_reward', 'edit'), updateReward);

// Delete reward - requires delete permission
router.delete("/:id", checkPermission('hrm_reward', 'delete'), deleteReward);

export default router;














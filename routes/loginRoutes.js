import express from "express";
import { login, completePasswordReset } from "../controllers/loginController.js";

import { sensitiveActionLimiter } from "../middleware/rateLimitMiddleware.js";

const router = express.Router();

// router.post("", sensitiveActionLimiter, login);
router.post("", login);
router.post("/complete-password-reset", sensitiveActionLimiter, completePasswordReset);

export default router;




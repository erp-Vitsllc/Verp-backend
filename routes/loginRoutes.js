import express from "express";
import { login, completePasswordReset } from "../controllers/loginController.js";
import { mobileLogin, refreshMobileToken, mobileLogout, reportMobileDevice } from "../controllers/mobileAuthController.js";
import { sensitiveActionLimiter } from "../middleware/rateLimitMiddleware.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("", login);
router.post("/mobile", sensitiveActionLimiter, mobileLogin);
router.post("/mobile/refresh", refreshMobileToken);
router.post("/mobile/logout", mobileLogout);
router.post("/mobile/device", protect, reportMobileDevice);
router.post("/complete-password-reset", sensitiveActionLimiter, completePasswordReset);

export default router;




import express from "express";
import { login, verifyWebOtp, resendWebOtp, completePasswordReset } from "../controllers/loginController.js";
import { mobileLogin, verifyMobileOtp, resendMobileOtp, refreshMobileToken, mobileLogout, reportMobileDevice } from "../controllers/mobileAuthController.js";
import { sensitiveActionLimiter } from "../middleware/rateLimitMiddleware.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.post("", login);
router.post("/otp", sensitiveActionLimiter, verifyWebOtp);
router.post("/otp/resend", sensitiveActionLimiter, resendWebOtp);
router.post("/mobile", sensitiveActionLimiter, mobileLogin);
router.post("/mobile/otp", sensitiveActionLimiter, verifyMobileOtp);
router.post("/mobile/otp/resend", sensitiveActionLimiter, resendMobileOtp);
router.post("/mobile/refresh", refreshMobileToken);
router.post("/mobile/logout", mobileLogout);
router.post("/mobile/device", protect, reportMobileDevice);
router.post("/complete-password-reset", sensitiveActionLimiter, completePasswordReset);

export default router;




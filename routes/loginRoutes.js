import express from "express";
import { login } from "../controllers/loginController.js";

import { sensitiveActionLimiter } from "../middleware/rateLimitMiddleware.js";

const router = express.Router();

router.post("", sensitiveActionLimiter, login);

export default router;




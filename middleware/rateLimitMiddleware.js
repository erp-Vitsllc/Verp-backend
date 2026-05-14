import rateLimit from 'express-rate-limit';

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS);
const maxRequests = Number(process.env.RATE_LIMIT_MAX);

const commonWindowMs =
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 15 * 60 * 1000;
const commonMax =
    Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 8000;

const rateLimitDisabled =
    process.env.RATE_LIMIT_DISABLED === '1' || process.env.RATE_LIMIT_DISABLED === 'true';

export const commonLimiter = rateLimit({
    windowMs: commonWindowMs,
    max: commonMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => rateLimitDisabled,
    message: {
        message: "Too many requests from this IP, please try again after 15 minutes",
    },
});

export const sensitiveActionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // Limit each IP to 20 requests per hour for sensitive actions
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        message: "Too many attempts from this IP, please try again after an hour"
    }
});

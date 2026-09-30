import rateLimit from 'express-rate-limit';

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS);
const maxRequests = Number(process.env.RATE_LIMIT_MAX);

const commonWindowMs =
    Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 15 * 60 * 1000;
const commonMax =
    Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 8000;

export const commonLimiter = rateLimit({
    windowMs: commonWindowMs,
    max: commonMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => true,
    message: {
        message: "Too many requests from this IP, please try again after 15 minutes",
    },
});

export const sensitiveActionLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    // Office and mobile networks share one public IP. Do not lock every user on that IP.
    skip: () => true,
    message: {
        message: "Too many attempts from this IP, please try again after an hour"
    }
});

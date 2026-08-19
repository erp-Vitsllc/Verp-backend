import express from "express";
import cors from "cors";
import compression from "compression";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
// import { connectDB } from "./config/db.js"; // <-- Import DB connection
import loginRoute from "./routes/loginRoutes.js"; // <-- Add routes
import employeeRoute from "./routes/employeeRoutes.js"; // <-- Add employee routes
import documentAIRoute from "./routes/documentAIRoutes.js";
import userRoute from "./routes/userRoutes.js";
import rewardRoute from "./routes/rewardRoutes.js";
import fineRoute from "./routes/fineRoutes.js";
import paymentRoute from "./routes/paymentRoutes.js";
import utilityBillRoute from "./routes/utilityBillRoutes.js";
import expenseRoute from "./routes/expenseRoutes.js";
import departmentRoute from "./routes/departmentRoutes.js";
import designationRoute from "./routes/designationRoutes.js";
import companyRoute from "./routes/companyRoutes.js";
import assetTypeRoute from "./routes/assetTypeRoutes.js";
import assetItemRoute from "./routes/assetItemRoutes.js"; // <-- Add asset item routes
import assetAccessoryCatalogRoute from "./routes/assetAccessoryCatalogRoutes.js";
import flowchartRoute from "./routes/flowchartRoutes.js";
import adminDeletionArchiveRoute from "./routes/adminDeletionArchiveRoutes.js"; // <-- Add flowchart routes
import activityLogRoute from "./routes/activityLogRoutes.js";
import storageRoute from "./routes/storageRoutes.js";
import zohoRoute from "./routes/zohoRoutes.js";
import locatorRoute from "./routes/locatorRoutes.js";
import vehicleFuelRoute from "./routes/vehicleFuelRoutes.js";
import attendanceRoute from "./routes/attendanceRoutes.js";
import leaveRoute from "./routes/leaveRoutes.js";
import holidayRoute from "./routes/holidayRoutes.js";
import workingTimeRoute from "./routes/workingTimeRoutes.js";
import { startLocatorWebSocket } from "./services/locatorWebSocketService.js";
import { syncLocatorToErpDatabase } from "./services/locatorSnapshotService.js";
import { commonLimiter } from "./middleware/rateLimitMiddleware.js";
import { activityAuditMiddleware } from "./middleware/activityAuditMiddleware.js";
import { resolveFrontendBaseUrl, runWithRequestFrontendBaseUrl } from "./utils/resolveFrontendBaseUrl.js";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import dns from "dns";
import { processParkingAssets } from "./utils/processParkingAssets.js";
import { processTemporaryAssignments } from "./utils/processTemporaryAssignments.js";
import { processAccidentAssets } from "./utils/processAccidentAssets.js";
import { processDocumentExpiryReminders } from "./utils/processDocumentExpiryReminders.js";
import { processUtilityBillPaymentDayReminders } from "./utils/processUtilityBillPaymentDayReminders.js";
import { processUtilityContractExpiryReminders } from "./utils/processUtilityContractExpiryReminders.js";
import { processVehicleServiceHoldReminders } from "./utils/processVehicleServiceHoldReminders.js";
import { processVehicleServiceScheduledPhase } from "./utils/processVehicleServiceScheduledPhase.js";
import { processOilServiceOverdue, processOilServiceStartDateActivation, processOilServiceDueAutoCreate, processOilServiceCompleteDueReminder } from "./utils/oilServiceWorkflow.js";
import { processShopServiceStartDateActivation } from "./utils/vehicleShopServiceScheduled.js";
import { processAssetServiceOverdue } from "./utils/processAssetServiceOverdue.js";
import { processFleetHandoverEscalation } from "./utils/processFleetHandoverEscalation.js";
import { processBirthdayWishes } from "./utils/processBirthdayWishes.js";
import { scheduleDailyAtMidnight, getScheduledEmailTimeZone } from "./utils/scheduleDailyAtMidnight.js";
import { setupEmailSubjectTag } from "./utils/setupEmailSubjectTag.js";
import { purgeExpiredAdminDeletionArchives } from "./services/adminDeletionArchiveService.js";
import { rerouteAllPendingAssetCreationApprovals } from "./utils/assetApprovalHelpers.js";
import { processAttendanceDailyRoutine } from "./utils/processAttendanceDailyRoutine.js";

// Always load VERP_backend/.env (not process.cwd()), so Zoho/Locator keys work
// whether the server is started from repo root or from VERP_backend.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });
setupEmailSubjectTag();

// Atlas SRV resolution on Windows can fail with system DNS; Google DNS is more reliable.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const app = express();
app.disable("x-powered-by");

/**
 * When the API sits behind nginx / a load balancer / Cloudflare, the TCP peer is the proxy.
 * Without `trust proxy`, `req.ip` is often the same for every user → one shared rate-limit bucket
 * (see `commonLimiter`) and legitimate traffic gets 429 quickly.
 * Set TRUST_PROXY=1 on the server (and TRUST_PROXY_HOPS if you have multiple proxy layers).
 */
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
    const hops = Number(process.env.TRUST_PROXY_HOPS);
    app.set('trust proxy', Number.isFinite(hops) && hops > 0 ? hops : 1);
}

// Run parking lifecycle checks (reminders + auto-unassign) periodically.
setTimeout(() => { processParkingAssets(); }, 30 * 1000);
setInterval(() => { processParkingAssets(); }, 6 * 60 * 60 * 1000);

setTimeout(() => { processTemporaryAssignments(); }, 45 * 1000);
// Run more frequently so "ends on date" feels accurate to users.
setInterval(() => { processTemporaryAssignments(); }, 60 * 60 * 1000);

setTimeout(() => {
    processFleetHandoverEscalation().catch((e) =>
        console.error('[processFleetHandoverEscalation] startup failed:', e?.message || e),
    );
}, 75 * 1000);
setInterval(() => {
    processFleetHandoverEscalation().catch((e) =>
        console.error('[processFleetHandoverEscalation] scheduled run failed:', e?.message || e),
    );
}, 6 * 60 * 60 * 1000);

setTimeout(() => { processAccidentAssets(); }, 60 * 1000);
scheduleDailyAtMidnight(
    () => processAccidentAssets(),
    { name: "AccidentAssets" },
);

// Date-based auto emails at 12:00 AM (Asia/Dubai by default).
// Startup catch-up still runs shortly after boot so overnight downtime does not skip the day;
// reminder logs keep sends idempotent (no duplicate emails).
const scheduledEmailTz = getScheduledEmailTimeZone();
console.log(`[ScheduledEmail] daily jobs armed for ${scheduledEmailTz} midnight`);

// Company / employee / vehicle document expiry (30/20/10/0 day emails + HR tasks).
setTimeout(() => { processDocumentExpiryReminders(); }, 90 * 1000);
scheduleDailyAtMidnight(
    () => processDocumentExpiryReminders(),
    { name: "DocumentExpiryReminders" },
);

// Utility bill payment-day reminders (current + previous month; bell when overdue, email on payment day).
setTimeout(() => {
    processUtilityBillPaymentDayReminders().catch((e) =>
        console.error("[UtilityBillPaymentDayReminders] startup failed:", e?.message || e),
    );
}, 110 * 1000);
scheduleDailyAtMidnight(
    () => processUtilityBillPaymentDayReminders(),
    { name: "UtilityBillPaymentDayReminders" },
);

// Utility contract end-date expiry (T-10 / T-5 / due-or-past → Accounts flowchart; sticky until done).
setTimeout(() => {
    processUtilityContractExpiryReminders().catch((e) =>
        console.error("[UtilityContractExpiryReminders] startup failed:", e?.message || e),
    );
}, 125 * 1000);
scheduleDailyAtMidnight(
    () => processUtilityContractExpiryReminders(),
    { name: "UtilityContractExpiryReminders" },
);

// Birthday wishes for active employees (personal email only).
setTimeout(() => {
    processBirthdayWishes().catch((e) =>
        console.error("[BirthdayWish] startup run failed:", e?.message || e),
    );
}, 100 * 1000);
scheduleDailyAtMidnight(
    () => processBirthdayWishes(),
    { name: "BirthdayWish" },
);

// Run vehicle service hold reminders (creates deferred task/email near hold date).
setTimeout(() => { processVehicleServiceHoldReminders(); }, 120 * 1000);
setInterval(() => { processVehicleServiceHoldReminders(); }, 6 * 60 * 60 * 1000);

// Scheduled vehicle service window: flip to "On Service" on the first day, email AC after window ends.
setTimeout(() => { processVehicleServiceScheduledPhase(); }, 150 * 1000);
setInterval(() => { processVehicleServiceScheduledPhase(); }, 2 * 60 * 60 * 1000);
setTimeout(() => { processOilServiceOverdue(); }, 180 * 1000);
setInterval(() => { processOilServiceOverdue(); }, 2 * 60 * 60 * 1000);
setTimeout(() => { processOilServiceCompleteDueReminder(); }, 185 * 1000);
setInterval(() => { processOilServiceCompleteDueReminder(); }, 2 * 60 * 60 * 1000);
setTimeout(() => { processOilServiceStartDateActivation(); }, 165 * 1000);
setInterval(() => { processOilServiceStartDateActivation(); }, 2 * 60 * 60 * 1000);
setTimeout(() => { processShopServiceStartDateActivation(); }, 170 * 1000);
setInterval(() => { processShopServiceStartDateActivation(); }, 2 * 60 * 60 * 1000);
setTimeout(() => { processOilServiceDueAutoCreate(); }, 195 * 1000);
setInterval(() => { processOilServiceDueAutoCreate(); }, 2 * 60 * 60 * 1000);

// Tools/equipment on service: expiry-day email, overdue tasks for bell + dashboard.
setTimeout(() => {
    processAssetServiceOverdue().catch((e) =>
        console.error('[processAssetServiceOverdue] startup failed:', e?.message || e),
    );
}, 210 * 1000);
setInterval(() => {
    processAssetServiceOverdue().catch((e) =>
        console.error('[processAssetServiceOverdue] scheduled run failed:', e?.message || e),
    );
}, 2 * 60 * 60 * 1000);

setTimeout(() => {
    purgeExpiredAdminDeletionArchives().catch((e) =>
        console.error('[AdminDeletionArchive] startup purge failed:', e?.message || e),
    );
}, 180 * 1000);
scheduleDailyAtMidnight(
    () => purgeExpiredAdminDeletionArchives(),
    { name: "AdminDeletionArchive" },
);

// Attendance daily routine: close previous day (marks stay in DB), open new day empty for marking.
setTimeout(() => {
    processAttendanceDailyRoutine().catch((e) =>
        console.error("[AttendanceDailyRoutine] startup failed:", e?.message || e),
    );
}, 140 * 1000);
scheduleDailyAtMidnight(
    () => processAttendanceDailyRoutine(),
    { name: "AttendanceDailyRoutine" },
);

setTimeout(() => {
    rerouteAllPendingAssetCreationApprovals()
        .then((counts) => {
            console.log(
                `[AssetApproval] startup re-route: fleet=${counts.fleetUpdated} tools=${counts.toolsUpdated}`
            );
        })
        .catch((e) =>
            console.error('[AssetApproval] startup re-route failed:', e?.message || e),
        );
}, 20 * 1000);

// CORS Configuration - MUST BE FIRST
const staticAllowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    process.env.FRONTEND_URL,
].filter(Boolean);

const isLocalDevOrigin = (origin) => {
    if (!origin || typeof origin !== "string") return false;
    try {
        const { hostname, protocol } = new URL(origin);
        if (protocol !== "http:" && protocol !== "https:") return false;
        if (hostname === "localhost" || hostname === "127.0.0.1") return true;
        // LAN / private network (frontend on 0.0.0.0 — open via machine IP, e.g. 192.168.x.x:3000)
        if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
        if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
        if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
        return false;
    } catch {
        return false;
    }
};

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) {
                return callback(null, true);
            }
            if (staticAllowedOrigins.includes(origin) || isLocalDevOrigin(origin)) {
                return callback(null, true);
            }
            console.warn("CORS blocked origin:", origin);
            return callback(null, false);
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-no-compression"],
    })
);

// Global Rate Limiting
app.use(commonLimiter);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use((req, _res, next) => {
    const base = resolveFrontendBaseUrl(req);
    req.frontendBaseUrl = base;
    runWithRequestFrontendBaseUrl(base, next);
});

// Reject API traffic until MongoDB is connected (avoids hung requests during startup/reconnect).
app.use((req, res, next) => {
    if (mongoose.connection.readyState === 1) {
        return next();
    }
    return res.status(503).json({
        message: "Database not ready. Wait a moment and retry.",
    });
});

// Request timeout middleware - catch hanging requests
// Zoho purchase syncs (expenses/bills/payments/vendors) can exceed 60s on first load.
app.use((req, res, next) => {
    const path = String(req.originalUrl || req.url || '');
    const isZohoSyncRoute = /^\/api\/zoho\/(expenses|bills|vendorpayments|vendors|customers|sync)/i.test(
        path.split('?')[0],
    );
    const timeoutMs = isZohoSyncRoute ? 300000 : 60000;

    req.setTimeout(timeoutMs, () => {
        if (!res.headersSent) {
            res.status(504).json({ message: 'Request timeout' });
        }
    });
    next();
});

// Test API Endpoint
app.get("/", (req, res) => {
    res.send("Backend running successfully!");
});

app.get("/api/health", (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res.status(dbReady ? 200 : 503).json({
        ok: dbReady,
        database: dbReady ? "connected" : "disconnected",
    });
});

// Log successful mutating API calls (create / update / delete / approve) across the ERP.
app.use(activityAuditMiddleware);

// Routes
app.use("/api/Login", loginRoute);
app.use("/api/Employee", employeeRoute);
app.use("/api/document-ai", documentAIRoute);
app.use("/api/User", userRoute);
app.use("/api/Reward", rewardRoute);
app.use("/api/Fine", fineRoute);
app.use("/api/Payment", paymentRoute);
app.use("/api/UtilityBill", utilityBillRoute);
app.use("/api/Expense", expenseRoute);
app.use("/api/Department", departmentRoute);
app.use("/api/Designation", designationRoute);
app.use("/api/Company", companyRoute);
app.use("/api/company", companyRoute);
app.use("/api/AssetType", assetTypeRoute);
app.use("/api/AssetItem", assetItemRoute);
app.use("/api/AssetAccessoryCatalog", assetAccessoryCatalogRoute);
app.use("/api/Flowchart", flowchartRoute);
app.use("/api/AdminDeletionArchive", adminDeletionArchiveRoute);
app.use("/api/ActivityLog", activityLogRoute);
app.use("/api/storage", storageRoute);
app.use("/api/zoho", zohoRoute);
app.use("/api/locator", locatorRoute);
app.use("/api/VehicleFuel", vehicleFuelRoute);
app.use("/api/Attendance", attendanceRoute);
app.use("/api/Leave", leaveRoute);
app.use("/api/Holiday", holidayRoute);
app.use("/api/WorkingTime", workingTimeRoute);

const PORT = process.env.PORT || 5000;

async function startServer() {
    if (!process.env.MONGO_URI) {
        console.error("❌ MONGO_URI is missing. Add it to VERP_backend/.env");
        process.exit(1);
    }

    console.log("Connecting to MongoDB…");
    await connectDB();

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log(`Health check: http://localhost:${PORT}/api/health`);
        startLocatorWebSocket();
        // Locator → ERP Mongo sync every 30 minutes (snapshots + AssetItem GPS cache).
        // Vehicle list/details must NOT call live Locator — they read ERP DB only.
        const LOCATOR_ERP_SYNC_MS = 30 * 60 * 1000;
        setTimeout(() => {
            syncLocatorToErpDatabase().catch((e) =>
                console.error('[LocatorSync] startup sync failed:', e?.message || e),
            );
        }, 45 * 1000);
        setInterval(() => {
            syncLocatorToErpDatabase().catch((e) =>
                console.error('[LocatorSync] scheduled sync failed:', e?.message || e),
            );
        }, LOCATOR_ERP_SYNC_MS);
    });
}

startServer().catch((err) => {
    console.error("❌ Failed to start server:", err?.message || err);
    process.exit(1);
});

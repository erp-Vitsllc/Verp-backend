import express from "express";
import cors from "cors";
import compression from "compression";
// import { connectDB } from "./config/db.js"; // <-- Import DB connection
import loginRoute from "./routes/loginRoutes.js"; // <-- Add routes
import employeeRoute from "./routes/employeeRoutes.js"; // <-- Add employee routes
import documentAIRoute from "./routes/documentAIRoutes.js";
import userRoute from "./routes/userRoutes.js";
import rewardRoute from "./routes/rewardRoutes.js";
import fineRoute from "./routes/fineRoutes.js";
import paymentRoute from "./routes/paymentRoutes.js";
import departmentRoute from "./routes/departmentRoutes.js";
import designationRoute from "./routes/designationRoutes.js";
import companyRoute from "./routes/companyRoutes.js";
import assetTypeRoute from "./routes/assetTypeRoutes.js";
import assetItemRoute from "./routes/assetItemRoutes.js"; // <-- Add asset item routes
import assetAccessoryCatalogRoute from "./routes/assetAccessoryCatalogRoutes.js";
import flowchartRoute from "./routes/flowchartRoutes.js"; // <-- Add flowchart routes
import { commonLimiter } from "./middleware/rateLimitMiddleware.js";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js";
import dns from "dns";
import { processParkingAssets } from "./utils/processParkingAssets.js";
import { processTemporaryAssignments } from "./utils/processTemporaryAssignments.js";
import { processAccidentAssets } from "./utils/processAccidentAssets.js";
import { processDocumentExpiryReminders } from "./utils/processDocumentExpiryReminders.js";
import { processVehicleServiceHoldReminders } from "./utils/processVehicleServiceHoldReminders.js";
import { processVehicleServiceScheduledPhase } from "./utils/processVehicleServiceScheduledPhase.js";
import { setupEmailSubjectTag } from "./utils/setupEmailSubjectTag.js";

dotenv.config();
setupEmailSubjectTag();

// Set DNS before DB connection
dns.setServers(["8.8.8.8"]);

// connectDB(); // Now Atlas hostname will resolve correctly

dotenv.config();
connectDB(); // <-- Call DB connection
console.log("MONGO_URI:", process.env.MONGO_URI);

const app = express();
app.disable("x-powered-by");

// Run parking lifecycle checks (reminders + auto-unassign) periodically.
setTimeout(() => { processParkingAssets(); }, 30 * 1000);
setInterval(() => { processParkingAssets(); }, 6 * 60 * 60 * 1000);

setTimeout(() => { processTemporaryAssignments(); }, 45 * 1000);
// Run more frequently so "ends on date" feels accurate to users.
setInterval(() => { processTemporaryAssignments(); }, 60 * 60 * 1000);

setTimeout(() => { processAccidentAssets(); }, 60 * 1000);
setInterval(() => { processAccidentAssets(); }, 24 * 60 * 60 * 1000);

// Run company/employee document expiry reminders (30/20/10 day notifications).
setTimeout(() => { processDocumentExpiryReminders(); }, 90 * 1000);
setInterval(() => { processDocumentExpiryReminders(); }, 24 * 60 * 60 * 1000);

// Run vehicle service hold reminders (creates deferred task/email near hold date).
setTimeout(() => { processVehicleServiceHoldReminders(); }, 120 * 1000);
setInterval(() => { processVehicleServiceHoldReminders(); }, 6 * 60 * 60 * 1000);

// Scheduled vehicle service window: flip to "On Service" on the first day, email AC after window ends.
setTimeout(() => { processVehicleServiceScheduledPhase(); }, 150 * 1000);
setInterval(() => { processVehicleServiceScheduledPhase(); }, 2 * 60 * 60 * 1000);

// CORS Configuration - MUST BE FIRST
const staticAllowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5173",
    process.env.FRONTEND_URL,
].filter(Boolean);

const isLocalDevOrigin = (origin) =>
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

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

// Request timeout middleware - catch hanging requests
app.use((req, res, next) => {
    req.setTimeout(60000, () => {
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

// Routes
app.use("/api/Login", loginRoute);
app.use("/api/Employee", employeeRoute);
app.use("/api/document-ai", documentAIRoute);
app.use("/api/User", userRoute);
app.use("/api/Reward", rewardRoute);
app.use("/api/Fine", fineRoute);
app.use("/api/Payment", paymentRoute);
app.use("/api/Department", departmentRoute);
app.use("/api/Designation", designationRoute);
app.use("/api/Company", companyRoute);
app.use("/api/AssetType", assetTypeRoute);
app.use("/api/AssetItem", assetItemRoute);
app.use("/api/AssetAccessoryCatalog", assetAccessoryCatalogRoute);
app.use("/api/Flowchart", flowchartRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

import express from "express";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import { connectDB } from "./config/db.js"; // <-- Import DB connection
import loginRoute from "./routes/loginRoutes.js"; // <-- Add routes
import employeeRoute from "./routes/employeeRoutes.js"; // <-- Add employee routes
import documentAIRoute from "./routes/documentAIRoutes.js";
import userRoute from "./routes/userRoutes.js";
import rewardRoute from "./routes/rewardRoutes.js";
import fineRoute from "./routes/fineRoutes.js";
import departmentRoute from "./routes/departmentRoutes.js";
import designationRoute from "./routes/designationRoutes.js";
import companyRoute from "./routes/companyRoutes.js";
import assetTypeRoute from "./routes/assetTypeRoutes.js";
import { commonLimiter } from "./middleware/rateLimitMiddleware.js";

dotenv.config();
connectDB(); // <-- Call DB connection

const app = express();
app.disable("x-powered-by");

// CORS Configuration - MUST BE FIRST
app.use(cors({
    origin: [
        "http://localhost:3000",
        "http://localhost:5173",
        process.env.FRONTEND_URL
    ].filter(Boolean), // Allow frontend origins and filter out undefined
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-no-compression"]
}));

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
app.use("/api/Department", departmentRoute);
app.use("/api/Designation", designationRoute);
app.use("/api/Company", companyRoute);
app.use("/api/AssetType", assetTypeRoute);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

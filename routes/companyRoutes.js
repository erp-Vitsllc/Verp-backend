import express from "express";
import { getCompanies } from "../controllers/company/getCompanies.js";
import { addCompany } from "../controllers/company/addCompany.js";
import { getNextCompanyId } from "../controllers/company/getNextCompanyId.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.use(protect);

router.get("/", getCompanies);
router.get("/next-id", getNextCompanyId);
router.post("/", addCompany);

export default router;

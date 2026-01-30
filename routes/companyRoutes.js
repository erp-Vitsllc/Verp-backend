import express from "express";
import { getCompanies } from "../controllers/company/getCompanies.js";
import { getCompany } from "../controllers/company/getCompany.js";
import { addCompany } from "../controllers/company/addCompany.js";
import { getNextCompanyId } from "../controllers/company/getNextCompanyId.js";
import { protect } from "../middleware/authMiddleware.js";

import { updateCompany } from "../controllers/company/updateCompany.js";
import { uploadCompanyDocument } from "../controllers/company/uploadCompanyDocument.js";
import { deleteCompany } from "../controllers/company/deleteCompany.js";

const router = express.Router();

router.use(protect);

router.get("/", getCompanies);
router.get("/next-id", getNextCompanyId);
router.get("/:id", getCompany);
router.post("/", addCompany);
router.patch("/:id", updateCompany);
router.post("/:id/upload", uploadCompanyDocument);
router.delete("/:id", deleteCompany);

export default router;

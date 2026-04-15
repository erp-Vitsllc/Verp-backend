import express from "express";
import { getCompanies } from "../controllers/company/getCompanies.js";
import { getCompany } from "../controllers/company/getCompany.js";
import { addCompany } from "../controllers/company/addCompany.js";
import { getNextCompanyId } from "../controllers/company/getNextCompanyId.js";
import { protect } from "../middleware/authMiddleware.js";

import { updateCompany } from "../controllers/company/updateCompany.js";
import { uploadCompanyDocument } from "../controllers/company/uploadCompanyDocument.js";
import { deleteCompany } from "../controllers/company/deleteCompany.js";
import { respondToResponsibility } from "../controllers/company/respondToResponsibility.js";
import { getAllOwners } from "../controllers/company/getAllOwners.js";
import {
    submitCompanyActivationRequest,
    approveCompanyActivationRequest,
    rejectCompanyActivationRequest,
} from "../controllers/company/activationController.js";

const router = express.Router();

router.use(protect);

router.get("/", getCompanies);
router.get("/next-id", getNextCompanyId);
router.get("/all-owners", getAllOwners);
router.get("/:id", getCompany);
router.post("/", addCompany);
router.patch("/:id", updateCompany);
router.post("/:id/submit-activation", submitCompanyActivationRequest);
router.post("/:id/approve-activation", approveCompanyActivationRequest);
router.post("/:id/reject-activation", rejectCompanyActivationRequest);
router.put("/:id/respond-responsibility", respondToResponsibility);
router.post("/:id/upload", uploadCompanyDocument);
router.delete("/:id", deleteCompany);

export default router;

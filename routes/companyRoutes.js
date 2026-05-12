import express from "express";
import { getCompanies } from "../controllers/company/getCompanies.js";
import { getCompany } from "../controllers/company/getCompany.js";
import { addCompany } from "../controllers/company/addCompany.js";
import { getNextCompanyId } from "../controllers/company/getNextCompanyId.js";
import { protect } from "../middleware/authMiddleware.js";

import { updateCompany } from "../controllers/company/updateCompany.js";
import {
    submitCompanyNotRenewRequest,
    respondCompanyNotRenewRequest,
} from "../controllers/company/companyNotRenewController.js";
import { uploadCompanyDocument } from "../controllers/company/uploadCompanyDocument.js";
import { deleteCompany } from "../controllers/company/deleteCompany.js";
import { deleteDocument } from "../controllers/company/deleteDocument.js";
import { clearCompanyCard } from "../controllers/company/clearCompanyCard.js";
import { deleteOldDocument } from "../controllers/company/deleteOldDocument.js";
import { deleteOldOwner } from "../controllers/company/deleteOldOwner.js";
import { respondToResponsibility } from "../controllers/company/respondToResponsibility.js";
import { getAllOwners } from "../controllers/company/getAllOwners.js";
import {
    submitCompanyActivationRequest,
    approveCompanyActivationRequest,
    holdCompanyActivationRequest,
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
router.post("/:id/not-renew-requests", submitCompanyNotRenewRequest);
router.post("/:id/not-renew-requests/:requestId/respond", respondCompanyNotRenewRequest);
router.post("/:id/submit-activation", submitCompanyActivationRequest);
router.post("/:id/approve-activation", approveCompanyActivationRequest);
router.post("/:id/hold-activation", holdCompanyActivationRequest);
router.post("/:id/reject-activation", rejectCompanyActivationRequest);
router.put("/:id/respond-responsibility", respondToResponsibility);
router.post("/:id/upload", uploadCompanyDocument);
router.delete("/:id/document/:target", deleteDocument);
router.delete("/:id/card/:card", clearCompanyCard);
router.delete("/:id/old-document/:target", deleteOldDocument);
router.delete("/:id/old-owner/:target", deleteOldOwner);
router.delete("/:id", deleteCompany);

export default router;

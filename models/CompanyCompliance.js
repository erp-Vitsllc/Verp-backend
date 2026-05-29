import mongoose from "mongoose";
import { companyComplianceSchema } from "./company/companySchemas.js";

companyComplianceSchema.index({ company: 1 }, { unique: true });

export default mongoose.model("CompanyCompliance", companyComplianceSchema);

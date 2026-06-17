import mongoose from "mongoose";
import { companyComplianceSchema } from "./company/companySchemas.js";

export default mongoose.model("CompanyCompliance", companyComplianceSchema);

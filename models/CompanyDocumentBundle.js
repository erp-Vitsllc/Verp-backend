import mongoose from "mongoose";
import { companyDocumentBundleSchema } from "./company/companySchemas.js";

companyDocumentBundleSchema.index({ company: 1 }, { unique: true });

export default mongoose.model("CompanyDocumentBundle", companyDocumentBundleSchema);

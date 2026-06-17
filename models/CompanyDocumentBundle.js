import mongoose from "mongoose";
import { companyDocumentBundleSchema } from "./company/companySchemas.js";

export default mongoose.model("CompanyDocumentBundle", companyDocumentBundleSchema);

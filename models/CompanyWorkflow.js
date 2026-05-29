import mongoose from "mongoose";
import { companyWorkflowSchema } from "./company/companySchemas.js";

companyWorkflowSchema.index({ company: 1 }, { unique: true });

export default mongoose.model("CompanyWorkflow", companyWorkflowSchema);

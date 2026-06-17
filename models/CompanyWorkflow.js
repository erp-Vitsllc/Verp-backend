import mongoose from "mongoose";
import { companyWorkflowSchema } from "./company/companySchemas.js";

export default mongoose.model("CompanyWorkflow", companyWorkflowSchema);

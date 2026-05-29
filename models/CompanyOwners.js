import mongoose from "mongoose";
import { companyOwnersSchema } from "./company/companySchemas.js";

companyOwnersSchema.index({ company: 1 }, { unique: true });

export default mongoose.model("CompanyOwners", companyOwnersSchema);

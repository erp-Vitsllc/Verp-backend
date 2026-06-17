import mongoose from "mongoose";
import { companyOwnersSchema } from "./company/companySchemas.js";

export default mongoose.model("CompanyOwners", companyOwnersSchema);

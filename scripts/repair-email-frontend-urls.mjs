import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
    "utils/sendResponsibilityApprovalEmail.js",
    "utils/sendPaymentApprovalEmail.js",
    "utils/sendParkingReassignAcceptedEmail.js",
    "utils/sendFlowchartReassignmentResultEmail.js",
    "utils/sendAssetServiceEmail.js",
    "utils/sendAssetResponseEmail.js",
    "utils/sendAssetReassignmentEmail.js",
    "utils/sendAssetCreationDecisionEmail.js",
    "utils/sendAssetCreationApprovalEmail.js",
    "utils/notifyPreviousAssigneeReassignmentAcceptedWithHandover.js",
    "controllers/vehicleProfileActivationController.js",
    "controllers/vehicleDispositionWorkflowController.js",
    "controllers/assetItemController.js",
];

for (const rel of files) {
    const abs = path.join(root, rel);
    let c = fs.readFileSync(abs, "utf8");
    c = c.replace(/emailFrontendUrl\(\/g,\s*["']\)/g, "emailFrontendUrl()");
    if (rel.startsWith("controllers/")) {
        c = c.replace(
            /from ['"]\.\/resolveFrontendBaseUrl\.js['"]/g,
            "from '../utils/resolveFrontendBaseUrl.js'",
        );
        if (rel.includes("/")) {
            const depth = rel.split("/").length - 2;
            const prefix = "../".repeat(depth);
            c = c.replace(
                /from ['"]\.\/resolveFrontendBaseUrl\.js['"]/g,
                `from '${prefix}utils/resolveFrontendBaseUrl.js'`,
            );
        }
    }
    fs.writeFileSync(abs, c);
    console.log("fixed", rel);
}

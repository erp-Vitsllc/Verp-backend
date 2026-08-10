import { sendFineConfirmedEmail } from './sendFineConfirmedEmail.js';
import {
    isAssetLossFineReportApplicable,
    sendAssetLossFineReportEmail,
} from './sendAssetLossFineReportEmail.js';

/**
 * Routes fine-approved notifications to the correct email + PDF pipeline.
 * Loss & Damage asset fines use the Asset Loss Fine Report PDF module.
 * Garage Vehicle Damage fines (auto-approved after Zoho bill) use the confirmed email.
 */
export async function dispatchFineApprovedNotification(
    fine,
    assignedEmployees,
    req = null,
    options = {},
) {
    if (isAssetLossFineReportApplicable(fine)) {
        await sendAssetLossFineReportEmail(fine, assignedEmployees, req, options);
        return;
    }
    await sendFineConfirmedEmail(fine, assignedEmployees, req, options);
}

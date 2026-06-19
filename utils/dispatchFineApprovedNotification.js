import { sendFineConfirmedEmail } from './sendFineConfirmedEmail.js';
import {
    isAssetLossFineReportApplicable,
    sendAssetLossFineReportEmail,
} from './sendAssetLossFineReportEmail.js';

/**
 * Routes fine-approved notifications to the correct email + PDF pipeline.
 * Loss & Damage asset fines use the new Asset Loss Fine Report PDF module.
 */
export async function dispatchFineApprovedNotification(fine, assignedEmployees, req = null) {
    if (isAssetLossFineReportApplicable(fine)) {
        await sendAssetLossFineReportEmail(fine, assignedEmployees, req);
        return;
    }
    await sendFineConfirmedEmail(fine, assignedEmployees, req);
}

/** Print route sets this when HandoverFormView is mounted (see asset-handover print page). */
export const ASSET_HANDOVER_PDF_SELECTOR = '#asset-handover-container[data-handover-ready="true"]';

/** Bulk inventory list for emails (see print/asset-bulk-inventory). */
export const BULK_ASSET_INVENTORY_PDF_SELECTOR = '#bulk-asset-inventory-pdf[data-inventory-ready="true"]';

/** Server-built handover summary for emails (see generateAssetHandoverEmailPdf). */
export const ASSET_HANDOVER_EMAIL_PDF_SELECTOR = '#asset-handover-email-pdf[data-handover-ready="true"]';

/** Asset Controller flowchart responsibility — unassigned + parking sections (see generateBulkAssetInventoryPdf.js). */
export const ASSET_CONTROLLER_RESPONSIBILITY_PDF_SELECTOR = '#asset-controller-handover-pdf[data-inventory-ready="true"]';

/** Asset Controller approve outcome — items kept open vs returned to previous controller (see generateBulkAssetInventoryPdf.js). */
export const ASSET_CONTROLLER_OUTCOME_PDF_SELECTOR = '#asset-controller-outcome-pdf[data-inventory-ready="true"]';

/** Assignee summary after bulk AC decision — processed vs not processed (see generateBulkAssetInventoryPdf.js). */
export const BULK_ASSIGNEE_DISPOSITION_PDF_SELECTOR = '#bulk-assignee-disposition-pdf[data-inventory-ready="true"]';

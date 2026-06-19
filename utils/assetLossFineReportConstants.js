import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Puppeteer waits for this root before printing the Asset Loss Fine Report PDF. */
export const ASSET_LOSS_FINE_REPORT_PDF_SELECTOR =
    '#asset-loss-fine-report-pdf[data-asset-loss-fine-report-ready="true"]';

/** Dynamic field values render in black on the printed form. */
export const ASSET_LOSS_FINE_REPORT_VALUE_COLOR = '#000000';

/** Official blank PDF template — place/replace at this path. */
export const ASSET_LOSS_FINE_REPORT_TEMPLATE_PATH = 'assets/templates/AssetLossFineReport-template.pdf';

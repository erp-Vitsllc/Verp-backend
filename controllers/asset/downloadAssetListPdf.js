import { getCompleteEmployee } from '../../services/employeeService.js';
import { formatAssetListDate } from '../../utils/buildEmployeeAssetListPdfHtml.js';
import { generateEmployeeAssetListFromTemplatePdf } from '../../utils/generateEmployeeAssetListFromTemplatePdf.js';
import {
    loadAssetsByIds,
    parseAssetIdsFromQuery,
} from '../employee/downloadEmployeeAssetListPdf.js';

/**
 * Download asset list PDF for Asset Management filtered lists.
 * Accepts explicit asset IDs so the PDF matches the list currently shown in the UI.
 */
export const downloadAssetListPdf = async (req, res) => {
    try {
        const requestedAssetIds = parseAssetIdsFromQuery(req.query);
        if (!requestedAssetIds.length) {
            return res.status(400).json({ message: 'At least one asset ID is required' });
        }

        const assets = await loadAssetsByIds(requestedAssetIds);
        if (!assets.length) {
            return res.status(404).json({ message: 'No matching assets found for this list' });
        }

        const employeeId = String(req.query?.employeeId || '').trim();
        const listTitle = String(req.query?.listTitle || req.query?.scope || 'Asset List').trim() || 'Asset List';
        const groupByOwner =
            String(req.query?.groupByOwner || '')
                .trim()
                .toLowerCase() === 'true';
        let pdfBuffer;

        if (groupByOwner) {
            pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({
                employee: null,
                assets,
                groupByOwner: true,
                listTitle,
            });
        } else if (employeeId) {
            const employee = await getCompleteEmployee(employeeId);
            if (employee) {
                pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({ employee, assets });
            } else {
                pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({
                    employee: null,
                    assets,
                    headerOverride: {
                        employeeName: listTitle,
                        hodName: '—',
                        date: formatAssetListDate(new Date()),
                    },
                });
            }
        } else {
            pdfBuffer = await generateEmployeeAssetListFromTemplatePdf({
                employee: null,
                assets,
                headerOverride: {
                    employeeName: listTitle,
                    hodName: '—',
                    date: formatAssetListDate(new Date()),
                },
            });
        }

        if (!pdfBuffer || pdfBuffer.length < 500) {
            return res.status(500).json({ message: 'Failed to generate asset list PDF' });
        }

        const scopeSuffix = String(req.query?.scope || '')
            .trim()
            .replace(/[^\w.-]+/g, '');
        const fileLabel = scopeSuffix ? `AssetList-${scopeSuffix}` : 'AssetList';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
    } catch (error) {
        console.error('[downloadAssetListPdf]', error);
        res.status(500).json({ message: 'Failed to generate asset list PDF', error: error.message });
    }
};

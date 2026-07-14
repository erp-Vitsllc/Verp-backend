import { getCompleteEmployee } from '../../services/employeeService.js';
import { generateAssetListExcel } from '../../utils/generateAssetListExcel.js';
import { parseAssetListExportColumns } from '../../utils/assetListExportColumns.js';
import {
    loadAssetsByIds,
    parseAssetIdsFromQuery,
} from '../employee/downloadEmployeeAssetListPdf.js';

/**
 * Download asset list as Excel (SpreadsheetML .xls) for Asset Management filtered lists.
 */
export const downloadAssetListExcel = async (req, res) => {
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
        const columns = parseAssetListExportColumns(req.query?.columns);

        let employee = null;
        if (employeeId) {
            employee = await getCompleteEmployee(employeeId);
        }

        const excelBuffer = generateAssetListExcel({
            assets,
            columns,
            listTitle,
            employee,
        });

        if (!excelBuffer || excelBuffer.length < 50) {
            return res.status(500).json({ message: 'Failed to generate asset list Excel' });
        }

        const scopeSuffix = String(req.query?.scope || '')
            .trim()
            .replace(/[^\w.-]+/g, '');
        const fileLabel = scopeSuffix ? `AssetList-${scopeSuffix}` : 'AssetList';
        res.setHeader('Content-Type', 'application/vnd.ms-excel');
        res.setHeader('Content-Disposition', `attachment; filename="${fileLabel}.xls"`);
        res.setHeader('Content-Length', excelBuffer.length);
        res.send(excelBuffer);
    } catch (error) {
        console.error('[downloadAssetListExcel]', error);
        res.status(500).json({ message: 'Failed to generate asset list Excel', error: error.message });
    }
};

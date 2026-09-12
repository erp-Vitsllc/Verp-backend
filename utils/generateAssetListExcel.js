import {
    formatAccessoriesCell,
    resolveAssetListExportColumns,
} from './assetListExportColumns.js';
import { buildAssetListPdfRows } from './generateEmployeeAssetListFromTemplatePdf.js';

const NEW_BADGE = '(new)';

function xmlEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function cellXml(value, type = 'String', styleId = '') {
    const styleAttr = styleId ? ` ss:StyleID="${styleId}"` : '';
    if (type === 'Number') {
        const n = Number(value);
        const safe = Number.isFinite(n) ? n : 0;
        return `<Cell${styleAttr}><Data ss:Type="Number">${safe}</Data></Cell>`;
    }
    return `<Cell${styleAttr}><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function assetNameCellXml(row) {
    const name = xmlEscape(row.name || '—');
    if (!row.isLatestAssigned) {
        return cellXml(row.name || '—');
    }
    return `<Cell><Data ss:Type="String" xmlns="http://www.w3.org/TR/REC-html40">${name} <Font html:Color="#DC1414">${NEW_BADGE}</Font></Data></Cell>`;
}

function rowValue(row, key) {
    switch (key) {
        case 'assignedTo':
            return row.assignedTo || '—';
        case 'assetType':
            return row.assetType || '—';
        case 'category':
            return row.category || '—';
        case 'assetName':
            return row.isLatestAssigned ? `${row.name || '—'} ${NEW_BADGE}` : (row.name || '—');
        case 'accessories':
            return formatAccessoriesCell(row.accessories);
        case 'assetId':
            return row.assetId || '—';
        case 'qty':
            return Number(row.quantity) || 1;
        case 'value':
            return Number(row.totalValue) || 0;
        default:
            return '—';
    }
}

/**
 * Build Excel SpreadsheetML (.xls) buffer for asset list export.
 * Opens natively in Microsoft Excel / LibreOffice without extra packages.
 */
export function generateAssetListExcel({
    assets,
    columns = null,
    listTitle = 'Asset List',
    employee = null,
    printedOn = '',
    printedBy = '',
    groupByOwner = false,
}) {
    const columnDefs = resolveAssetListExportColumns(columns);
    const listRows = buildAssetListPdfRows(assets, {
        fallbackAssignee: employee,
        singleOwnerLatest: Boolean(employee) && !groupByOwner,
    });

    const colCount = 1 + columnDefs.length;
    const mergeAcross = Math.max(0, colCount - 1);
    const printMetaRow = (text) =>
        `<Row><Cell ss:MergeAcross="${mergeAcross}" ss:StyleID="PrintMeta"><Data ss:Type="String">${xmlEscape(text)}</Data></Cell></Row>`;
    const printRows = [];
    if (printedOn) printRows.push(printMetaRow(`Printed on: ${printedOn}`));
    if (printedBy) printRows.push(printMetaRow(`Printed by: ${printedBy}`));
    if (printRows.length) printRows.push('<Row></Row>');

    const headers = ['Serial No', ...columnDefs.map((c) => c.label)];
    const headerRow = `<Row>${headers.map((h) => cellXml(h, 'String', 'Header')).join('')}</Row>`;

    const bodyRows = listRows
        .map((row, index) => {
            const cells = [cellXml(index + 1, 'Number')];
            for (const col of columnDefs) {
                if (col.key === 'assetName') {
                    cells.push(assetNameCellXml(row));
                } else if (col.key === 'qty' || col.key === 'value') {
                    cells.push(cellXml(rowValue(row, col.key), 'Number'));
                } else {
                    cells.push(cellXml(rowValue(row, col.key)));
                }
            }
            return `<Row>${cells.join('')}</Row>`;
        })
        .join('');

    const total = listRows.reduce((sum, row) => sum + (Number(row.totalValue) || 0), 0);
    const valueColIndex = columnDefs.findIndex((c) => c.key === 'value');
    let totalRow = '';
    if (valueColIndex >= 0) {
        const cells = [`<Cell><Data ss:Type="String">Total</Data></Cell>`];
        for (let i = 0; i < columnDefs.length; i += 1) {
            if (i === valueColIndex) {
                cells.push(cellXml(total, 'Number'));
            } else {
                cells.push(cellXml(''));
            }
        }
        totalRow = `<Row>${cells.join('')}</Row>`;
    }

    const sheetName = xmlEscape(String(listTitle || 'Asset List').slice(0, 31) || 'Asset List');

    const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1"/>
   <Interior ss:Color="#F3F4F6" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="PrintMeta">
   <Font ss:Bold="1" ss:Size="10"/>
   <Alignment ss:Horizontal="Right"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${sheetName}">
  <Table ss:ExpandedColumnCount="${colCount}">
   ${printRows.join('\n   ')}
   ${headerRow}
   ${bodyRows}
   ${totalRow}
  </Table>
 </Worksheet>
</Workbook>`;

    return Buffer.from(xml, 'utf8');
}

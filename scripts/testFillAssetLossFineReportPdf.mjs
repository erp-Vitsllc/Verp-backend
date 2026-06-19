import fs from 'fs';
import { fillAssetLossFineReportPdfTemplate } from '../utils/fillAssetLossFineReportPdfTemplate.js';

const fine = {
    fineId: 'VEGA-Fine-0001',
    fineType: 'Loss & Damage',
    category: 'Loss',
    assetId: 'VEGA-ASSET-0084',
    description: 'asset report as Loss',
    assetPurchaseDate: '2024-01-01',
    serviceCharge: 100,
    totalFineAmount: 900,
    fineAmount: 900,
    responsibleFor: 'Employee',
    payableDuration: 3,
    sourceOfIncome: 'Salary',
    monthStart: '2026-05',
    awardedDate: '2026-05-21',
    assignedEmployees: [{ employeeId: 'VEGA-001', employeeName: 'Vishnu P', individualAmount: 300 }],
};

const buf = await fillAssetLossFineReportPdfTemplate({
    fine,
    assigned: fine.assignedEmployees[0],
    formSummary: { startMonthYear: 'May 2026', endMonthYear: 'Jul 2026' },
    employeeName: 'Vishnu P',
    hodName: 'Raseel M',
    signatureUrls: {},
});

const out = new URL('../assets/templates/AssetLossFineReport-sample-filled.pdf', import.meta.url);
fs.writeFileSync(out, buf);
console.log('Wrote', out.pathname, buf.length, 'bytes');

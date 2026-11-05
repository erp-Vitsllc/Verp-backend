import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSlotWorkbookBytes } from './salarySlotWorkbook.js';

function workbookText(bytes) {
    return Buffer.from(bytes).toString('utf8');
}

test('puts each company on its own WPS sheet', () => {
    const built = buildSlotWorkbookBytes({
        monthKey: '2026-10',
        method: 'WPS',
        rows: [
            {
                employeeId: 'VEGA-HR-00037',
                name: 'ABBAS RAZA',
                companyName: 'VEGA DxB',
                companyMolCode: 'MOL-DXB',
                employeeMolId: 'EMP-37',
                incomeFix: 1500,
                incomeVar: 150,
                leaveDays: 2,
                accountNumber: '123456',
                bankName: 'Emirates NBD',
            },
            {
                employeeId: 'VEGA-HR-00010',
                name: 'NNT PERSON',
                companyName: 'NNT',
                companyMolCode: 'MOL-NNT',
                employeeMolId: 'EMP-10',
                incomeFix: 800,
                incomeVar: 0,
                leaveDays: 0,
                accountNumber: '998877',
                bankName: 'ADCB',
            },
        ],
    });

    assert.deepEqual(built.sheetNames, ['WPS - NNT', 'WPS - VEGA DXB']);
    const text = workbookText(built.bytes);
    assert.match(text, /name="WPS - NNT"/);
    assert.match(text, /name="WPS - VEGA DXB"/);
    assert.match(text, /COMPMOLCODE/);
    assert.match(text, /EMPNAME/);
    assert.match(text, /BANKACCNO/);
    assert.match(text, /ABBAS RAZA/);
    assert.match(text, /NNT PERSON/);
    assert.match(text, /<v>1500<\/v>/);
    assert.match(text, /<v>2026<\/v>/);
    assert.equal(text.includes('Cash Salary'), false);
});

test('builds one Cash Salary sheet', () => {
    const built = buildSlotWorkbookBytes({
        monthKey: '2026-10',
        method: 'Cash',
        rows: [
            {
                employeeId: 'VEGA-HR-00002',
                name: 'CASH PERSON',
                companyName: 'VEGA AUH',
                net: 2200.5,
                bankName: 'FAB',
                accountNumber: '555',
                iban: 'AE070331234567890123456',
            },
        ],
    });

    assert.deepEqual(built.sheetNames, ['Cash Salary']);
    const text = workbookText(built.bytes);
    assert.match(text, /name="Cash Salary"/);
    assert.match(text, /Employee Name/);
    assert.match(text, /October 2026/);
    assert.match(text, /CASH PERSON/);
    assert.match(text, /<v>2200.5<\/v>/);
    assert.match(text, /<t>Cash<\/t>/);
    assert.equal(text.includes('WPS -'), false);
});

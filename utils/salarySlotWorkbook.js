import EmployeeBank from '../models/EmployeeBank.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import SalaryHistoricalProfile from '../models/SalaryHistoricalProfile.js';
import { collectSalarySlipPayrollFigures } from './buildSalarySlipPayload.js';

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const WPS_HEADERS = [
    'COMPMOLCODE', 'EMPMOLID', 'EMPNAME', 'INCOMEFIX', 'INCOMEVAR',
    'LEAVEDAYS', 'SALMNTH', 'SALYR', 'BANKACCNO', 'BANKNAME',
];

const CASH_HEADERS = [
    'S. No.', 'Employee ID', 'Employee Name', 'Salary Month', 'Bank Name',
    'Account No', 'IBAN', 'Net Salary', 'Payment mode',
];

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function codeKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function xmlText(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function columnName(index) {
    let n = index + 1;
    let name = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        name = String.fromCharCode(65 + rem) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function monthParts(monthKey) {
    const match = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return { label: String(monthKey || ''), month: '', year: '' };
    const monthIndex = Number(match[2]) - 1;
    return {
        label: MONTHS[monthIndex] ? `${MONTHS[monthIndex]} ${match[1]}` : monthKey,
        month: String(monthIndex + 1),
        year: match[1],
    };
}

function safeFileName(value) {
    return String(value || 'Payroll.xlsx').replace(/[<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Payroll.xlsx';
}

function sheetName(value) {
    const cleaned = String(value || 'Sheet')
        .replace(/[\\/?*[\]:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || 'Sheet').slice(0, 31);
}

export function wpsSheetName(companyName) {
    const short = String(companyName || 'Company').trim().toUpperCase() || 'COMPANY';
    return sheetName(`WPS - ${short}`);
}

function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        c ^= bytes[i];
        for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function zipStore(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const day = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const name = encoder.encode(file.name);
        const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
        const crc = crc32(data);
        const local = new Uint8Array(30 + name.length);
        const view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(10, time, true);
        view.setUint16(12, day, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, data.length, true);
        view.setUint32(22, data.length, true);
        view.setUint16(26, name.length, true);
        local.set(name, 30);
        locals.push(local, data);
        const cent = new Uint8Array(46 + name.length);
        const cv = new DataView(cent.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, day, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        cent.set(name, 46);
        central.push(cent);
        offset += local.length + data.length;
    }
    const centralBytes = concatBytes(central);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralBytes.length, true);
    ev.setUint32(16, offset, true);
    return concatBytes([...locals, centralBytes, end]);
}

function stylesXml() {
    const fonts = [
        '<font><sz val="11"/><name val="Calibri"/></font>',
        '<font><b/><sz val="11"/><name val="Calibri"/></font>',
        '<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF14532D"/></font>',
    ];
    const fills = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFFFE15A"/></patternFill></fill>',
        '<fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill>',
    ];
    const border = `<border>
      <left style="thin"><color rgb="FFD0D7E2"/></left>
      <right style="thin"><color rgb="FFD0D7E2"/></right>
      <top style="thin"><color rgb="FFD0D7E2"/></top>
      <bottom style="thin"><color rgb="FFD0D7E2"/></bottom>
    </border>`;
    function xf({ font = 0, fill = 0, borderId = 1, num = 0, align = 'left' }) {
        return `<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1" applyNumberFormat="1"><alignment horizontal="${align}" vertical="center"/></xf>`;
    }
    const cellXfs = [
        xf({ borderId: 0 }),
        xf({ font: 1, fill: 2, align: 'center' }),
        xf({}),
        xf({ num: 4, align: 'right' }),
        xf({ num: 1, align: 'right' }),
        xf({ font: 2, fill: 3 }),
        xf({ font: 2, fill: 3, num: 4, align: 'right' }),
        xf({ font: 2, fill: 3, num: 1, align: 'right' }),
    ];
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="${fonts.length}">${fonts.join('')}</fonts>
  <fills count="${fills.length}">${fills.join('')}</fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs>
</styleSheet>`;
}

function inline(ref, style, value) {
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${xmlText(value)}</t></is></c>`;
}

function numberCell(ref, style, value) {
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
}

function formulaCell(ref, style, formula) {
    return `<c r="${ref}" s="${style}"><f>${formula}</f></c>`;
}

function worksheetXml({ headers, rows, numericColumns, integerColumns, plainNumberColumns = new Set(), totalLabelColumn }) {
    const lastCol = columnName(headers.length - 1);
    const lastData = rows.length + 1;
    const totalRow = lastData + 1;
    const head = headers.map((header, index) => inline(`${columnName(index)}1`, 1, header)).join('');
    const body = rows.map((row, rowIndex) => {
        const cells = row.map((value, index) => {
            const ref = `${columnName(index)}${rowIndex + 2}`;
            if (numericColumns.has(index)) return numberCell(ref, 3, money(value));
            if (integerColumns.has(index) || plainNumberColumns.has(index)) {
                return numberCell(ref, 4, Number(value) || 0);
            }
            return inline(ref, 2, value);
        });
        return `<row r="${rowIndex + 2}">${cells.join('')}</row>`;
    });
    const totals = headers.map((_, index) => {
        const ref = `${columnName(index)}${totalRow}`;
        const letter = columnName(index);
        if (index === totalLabelColumn) return inline(ref, 5, 'Total');
        if (numericColumns.has(index)) {
            return rows.length
                ? formulaCell(ref, 6, `SUM(${letter}2:${letter}${lastData})`)
                : numberCell(ref, 6, 0);
        }
        if (integerColumns.has(index)) {
            return rows.length
                ? formulaCell(ref, 7, `SUM(${letter}2:${letter}${lastData})`)
                : numberCell(ref, 7, 0);
        }
        return `<c r="${ref}" s="5"/>`;
    });
    const cols = headers.map((_, index) => {
        const width = index === 2 ? 28 : 16;
        return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${totalRow}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>
    <row r="1" ht="22" customHeight="1">${head}</row>
    ${body.join('')}
    <row r="${totalRow}">${totals.join('')}</row>
  </sheetData>
  ${rows.length ? `<autoFilter ref="A1:${lastCol}${lastData}"/>` : ''}
</worksheet>`;
}

function workbookXml(sheets) {
    const list = sheets.map((sheet, index) => (
        `<sheet name="${xmlText(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
    )).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${list}</sheets>
  <calcPr calcMode="auto" fullCalcOnLoad="1"/>
</workbook>`;
}

function workbookRels(sheets) {
    const rows = sheets.map((_, index) => (
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    ));
    rows.push('<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.join('')}</Relationships>`;
}

function contentTypes(sheets) {
    const overrides = sheets.map((_, index) => (
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${overrides}
</Types>`;
}

function packWorkbook(sheets) {
    const files = [
        { name: '[Content_Types].xml', data: contentTypes(sheets) },
        {
            name: '_rels/.rels',
            data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
        },
        { name: 'xl/workbook.xml', data: workbookXml(sheets) },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets) },
        { name: 'xl/styles.xml', data: stylesXml() },
    ];
    sheets.forEach((sheet, index) => {
        files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: sheet.xml });
    });
    return zipStore(files);
}

function wpsRows(people, month) {
    return people.map((person) => [
        person.companyMolCode || '',
        person.employeeMolId || '',
        person.name || person.employeeId || '',
        money(person.incomeFix),
        money(person.incomeVar),
        Number(person.leaveDays) || 0,
        month.month,
        month.year,
        person.accountNumber || '',
        person.bankName || '',
    ]);
}

function cashRows(people, month) {
    return people.map((person, index) => [
        index + 1,
        person.employeeId || '',
        person.name || person.employeeId || '',
        month.label,
        person.bankName || '',
        person.accountNumber || '',
        person.iban || '',
        money(person.net),
        'Cash',
    ]);
}

function uniqueSheetName(name, used) {
    let next = sheetName(name);
    let n = 2;
    while (used.has(next.toLowerCase())) {
        const suffix = ` ${n}`;
        next = `${sheetName(name).slice(0, 31 - suffix.length)}${suffix}`;
        n += 1;
    }
    used.add(next.toLowerCase());
    return next;
}

/**
 * WPS: one sheet per company, named WPS - {short name}.
 * Cash: one Cash Salary sheet.
 */
export function buildSlotWorkbookBytes({ monthKey, method, rows }) {
    const month = monthParts(monthKey);
    const people = [...(rows || [])].sort((a, b) =>
        String(a?.name || a?.employeeId || '').localeCompare(String(b?.name || b?.employeeId || ''), undefined, {
            sensitivity: 'base',
            numeric: true,
        }),
    );
    const cash = String(method || '').trim().toUpperCase() === 'CASH';
    const used = new Set();
    let sheets;
    if (cash) {
        const name = uniqueSheetName('Cash Salary', used);
        sheets = [{
            name,
            xml: worksheetXml({
                headers: CASH_HEADERS,
                rows: cashRows(people, month),
                numericColumns: new Set([7]),
                integerColumns: new Set(),
                totalLabelColumn: 2,
            }),
        }];
    } else {
        const groups = new Map();
        for (const person of people) {
            const company = String(person.companyName || 'Company').trim() || 'Company';
            if (!groups.has(company)) groups.set(company, []);
            groups.get(company).push(person);
        }
        const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        sheets = names.map((company) => ({
            name: uniqueSheetName(wpsSheetName(company), used),
            xml: worksheetXml({
                headers: WPS_HEADERS,
                rows: wpsRows(groups.get(company), month),
                numericColumns: new Set([3, 4]),
                integerColumns: new Set([5]),
                plainNumberColumns: new Set([6, 7]),
                totalLabelColumn: 2,
            }),
        }));
        if (!sheets.length) {
            sheets = [{
                name: uniqueSheetName(wpsSheetName('Company'), used),
                xml: worksheetXml({
                    headers: WPS_HEADERS,
                rows: [],
                numericColumns: new Set([3, 4]),
                integerColumns: new Set([5]),
                plainNumberColumns: new Set([6, 7]),
                totalLabelColumn: 2,
                }),
            }];
        }
    }
    return {
        bytes: packWorkbook(sheets),
        sheetNames: sheets.map((sheet) => sheet.name),
    };
}

function personName(emp, employeeId) {
    const name = `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim();
    return name || employeeId;
}

export async function buildSalarySlotFile(payment) {
    const monthKey = String(payment?.monthKey || '').trim();
    const ids = [...new Set((payment?.employeeIds || payment?.selectedIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    const method = String(payment?.paymentMethod || '').trim().toUpperCase() === 'CASH' ? 'Cash' : 'WPS';
    const slotCompany = String(payment?.companyName || '').trim();
    const [people, profiles, banks, figures] = await Promise.all([
        EmployeeBasic.find({ employeeId: { $in: ids } })
            .select('employeeId firstName lastName company')
            .populate('company', 'nickName name')
            .lean(),
        SalaryHistoricalProfile.find({ employeeId: { $in: ids } })
            .select('employeeId companyMolCode employeeMolId')
            .lean(),
        EmployeeBank.find({ employeeId: { $in: ids } })
            .select('employeeId bankName accountNumber ibanNumber')
            .lean(),
        collectSalarySlipPayrollFigures(ids, monthKey),
    ]);
    const peopleByCode = new Map((people || []).map((emp) => [codeKey(emp.employeeId), emp]));
    const profileByCode = new Map((profiles || []).map((row) => [codeKey(row.employeeId), row]));
    const bankByCode = new Map((banks || []).map((row) => [codeKey(row.employeeId), row]));
    const rows = ids.map((employeeId) => {
        const key = codeKey(employeeId);
        const emp = peopleByCode.get(key);
        const profile = profileByCode.get(key);
        const bank = bankByCode.get(key);
        const pay = figures.get(key) || {};
        const companyName = String(
            emp?.company?.nickName || emp?.company?.name || slotCompany || 'Company',
        ).trim() || 'Company';
        const accountNumber = String(bank?.accountNumber || '').trim();
        const iban = String(bank?.ibanNumber || '').replace(/\s+/g, '');
        return {
            employeeId: String(emp?.employeeId || employeeId).trim(),
            name: personName(emp, employeeId),
            companyName,
            companyMolCode: String(profile?.companyMolCode || '').trim(),
            employeeMolId: String(profile?.employeeMolId || '').trim(),
            incomeFix: money(pay.monthlySalary),
            incomeVar: money(money(pay.ot) + money(pay.rewardAdditions)),
            leaveDays: Number(pay.leaveDays) || 0,
            net: money(
                pay.netSalaryPayable != null && pay.netSalaryPayable !== ''
                    ? pay.netSalaryPayable
                    : (pay.actualSalary != null && pay.actualSalary !== '' ? pay.actualSalary : pay.netSalary),
            ),
            bankName: String(bank?.bankName || '').trim(),
            accountNumber: accountNumber || iban,
            iban,
        };
    });
    const built = buildSlotWorkbookBytes({ monthKey, method, rows });
    const month = monthParts(monthKey);
    const companyBit = slotCompany ? ` - ${slotCompany}` : '';
    const filename = safeFileName(
        method === 'Cash'
            ? `Cash Salary ${month.label}${companyBit}.xlsx`
            : `WPS ${month.label}${companyBit}.xlsx`,
    );
    return {
        filename,
        content: Buffer.from(built.bytes),
        sheetNames: built.sheetNames,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
}

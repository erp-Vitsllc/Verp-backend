import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

const path = process.argv[2] || 'c:/Users/Vega/Downloads/HandoverForm-VEGA-ASSET-0084.pdf';
const bytes = fs.readFileSync(path);
const doc = await PDFDocument.load(bytes);
const form = doc.getForm();
const fields = form.getFields();
console.log('pages', doc.getPageCount());
console.log('field count', fields.length);
for (const f of fields) {
    const name = f.getName();
    const type = f.constructor.name;
    let value = '';
    try {
        if (type.includes('Text')) value = f.getText();
        if (type.includes('Check')) value = String(f.isChecked());
    } catch {
        /* ignore */
    }
    console.log({ name, type, value });
}
const page = doc.getPage(0);
const { width, height } = page.getSize();
console.log('page size', { width, height });

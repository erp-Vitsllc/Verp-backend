import fs from 'fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const path = process.argv[2] || 'c:/Users/Vega/Downloads/HandoverForm-VEGA-ASSET-0084.pdf';
const buf = fs.readFileSync(path);
const data = await pdfParse(buf);
console.log('pages', data.numpages);
console.log(data.text);

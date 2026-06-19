import fs from 'fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const path = process.argv[2] || 'c:/Users/Vega/Downloads/HandoverForm-VEGA-ASSET-0084.pdf';
const data = new Uint8Array(fs.readFileSync(path));
const doc = await getDocument({ data, disableWorker: true }).promise;
const page = await doc.getPage(1);
const viewport = page.getViewport({ scale: 1 });
const content = await page.getTextContent();
console.log('viewport', viewport.width, viewport.height);
for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const [a, b, c, d, x, y] = item.transform;
    console.log(JSON.stringify({ text: item.str, x: Math.round(x), y: Math.round(y), w: Math.round(item.width), h: Math.round(item.height) }));
}

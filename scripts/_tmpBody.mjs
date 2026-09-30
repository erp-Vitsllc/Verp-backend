import fs from 'fs';
const s = fs.readFileSync(process.env.TEMP + '/locator-39.js', 'utf8');
const key = 'vehIDs';
let from = 0;
let n = 0;
while (n < 6) {
    const i = s.indexOf(key, from);
    if (i < 0) break;
    const slice = s.slice(Math.max(0, i - 220), i + 260).replace(/\s+/g, ' ');
    if (/fromDate|reportID|toDate/.test(slice)) {
        console.log('@' + i);
        console.log(slice);
        console.log('---');
        n += 1;
    }
    from = i + key.length;
}

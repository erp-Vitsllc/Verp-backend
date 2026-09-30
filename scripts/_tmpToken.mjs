import fs from 'fs';
const s = fs.readFileSync(process.env.TEMP + '/locator-39.js', 'utf8');
const key = '__token__';
let from = 0;
let n = 0;
while (n < 8) {
    const i = s.indexOf(key, from);
    if (i < 0) break;
    const slice = s.slice(Math.max(0, i - 180), i + 220).replace(/\s+/g, ' ');
    if (/setItem|token|login|postlogin/i.test(slice)) {
        console.log('@' + i);
        console.log(slice);
        console.log('---');
        n += 1;
    }
    from = i + key.length;
}

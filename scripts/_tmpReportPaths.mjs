import fs from 'fs';
const s = fs.readFileSync(process.env.TEMP + '/locator-39.js', 'utf8');
const re = /k\.a\(\s*"([^"]+)"/g;
const set = new Set();
let m;
while ((m = re.exec(s))) set.add(m[1]);
console.log([...set].sort().join('\n'));
console.log('count', set.size);

const re2 = /Object\(k\.a\)\(\s*"([^"]+)"/g;
const set2 = new Set();
while ((m = re2.exec(s))) set2.add(m[1]);
console.log('--- object k.a');
console.log([...set2].sort().join('\n'));

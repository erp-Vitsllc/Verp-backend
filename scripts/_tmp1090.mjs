import fs from 'fs';
const s = fs.readFileSync(process.env.TEMP + '/locator-39.js', 'utf8');
const key = '1090:function';
const i = s.indexOf(key);
console.log('at', i);
fs.writeFileSync(process.env.TEMP + '/locator-1090.txt', s.slice(i, i + 2200));

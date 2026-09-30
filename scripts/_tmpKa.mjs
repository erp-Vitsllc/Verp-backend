import fs from 'fs';
const s = fs.readFileSync(process.env.TEMP + '/locator-39.js', 'utf8');
const marker = s.indexOf('SET_EXCESSIVE_IDLING_REPORT');
const start = s.lastIndexOf(':function(A,a,i)', marker);
const next = s.indexOf(':function(', marker + 50);
const chunk = s.slice(start, next);
const i = chunk.indexOf('Object(k.a)(');
fs.writeFileSync(process.env.TEMP + '/locator-ka.txt', chunk.slice(Math.max(0, i - 1500), i + 1800));
console.log('i', i, 'chunk', chunk.length);

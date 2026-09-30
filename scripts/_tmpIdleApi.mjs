import fs from 'fs';

const s = fs.readFileSync(process.env.TEMP + '/locator-39.js', 'utf8');
const keys = [
    'excessiveIdling',
    'EXCESSIVE_IDLING',
    'getWeeklyIdlingDetails',
    'idlingReport',
    '/idling',
    'Idling Report',
];
keys.push('i(1019)', '1019).a', 'excessive');
for (const key of keys) {
    let from = 0;
    let n = 0;
    console.log('\n====', key);
    while (n < 4) {
        const i = s.indexOf(key, from);
        if (i < 0) break;
        const slice = s.slice(Math.max(0, i - 280), i + 320).replace(/\s+/g, ' ');
        if (/\/|api|report|POST|url|fetch|axios/i.test(slice)) {
            console.log('@' + i);
            console.log(slice);
            console.log('---');
            n += 1;
        }
        from = i + key.length;
    }
}

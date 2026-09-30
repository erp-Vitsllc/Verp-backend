import fs from 'fs';
const files = ['locator-43.js', 'locator-39.js'];
for (const f of files) {
    const s = fs.readFileSync(process.env.TEMP + '/' + f, 'utf8');
    console.log('\n====', f, 'postlogin ====');
    let from = 0;
    let n = 0;
    while (n < 6) {
        const i = s.indexOf('postlogin', from);
        if (i < 0) break;
        console.log('@' + i);
        console.log(s.slice(Math.max(0, i - 250), i + 400).replace(/\s+/g, ' '));
        console.log('---');
        from = i + 9;
        n += 1;
    }
    console.log('\n====', f, 'setItem ====');
    from = 0;
    n = 0;
    while (n < 8) {
        const i = s.indexOf('setItem', from);
        if (i < 0) break;
        const slice = s.slice(Math.max(0, i - 80), i + 180).replace(/\s+/g, ' ');
        if (/token|csrf|user/i.test(slice)) {
            console.log('@' + i);
            console.log(slice);
            console.log('---');
            n += 1;
        }
        from = i + 7;
    }
}

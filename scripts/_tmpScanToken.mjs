import fs from 'fs';
import path from 'path';
const dir = process.env.TEMP;
const files = fs.readdirSync(dir).filter((f) => f.startsWith('locator-') && f.endsWith('.js'));
const needles = ['__token__', 'setItem', 'postlogin', 'Xtoken'];
for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const hits = needles.map((n) => [n, s.split(n).length - 1]);
    console.log(f, hits.filter(([, c]) => c).map(([n, c]) => n + ':' + c).join(' '));
}

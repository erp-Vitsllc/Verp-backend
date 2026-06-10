import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const skip = new Set([
    "utils/resolveFrontendBaseUrl.js",
    "index.js",
    "utils/generateBulkAssetInventoryPdf.js",
]);

function walk(dir, out = []) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        const rel = path.relative(root, p).replace(/\\/g, "/");
        if (fs.statSync(p).isDirectory()) walk(p, out);
        else if (f.endsWith(".js") || f.endsWith(".mjs")) out.push({ abs: p, rel });
    }
    return out;
}

function importFor(rel) {
    const depth = rel.split("/").length - 2;
    const prefix = "../".repeat(depth);
    return `import { resolveFrontendBaseUrl, emailFrontendUrl } from '${prefix}utils/resolveFrontendBaseUrl.js';\n`;
}

function migrateContent(c) {
    let out = c;

    out = out.replace(
        /\(process\.env\.FRONTEND_URL \|\| ['"]http:\/\/localhost:3000['"]\)\.replace\(\/'/g,
        "emailFrontendUrl(",
    );
    out = out.replace(/\/g, ['"]\)/g, "");

    out = out.replace(
        /\(process\.env\.FRONTEND_URL \|\| ['"]http:\/\/localhost:3000['"]\)\.replace\(\/\\\$\/, ['"]['"]\)/g,
        "resolveFrontendBaseUrl()",
    );

    out = out.replace(
        /origin \|\| process\.env\.FRONTEND_URL \|\| ['"]http:\/\/localhost:3000['"]/g,
        "resolveFrontendBaseUrl(req)",
    );
    out = out.replace(
        /process\.env\.FRONTEND_URL \|\| origin \|\| ['"]http:\/\/localhost:3000['"]/g,
        "resolveFrontendBaseUrl(req)",
    );

    out = out.replace(
        /String\(process\.env\.FRONTEND_URL \|\| ['"]http:\/\/localhost:3000['"]\)\.replace\(\/\\\+\$\/g, ['"]['"]\)/g,
        "resolveFrontendBaseUrl()",
    );

    out = out.replace(
        /process\.env\.FRONTEND_URL \|\| ['"]http:\/\/localhost:3000['"]/g,
        "resolveFrontendBaseUrl()",
    );

    return out;
}

const changed = [];
for (const { abs, rel } of walk(root)) {
    if (skip.has(rel)) continue;
    let c = fs.readFileSync(abs, "utf8");
    if (!c.includes("FRONTEND_URL") && !c.includes("localhost:3000")) continue;
    const migrated = migrateContent(c);
    if (migrated === c) continue;

    let out = migrated;
    if (!out.includes("resolveFrontendBaseUrl.js")) {
        const imp = importFor(rel);
        const m = out.match(/^import .+;\r?\n/m);
        out = m ? out.replace(m[0], m[0] + imp) : imp + out;
    }

    fs.writeFileSync(abs, out);
    changed.push(rel);
}

console.log(changed.join("\n"));
console.log("Total:", changed.length);

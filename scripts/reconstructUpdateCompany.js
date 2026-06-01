import fs from "fs";
import path from "path";

const transcriptDir =
    "C:/Users/Vega/.cursor/projects/c-Users-Vega-Desktop-ERP-Project/agent-transcripts";
const outPath =
    "C:/Users/Vega/Desktop/ERP_Project/VERP_backend/controllers/company/updateCompany.js";

const events = [];

function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".jsonl")) {
            const stat = fs.statSync(p);
            const lines = fs.readFileSync(p, "utf8").split("\n");
            lines.forEach((line, idx) => {
                if (!line.includes("updateCompany.js")) return;
                try {
                    const j = JSON.parse(line);
                    for (const m of j.message?.content || []) {
                        if (
                            m.name === "StrReplace" &&
                            m.input?.path?.replace(/\\/g, "/").includes("updateCompany.js")
                        ) {
                            events.push({
                                ts: stat.mtimeMs,
                                file: p,
                                line: idx,
                                type: "StrReplace",
                                old: m.input.old_string,
                                new: m.input.new_string,
                            });
                        } else if (
                            m.name === "Write" &&
                            m.input?.path?.replace(/\\/g, "/").includes("updateCompany.js") &&
                            m.input?.contents?.includes("export const updateCompany")
                        ) {
                            events.push({
                                ts: stat.mtimeMs,
                                file: p,
                                line: idx,
                                type: "Write",
                                contents: m.input.contents,
                            });
                        }
                    }
                } catch {
                    /* ignore malformed lines */
                }
            });
        }
    }
}

walk(transcriptDir);
events.sort((a, b) => a.ts - b.ts || a.line - b.line);

console.log("Events:", events.length, "writes:", events.filter((e) => e.type === "Write").length);

const writes = events.filter((e) => e.type === "Write");
if (writes.length > 0) {
    const last = writes[writes.length - 1];
    fs.writeFileSync(outPath, last.contents);
    console.log("Restored from Write, lines:", last.contents.split("\n").length);
    process.exit(0);
}

// Reverse StrReplace chain from last to first to recover base, then apply forward
const replaces = events.filter((e) => e.type === "StrReplace");
let content = null;

// Try forward apply starting from null - find a replace whose old isn't found yet
// Work backwards: start with empty, reverse all replaces to get earliest state
for (let i = replaces.length - 1; i >= 0; i--) {
    const r = replaces[i];
    if (content === null) {
        content = r.new;
        continue;
    }
    if (content.includes(r.new)) {
        content = content.replace(r.new, r.old);
    } else {
        console.warn("Reverse patch failed at index", i, "file", path.basename(r.file));
    }
}

if (!content || !content.includes("export const updateCompany")) {
    console.error("Failed to reconstruct base from reverse patches");
    process.exit(1);
}

console.log("Base from reverse, lines:", content.split("\n").length);

// Apply forward all replaces
let applied = 0;
for (const r of replaces) {
    if (content.includes(r.old)) {
        content = content.replace(r.old, r.new);
        applied++;
    }
}

console.log("Applied", applied, "/", replaces.length, "forward patches");
console.log("Final lines:", content.split("\n").length);
fs.writeFileSync(outPath, content);
console.log("Written to", outPath);

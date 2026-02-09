import fs from 'fs';

try {
    let raw = fs.readFileSync('snyk_backend_results_v4.json');
    let content;

    if (raw[0] === 0xFF && raw[1] === 0xFE) {
        content = raw.toString('utf16le');
    } else {
        content = raw.toString('utf8');
    }

    const firstBrace = content.indexOf('{');
    if (firstBrace > 0) content = content.slice(firstBrace);

    const sarif = JSON.parse(content);

    sarif.runs.forEach(run => {
        run.results.forEach(result => {
            if (result.level === 'warning') {
                console.log(`[MEDIUM] ${result.ruleId}`);
                console.log(`Message: ${result.message.text}`);
                if (result.locations) {
                    result.locations.forEach(loc => {
                        const uri = loc.physicalLocation.artifactLocation.uri;
                        const line = loc.physicalLocation.region.startLine;
                        console.log(`Location: ${uri}:${line}`);
                    });
                }

                // Show data flow source if available
                if (result.codeFlows) {
                    result.codeFlows.forEach(flow => {
                        flow.threadFlows.forEach(thread => {
                            const first = thread.locations[0];
                            const last = thread.locations[thread.locations.length - 1];
                            console.log(`  Source: ${first.location.physicalLocation.artifactLocation.uri}:${first.location.physicalLocation.region.startLine}`);
                            console.log(`  Sink:   ${last.location.physicalLocation.artifactLocation.uri}:${last.location.physicalLocation.region.startLine}`);
                        });
                    });
                }
                console.log('---');
            }
        });
    });
} catch (e) {
    console.error('Error:', e.message);
}

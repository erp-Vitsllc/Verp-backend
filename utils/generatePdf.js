import puppeteer from 'puppeteer';

/** Puppeteer 24+ may return Uint8Array; nodemailer needs a Buffer. */
export function pdfOutputToBuffer(pdf) {
    if (pdf == null) return null;
    if (Buffer.isBuffer(pdf)) return pdf;
    if (pdf instanceof Uint8Array) return Buffer.from(pdf);
    if (ArrayBuffer.isView(pdf)) {
        return Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
    }
    try {
        return Buffer.from(pdf);
    } catch {
        return null;
    }
}

function isPdfTargetClosedError(error) {
    const msg = String(error?.message || error || '');
    return (
        msg.includes('Target closed') ||
        msg.includes('Page.printToPDF') ||
        msg.includes('Protocol error')
    );
}

async function renderPdfWithFallback(page, primaryOptions) {
    try {
        return await page.pdf(primaryOptions);
    } catch (error) {
        // Some hosted Chromium builds crash on custom pixel height print jobs.
        console.warn('[PDF] Primary page.pdf failed; retrying with A4 fallback:', error?.message || error);
        return page.pdf({
            format: 'A4',
            landscape: false,
            printBackground: true,
            preferCSSPageSize: false,
            margin: {
                top: '10mm',
                right: '8mm',
                bottom: '10mm',
                left: '8mm'
            }
        });
    }
}

/**
 * Wait for fonts and <img> resources inside the PDF capture root.
 * Handover signatures load from the API (cross-origin); Puppeteer often printed before they finished,
 * so previews looked correct but PDFs omitted signatures. Clearing body too early also aborts in-flight loads.
 */
async function waitForFontsAndImages(page, rootSelector, perImageTimeoutMs = 20000) {
    await page.evaluate(async (sel, perImageTimeoutMs) => {
        const root = document.querySelector(sel);
        if (!root) return;
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        try {
            if (document.fonts?.ready) {
                await Promise.race([document.fonts.ready, delay(Math.min(perImageTimeoutMs, 8000))]);
            }
        } catch {
            /* ignore */
        }
        const imgs = Array.from(root.querySelectorAll('img'));
        await Promise.all(
            imgs.map(
                (img) =>
                    new Promise((resolve) => {
                        const finish = () => resolve();
                        if (img.complete) return finish();
                        img.addEventListener('load', finish, { once: true });
                        img.addEventListener('error', finish, { once: true });
                        setTimeout(finish, perImageTimeoutMs);
                    })
            )
        );
        await Promise.all(
            imgs.map((img) => {
                if (typeof img.decode !== 'function' || img.naturalWidth === 0) return Promise.resolve();
                return img.decode().catch(() => {});
            })
        );
    }, rootSelector, perImageTimeoutMs);
}

async function launchPdfBrowser(attempt = 1) {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    const headlessMode = process.env.PUPPETEER_HEADLESS || 'new';
    const baseArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run'
    ];
    // Avoid unstable single-process/no-zygote combination on Windows
    // (can crash Chromium during Page.printToPDF with "Target closed").
    const args = (() => {
        if (attempt > 1) {
            // Minimal fallback args for unstable hosted environments.
            return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
        }
        if (process.platform === 'win32') return baseArgs;
        return [...baseArgs, '--no-zygote', '--single-process'];
    })();

    const baseOptions = {
        headless: headlessMode === 'true' ? true : headlessMode,
        args,
        protocolTimeout: 120000
    };

    // Hosted deployments often require explicit chrome path.
    if (executablePath) {
        console.log(`[PDF] Launching Chromium via PUPPETEER_EXECUTABLE_PATH: ${executablePath}`);
        return puppeteer.launch({ ...baseOptions, executablePath });
    }

    try {
        return await puppeteer.launch(baseOptions);
    } catch (err) {
        // Retry with conservative fallback.
        console.error('[PDF] Default Puppeteer launch failed, retrying with headless=true:', err?.message || err);
        return puppeteer.launch({ ...baseOptions, headless: true });
    }
}

export const generatePdf = async (url, token, user, permissions = {}, selector = '#loan-form-container') => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        let browser = null;
        let page = null;
        try {
            browser = await launchPdfBrowser(attempt);

            console.log(`[generatePdf] Starting generation for: ${url} (attempt ${attempt}/2)`);
            page = await browser.newPage();

            // set viewport
            await page.setViewport({ width: 1200, height: 800 });

        // Authenticate before navigation
            if (token && user) {
                await page.evaluateOnNewDocument((token, user, permissions) => {
                    try {
                        localStorage.setItem('token', token);
                        const userStr = typeof user === 'string' ? user : JSON.stringify(user);
                        localStorage.setItem('user', userStr);
                        localStorage.setItem('employeeUser', userStr);

                    // Inject Permissions if provided, otherwise default to full access for admin/root
                    const permsStr = permissions ? (typeof permissions === 'string' ? permissions : JSON.stringify(permissions)) : JSON.stringify({});
                    localStorage.setItem('userPermissions', permsStr);
                    } catch (e) {
                        console.error("Failed to inject auth:", e);
                    }
                }, token, user, permissions);
            }

        // Bridge console logs to backend
            page.on('console', msg => console.log('PAGE LOG:', msg.text()));

        // Navigate to the page
            console.log(`[generatePdf] Navigating to URL...`);
            // Next.js / SPAs often keep connections open; networkidle2 may never resolve and times out.
            await page.goto(url, {
                waitUntil: 'load',
                timeout: 90000
            });
            console.log(`[generatePdf] Navigation complete. Waiting for selector: ${selector}`);

        // Wait for the form container to be visible
            try {
                await page.waitForSelector(selector, { timeout: 30000 });
                console.log(`[generatePdf] Selector found. Waiting for layout stability...`);
                // Small delay to ensure any layout shifts or animations settle
                await new Promise(resolve => setTimeout(resolve, 500));
                console.log(`[generatePdf] Ready to isolate container.`);
            } catch (timeoutErr) {
                const currentUrl = page.url();
                const title = await page.title();
                console.error(`[generatePdf] Timeout waiting for ${selector}. Current URL: ${currentUrl}, Title: ${title}`);
                throw new Error(`Failed to find ${selector} on page after 30s. Current URL: ${currentUrl}, Title: ${title}`);
            }

            console.log(`[generatePdf] Waiting for fonts and images inside capture root...`);
            await waitForFontsAndImages(page, selector);

        // Isolate the form container: Remove everything else from the body
            await page.evaluate((sel) => {
                const form = document.querySelector(sel);
                if (form) {
                    document.body.innerHTML = '';
                    document.body.appendChild(form);
                    document.body.style.backgroundColor = 'white';
                    document.body.style.display = 'flex';
                    document.body.style.justifyContent = 'center';
                    document.body.style.alignItems = 'flex-start'; // Align top
                    document.body.style.margin = '0';
                    document.body.style.padding = '0';

                // Ensure form has no margin in this new context
                    form.style.margin = '0';

                // Force background to visible if needed
                    document.documentElement.style.backgroundColor = 'white';
                }
            }, selector);

        // Hide elements that shouldn't be printed (like buttons) if they aren't already hidden by print styles
            await page.emulateMediaType('screen');

        // Hide action overlay manually just in case
            await page.addStyleTag({
                content: `
                .print\\:hidden { display: none !important; }
                /* Ensure background is visible */
                * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                
                /* Hide scrollbars */
                body::-webkit-scrollbar { display: none; }
                body { -ms-overflow-style: none; scrollbar-width: none; }
            `
            });

            await page.evaluate(
                () =>
                    new Promise((resolve) => {
                        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                    })
            );
            await new Promise((r) => setTimeout(r, 300));

        // Calculate the height of the content dynamically
            const height = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.getBoundingClientRect().height : document.body.scrollHeight;
            }, selector);

        // Generate PDF
            const pdfBuffer = await renderPdfWithFallback(page, {
                width: '210mm',
                height: `${height}px`,
                printBackground: true,
                margin: {
                    top: '0px',
                    right: '0px',
                    bottom: '0px',
                    left: '0px'
                },
                preferCSSPageSize: false
            });

            return pdfOutputToBuffer(pdfBuffer);
        } catch (error) {
            lastError = error;
            const shouldRetry = attempt < 2 && isPdfTargetClosedError(error);
            console.error(`Puppeteer PDF Generation Error (attempt ${attempt}/2):`, error);
            if (!shouldRetry) throw error;
            console.warn('[generatePdf] Retrying with fallback Chromium launch options...');
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    throw lastError || new Error('Failed to generate PDF');
};

/**
 * Renders a full HTML document in Puppeteer (no external URL).
 * Use for server-side PDFs when the frontend print route may be unavailable (e.g. stale deploy).
 */
export const generatePdfFromHtml = async (html, selector) => {
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        let browser = null;
        let page = null;
        try {
            browser = await launchPdfBrowser(attempt);

            console.log(`[generatePdfFromHtml] Rendering with selector: ${selector} (attempt ${attempt}/2)`);
            page = await browser.newPage();
            await page.setViewport({ width: 1200, height: 800 });

            await page.setContent(html, {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            await page.waitForSelector(selector, { timeout: 30000 });
            await new Promise((resolve) => setTimeout(resolve, 500));

            await page.evaluate((sel) => {
                const form = document.querySelector(sel);
                if (form) {
                    document.body.innerHTML = '';
                    document.body.appendChild(form);
                    document.body.style.backgroundColor = 'white';
                    document.body.style.display = 'flex';
                    document.body.style.justifyContent = 'center';
                    document.body.style.alignItems = 'flex-start';
                    document.body.style.margin = '0';
                    document.body.style.padding = '0';
                    form.style.margin = '0';
                    document.documentElement.style.backgroundColor = 'white';
                }
            }, selector);

            await page.emulateMediaType('screen');
            await page.addStyleTag({
                content: `
                .print\\:hidden { display: none !important; }
                * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                body::-webkit-scrollbar { display: none; }
                body { -ms-overflow-style: none; scrollbar-width: none; }
            `
            });

            const pdfBuffer = await renderPdfWithFallback(page, {
                format: 'A4',
                landscape: false,
                printBackground: true,
                preferCSSPageSize: false,
                margin: {
                    top: '10mm',
                    right: '8mm',
                    bottom: '10mm',
                    left: '8mm'
                }
            });

            const out = pdfOutputToBuffer(pdfBuffer);
            if (!out?.length) {
                throw new Error('Puppeteer returned empty PDF buffer');
            }
            return out;
        } catch (error) {
            lastError = error;
            const shouldRetry = attempt < 2 && isPdfTargetClosedError(error);
            console.error(`Puppeteer PDF From HTML Error (attempt ${attempt}/2):`, error);
            if (!shouldRetry) throw error;
            console.warn('[generatePdfFromHtml] Retrying with fallback Chromium launch options...');
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }
    throw lastError || new Error('Failed to generate PDF from HTML');
};

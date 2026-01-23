import puppeteer from 'puppeteer';

export const generatePdf = async (url, token, user, permissions = {}, selector = '#loan-form-container') => {
    let browser = null;
    let page = null;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

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
        await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Wait for the form container to be visible
        await page.waitForSelector(selector, { timeout: 30000 });

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

        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '0px',
                right: '0px',
                bottom: '0px',
                left: '0px'
            }
        });

        return pdfBuffer;

    } catch (error) {
        console.error("Puppeteer PDF Generation Error:", error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};

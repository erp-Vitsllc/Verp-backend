import { exchangeAuthorizationCode } from '../../services/zohoService.js';

function resolveFrontendUrl() {
    return String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function buildOAuthResultPage({ success, message, frontendUrl }) {
    const title = success ? 'Zoho Connected' : 'Zoho Connection Failed';
    const body = success
        ? 'Zoho Books is connected. You can close this tab and return to the ERP.'
        : message || 'Could not complete Zoho authorization.';
    const cta = success ? 'Return to ERP' : 'Go back to ERP';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f8fafc; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px; max-width: 520px; box-shadow: 0 10px 30px rgba(15,23,42,.08); }
    h1 { margin: 0 0 12px; font-size: 24px; color: ${success ? '#047857' : '#b91c1c'}; }
    p { margin: 0 0 20px; color: #334155; line-height: 1.5; }
    a { display: inline-block; background: #0f766e; color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 10px; font-weight: 700; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${body}</p>
    <a href="${frontendUrl}">${cta}</a>
  </div>
</body>
</html>`;
}

export const zohoCallback = async (req, res) => {
    const frontendUrl = resolveFrontendUrl();

    try {
        const oauthError = req.query?.error;
        if (oauthError) {
            return res
                .status(400)
                .send(
                    buildOAuthResultPage({
                        success: false,
                        message: String(oauthError),
                        frontendUrl,
                    }),
                );
        }

        const code = req.query?.code;
        if (!code) {
            return res
                .status(400)
                .send(
                    buildOAuthResultPage({
                        success: false,
                        message: 'Authorization code is required',
                        frontendUrl,
                    }),
                );
        }

        await exchangeAuthorizationCode(String(code), {
            state: req.query?.state,
        });

        return res
            .status(200)
            .send(buildOAuthResultPage({ success: true, frontendUrl }));
    } catch (error) {
        console.error('[ZohoCallback] Failed:', error?.message || error);
        return res
            .status(500)
            .send(
                buildOAuthResultPage({
                    success: false,
                    message: error?.message || 'Failed to complete Zoho authorization',
                    frontendUrl,
                }),
            );
    }
};

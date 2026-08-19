import { buildApprovedFineReportInnerHtml } from './buildApprovedFineReportInnerHtml.js';

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Employee email after Management approves a fine.
 * Body uses the redesigned fine report layout (type title, discount as AED amount).
 */
export function buildFineConfirmedEmailHtml({
    greetingName,
    fineId,
    fallbackNote = '',
    fields = null,
}) {
    const noteBlock = fallbackNote ? `<div style="margin-bottom:16px;">${fallbackNote}</div>` : '';
    const title = fields?.reportTitle || 'FINE REPORT';

    const reportTable = fields
        ? buildApprovedFineReportInnerHtml(fields, {
              includeSignatures: false,
              includeAcknowledgement: true,
              includeFooter: true,
              rawPayableAmount: fields.yourFinePayment,
          })
        : `<p style="margin:0;font-size:12px;color:#888;">Fine reference: <strong>${esc(fineId)}</strong></p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f5f5f5;">
        <tr>
            <td align="center" style="padding:24px 12px;">
                <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
                    <tr>
                        <td style="padding:28px 28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;line-height:1.55;">
                            ${noteBlock}
                            <p style="margin:0 0 12px;">Dear ${esc(greetingName)},</p>
                            <p style="margin:0 0 16px;">
                                A fine has been <strong>approved by Management</strong>.
                                Please review the report below and the attached PDF.
                            </p>
                            ${reportTable}
                            <p style="margin:24px 0 0;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px;">
                                This is an automated message from the VERP System.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

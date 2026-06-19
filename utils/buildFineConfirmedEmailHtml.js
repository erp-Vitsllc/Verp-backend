function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Simple email body — greeting message only. The fine form is in the PDF attachment.
 */
export function buildFineConfirmedEmailHtml({ greetingName, fineId, fallbackNote = '' }) {
    const noteBlock = fallbackNote ? `<div style="margin-bottom:16px;">${fallbackNote}</div>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fine Approved</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f5f5f5;">
        <tr>
            <td align="center" style="padding:24px 12px;">
                <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
                    <tr>
                        <td style="padding:28px 32px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#333;line-height:1.6;">
                            ${noteBlock}
                            <p style="margin:0 0 12px;">Dear ${esc(greetingName)},</p>
                            <p style="margin:0 0 12px;">
                                Your fine has been <strong>approved by Management</strong>.
                                Please review the Asset Loss Fine Report in the attached PDF for your records.
                            </p>
                            <p style="margin:0;font-size:12px;color:#888;">Fine reference: <strong>${esc(fineId)}</strong></p>
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

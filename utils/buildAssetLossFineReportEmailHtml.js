function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Email body for Asset Loss Fine Report notifications (PDF is attached separately).
 */
export function buildAssetLossFineReportEmailHtml({
    greetingName,
    fineId,
    employeeName = '',
    fallbackNote = '',
}) {
    const noteBlock = fallbackNote ? `<div style="margin-bottom:16px;">${fallbackNote}</div>` : '';
    const employeeLine = employeeName
        ? `<p style="margin:0 0 12px;">Employee: <strong>${esc(employeeName)}</strong></p>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Asset Loss Fine Report</title>
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
                                The Loss &amp; Damage fine <strong>#${esc(fineId)}</strong> has been
                                <strong>approved by Management</strong>.
                                The Asset Loss Fine Report is attached for your records.
                            </p>
                            ${employeeLine}
                            <p style="margin:0;font-size:12px;color:#888;">Fine reference: <strong>${esc(fineId)}</strong></p>
                            <p style="margin:24px 0 0;font-size:11px;color:#999;border-top:1px solid #e2e8f0;padding-top:12px;">
                                VeRP — automated notification
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

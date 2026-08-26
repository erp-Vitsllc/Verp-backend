/** Gold / emerald celebration palette — solid hex for Outlook / Gmail compatibility. */
const THEME = {
    page: '#fffbeb',
    hero: '#059669',
    heroDark: '#047857',
    footer: '#065f46',
    badge: '#d97706',
    white: '#ffffff',
    text: '#1e293b',
    textMuted: '#047857',
    textDark: '#064e3b',
    accent: '#059669',
    gold: '#fef3c7',
    signature: '#ecfdf5',
    signatureBorder: '#a7f3d0',
    footerText: '#d1fae5',
};

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Celebration-themed reward approval email for employees and stakeholders.
 */
export function buildRewardApprovedEmailHtml({
    employeeFirstName = '',
    employeeLastName = '',
    rewardType = '',
    title = '',
    amount = null,
    hasOriginalAttachment = false,
    showAccountsNote = false,
} = {}) {
    const employeeName = `${employeeFirstName} ${employeeLastName}`.trim() || 'Team Member';
    const safeEmployeeName = escapeHtml(employeeName);
    const safeRewardType = escapeHtml(rewardType);
    const safeTitle = escapeHtml(title);
    const amountValue = Number(amount || 0);
    const amountBlock =
        amountValue > 0
            ? `<p style="margin:0 0 18px;color:${THEME.text};font-size:16px;">
                Amount: <strong style="color:${THEME.accent};">AED ${amountValue.toLocaleString()}</strong>
               </p>`
            : '';

    const attachmentNote = hasOriginalAttachment
        ? 'reward certificate and original documentation'
        : 'reward certificate';

    const accountsNote = showAccountsNote
        ? `<p style="margin:0 0 18px;color:${THEME.text};">
             Accounts will complete the remaining payment steps shortly. You will receive another update once everything is finalized.
           </p>`
        : `<p style="margin:0 0 18px;color:${THEME.text};">
             Please find the ${attachmentNote} attached to this email.
           </p>`;

    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Reward Approved</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    @keyframes floatUp {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }
    @keyframes sparkle {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.08); opacity: 0.92; }
    }
    .float { display: inline-block; animation: floatUp 3s ease-in-out infinite; font-size: 28px; line-height: 1; }
    .float-2 { animation-delay: 0.45s; }
    .float-3 { animation-delay: 0.9s; }
    .trophy { display: inline-block; animation: sparkle 2.2s ease-in-out infinite; font-size: 48px; line-height: 1; }
  </style>
</head>
<body bgcolor="${THEME.page}" style="margin:0;padding:0;background-color:${THEME.page} !important;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${THEME.page}" style="width:100%;background-color:${THEME.page} !important;margin:0;padding:0;">
    <tr>
      <td align="center" bgcolor="${THEME.page}" style="background-color:${THEME.page} !important;padding:28px 12px;">
        <table role="presentation" width="660" cellspacing="0" cellpadding="0" border="0" bgcolor="${THEME.white}" style="width:100%;max-width:660px;background-color:${THEME.white};border:1px solid ${THEME.signatureBorder};">

          <tr>
            <td align="center" bgcolor="${THEME.hero}" style="background-color:${THEME.hero} !important;padding:0;">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:660px;height:240px;">
                <v:fill type="tile" color="${THEME.hero}" />
                <v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0">
              <![endif]-->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${THEME.hero}" style="background-color:${THEME.hero} !important;">
                <tr>
                  <td align="center" bgcolor="${THEME.hero}" style="background-color:${THEME.hero} !important;padding:34px 28px 26px;text-align:center;">
                    <div style="margin-bottom:10px;line-height:1;">
                      <span class="float" style="font-size:28px;">🎉</span>
                      <span class="float float-2" style="font-size:28px;">🏆</span>
                      <span class="float float-3" style="font-size:28px;">✨</span>
                    </div>
                    <div style="margin:8px 0 14px;line-height:1;">
                      <span class="trophy">🥇</span>
                    </div>
                    <h1 style="margin:0;font-size:30px;font-weight:800;color:#ffffff;mso-line-height-rule:exactly;line-height:36px;">
                      Congratulations!
                    </h1>
                    <p style="margin:12px 0 0;font-size:16px;color:${THEME.gold};font-weight:600;mso-line-height-rule:exactly;line-height:22px;">
                      Your reward has been approved
                    </p>
                    <p style="margin:14px 0 0;font-size:18px;line-height:1;color:#ffffff;">⭐ 🌟 ⭐</p>
                  </td>
                </tr>
              </table>
              <!--[if gte mso 9]>
                </v:textbox>
              </v:rect>
              <![endif]-->
            </td>
          </tr>

          <tr>
            <td align="center" bgcolor="${THEME.white}" style="background-color:${THEME.white} !important;padding:0 36px 8px;text-align:center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" bgcolor="${THEME.badge}" style="background-color:${THEME.badge} !important;margin-top:-20px;border-radius:999px;border:3px solid ${THEME.white};">
                <tr>
                  <td align="center" bgcolor="${THEME.badge}" style="background-color:${THEME.badge} !important;padding:12px 28px;border-radius:999px;">
                    <p style="margin:0;font-size:17px;font-weight:700;color:#ffffff;mso-line-height-rule:exactly;line-height:24px;">
                      🎊 ${safeEmployeeName} 🎊
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td bgcolor="${THEME.white}" style="background-color:${THEME.white} !important;padding:24px 40px 12px;color:${THEME.text};font-size:15px;line-height:1.8;mso-line-height-rule:exactly;">
              <p style="margin:0 0 18px;color:${THEME.text};">
                Dear All,
              </p>
              <p style="margin:0 0 18px;color:${THEME.text};">
                We are delighted to share that the reward request for
                <strong style="color:${THEME.accent};">${safeEmployeeName}</strong>
                has been <strong style="color:${THEME.accent};">approved</strong>.
              </p>
              <p style="margin:0 0 18px;color:${THEME.text};">
                <strong>Reward type:</strong> ${safeRewardType || '—'}${safeTitle ? `<br/><strong>Title:</strong> ${safeTitle}` : ''}
              </p>
              ${amountBlock}
              ${accountsNote}
              <p style="margin:0 0 8px;font-weight:600;color:${THEME.accent};">
                Thank you for your dedication and outstanding contribution. 🎉
              </p>
            </td>
          </tr>

          <tr>
            <td bgcolor="${THEME.white}" style="background-color:${THEME.white} !important;padding:8px 40px 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td height="3" bgcolor="${THEME.signatureBorder}" style="background-color:${THEME.signatureBorder} !important;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td bgcolor="${THEME.white}" style="background-color:${THEME.white} !important;padding:0 40px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${THEME.signature}" style="background-color:${THEME.signature} !important;border:1px solid ${THEME.signatureBorder};">
                <tr>
                  <td align="center" bgcolor="${THEME.signature}" style="background-color:${THEME.signature} !important;padding:22px 24px;text-align:center;">
                    <p style="margin:0 0 6px;font-size:14px;color:${THEME.textMuted};">Warm regards,</p>
                    <p style="margin:0;font-size:17px;font-weight:800;color:${THEME.textDark};">Management Team</p>
                    <p style="margin:6px 0 0;font-size:14px;color:${THEME.accent};font-weight:600;">Vega Digital IT Solution LLC</p>
                    <p style="margin:14px 0 0;font-size:24px;line-height:1;">🏆 🎉 ✨</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="center" bgcolor="${THEME.footer}" style="background-color:${THEME.footer} !important;padding:0;">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:660px;height:60px;">
                <v:fill type="tile" color="${THEME.footer}" />
                <v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0">
              <![endif]-->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${THEME.footer}" style="background-color:${THEME.footer} !important;">
                <tr>
                  <td align="center" bgcolor="${THEME.footer}" style="background-color:${THEME.footer} !important;padding:18px 28px 22px;text-align:center;">
                    <p style="margin:0;font-size:12px;color:${THEME.footerText};mso-line-height-rule:exactly;line-height:18px;">
                      Celebrating excellence at Vega Digital · Keep up the great work! 🌟
                    </p>
                  </td>
                </tr>
              </table>
              <!--[if gte mso 9]>
                </v:textbox>
              </v:rect>
              <![endif]-->
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

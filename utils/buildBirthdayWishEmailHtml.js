/** Brand violet palette — solid hex only (gradients are stripped by Outlook / some Gmail). */
const VIOLET = {
    page: "#f3e8ff",
    hero: "#7c3aed",
    heroDark: "#6d28d9",
    footer: "#5b21b6",
    badge: "#7c3aed",
    signature: "#faf5ff",
    signatureBorder: "#e9d5ff",
    white: "#ffffff",
    text: "#1e293b",
    textMuted: "#6b21a8",
    textDark: "#4c1d95",
    accent: "#7c3aed",
    footerText: "#e9d5ff",
    gold: "#fef3c7",
};

/**
 * Celebration birthday email — bulletproof violet backgrounds for Outlook, Gmail, Apple Mail, etc.
 * Uses bgcolor + inline background-color + MSO VML on hero/footer.
 */
export const buildBirthdayWishEmailHtml = (employeeName) => {
    const safeName = String(employeeName || "there")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>Happy Birthday!</title>
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
      50% { transform: translateY(-12px); }
    }
    @keyframes bounce {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.1); }
    }
    .balloon { display: inline-block; animation: floatUp 3s ease-in-out infinite; font-size: 30px; line-height: 1; }
    .balloon-2 { animation-delay: 0.5s; }
    .balloon-3 { animation-delay: 1s; }
    .cake { display: inline-block; animation: bounce 2s ease-in-out infinite; font-size: 52px; line-height: 1; }
  </style>
</head>
<body bgcolor="${VIOLET.page}" style="margin:0;padding:0;background-color:${VIOLET.page} !important;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <!-- Full-page violet wash (Outlook reads bgcolor on outer table) -->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${VIOLET.page}" style="width:100%;background-color:${VIOLET.page} !important;margin:0;padding:0;">
    <tr>
      <td align="center" bgcolor="${VIOLET.page}" style="background-color:${VIOLET.page} !important;padding:28px 12px;">
        <table role="presentation" width="660" cellspacing="0" cellpadding="0" border="0" bgcolor="${VIOLET.white}" style="width:100%;max-width:660px;background-color:${VIOLET.white};border:1px solid ${VIOLET.signatureBorder};">

          <!-- HERO — solid violet + VML for Outlook -->
          <tr>
            <td align="center" bgcolor="${VIOLET.hero}" style="background-color:${VIOLET.hero} !important;padding:0;">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:660px;height:260px;">
                <v:fill type="tile" color="${VIOLET.hero}" />
                <v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0">
              <![endif]-->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${VIOLET.hero}" style="background-color:${VIOLET.hero} !important;">
                <tr>
                  <td align="center" bgcolor="${VIOLET.hero}" style="background-color:${VIOLET.hero} !important;padding:36px 28px 28px;text-align:center;">
                    <div style="margin-bottom:10px;line-height:1;">
                      <span class="balloon" style="font-size:30px;">🎈</span>
                      <span class="balloon balloon-2" style="font-size:30px;">🎉</span>
                      <span class="balloon balloon-3" style="font-size:30px;">🎊</span>
                    </div>
                    <div style="margin:8px 0 14px;line-height:1;">
                      <span class="cake">🎂</span>
                    </div>
                    <h1 style="margin:0;font-size:32px;font-weight:800;color:#ffffff;mso-line-height-rule:exactly;line-height:38px;">
                      Happy Birthday!
                    </h1>
                    <p style="margin:12px 0 0;font-size:16px;color:${VIOLET.gold};font-weight:600;mso-line-height-rule:exactly;line-height:22px;">
                      Celebrating you today ✨
                    </p>
                    <p style="margin:16px 0 0;font-size:20px;line-height:1;color:#ffffff;">✨ 🌟 ✨</p>
                  </td>
                </tr>
              </table>
              <!--[if gte mso 9]>
                </v:textbox>
              </v:rect>
              <![endif]-->
            </td>
          </tr>

          <!-- Name badge -->
          <tr>
            <td align="center" bgcolor="${VIOLET.white}" style="background-color:${VIOLET.white} !important;padding:0 36px 8px;text-align:center;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" bgcolor="${VIOLET.badge}" style="background-color:${VIOLET.badge} !important;margin-top:-20px;border-radius:999px;border:3px solid ${VIOLET.white};">
                <tr>
                  <td align="center" bgcolor="${VIOLET.badge}" style="background-color:${VIOLET.badge} !important;padding:12px 28px;border-radius:999px;">
                    <p style="margin:0;font-size:18px;font-weight:700;color:#ffffff;mso-line-height-rule:exactly;line-height:24px;">
                      🎁 Dear ${safeName} 🎁
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td bgcolor="${VIOLET.white}" style="background-color:${VIOLET.white} !important;padding:24px 40px 12px;color:${VIOLET.text};font-size:15px;line-height:1.8;mso-line-height-rule:exactly;">
              <p style="margin:0 0 18px;color:${VIOLET.text};">
                Warmest birthday wishes from all of us at <strong style="color:${VIOLET.accent};">Vega Digital IT Solution</strong>.
              </p>
              <p style="margin:0 0 18px;color:${VIOLET.text};">
                On this special day, we want to take a moment to appreciate the dedication, professionalism, and positive spirit you bring to our team. Your contributions make a meaningful difference, and we are truly grateful to have you as part of the Vega Digital family.
              </p>
              <p style="margin:0 0 18px;color:${VIOLET.text};">
                May the year ahead bring you new achievements, personal growth, and continued success. We hope your day is filled with joy, good memories, and the company of the people who matter most to you.
              </p>
              <p style="margin:0 0 8px;font-weight:600;color:${VIOLET.accent};">
                Wishing you a wonderful birthday and a prosperous year ahead. 🎉
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td bgcolor="${VIOLET.white}" style="background-color:${VIOLET.white} !important;padding:8px 40px 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td height="3" bgcolor="${VIOLET.signatureBorder}" style="background-color:${VIOLET.signatureBorder} !important;font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Signature card -->
          <tr>
            <td bgcolor="${VIOLET.white}" style="background-color:${VIOLET.white} !important;padding:0 40px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${VIOLET.signature}" style="background-color:${VIOLET.signature} !important;border:1px solid ${VIOLET.signatureBorder};">
                <tr>
                  <td align="center" bgcolor="${VIOLET.signature}" style="background-color:${VIOLET.signature} !important;padding:22px 24px;text-align:center;">
                    <p style="margin:0 0 6px;font-size:14px;color:${VIOLET.textMuted};">Warm regards,</p>
                    <p style="margin:0;font-size:17px;font-weight:800;color:${VIOLET.textDark};">Vega Digital IT Solution LLC</p>
                    <p style="margin:6px 0 0;font-size:14px;color:${VIOLET.accent};font-weight:600;">Human Resources Department</p>
                    <p style="margin:14px 0 0;font-size:24px;line-height:1;">🎂 🎈 🎊</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- FOOTER — solid deep violet + VML -->
          <tr>
            <td align="center" bgcolor="${VIOLET.footer}" style="background-color:${VIOLET.footer} !important;padding:0;">
              <!--[if gte mso 9]>
              <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:660px;height:60px;">
                <v:fill type="tile" color="${VIOLET.footer}" />
                <v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0">
              <![endif]-->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${VIOLET.footer}" style="background-color:${VIOLET.footer} !important;">
                <tr>
                  <td align="center" bgcolor="${VIOLET.footer}" style="background-color:${VIOLET.footer} !important;padding:18px 28px 22px;text-align:center;">
                    <p style="margin:0;font-size:12px;color:${VIOLET.footerText};mso-line-height-rule:exactly;line-height:18px;">
                      Sent with celebration from the Vega Digital family · Have an amazing day! 🌟
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
};

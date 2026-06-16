/**
 * Cute, animated birthday email HTML (CSS animations work in Apple Mail, Gmail web, etc.;
 * Outlook shows a static but still polished layout).
 */
export const buildBirthdayWishEmailHtml = (employeeName) => {
    const safeName = String(employeeName || "there")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Happy Birthday!</title>
  <style>
    @keyframes floatUp {
      0%, 100% { transform: translateY(0) rotate(-2deg); }
      50% { transform: translateY(-14px) rotate(2deg); }
    }
    @keyframes bounce {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.12); }
    }
    @keyframes sparkle {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1.15); }
    }
    @keyframes confettiFall {
      0% { transform: translateY(-8px) rotate(0deg); opacity: 0.9; }
      100% { transform: translateY(18px) rotate(180deg); opacity: 0.2; }
    }
    @keyframes rainbowShift {
      0% { background-position: 0% 50%; }
      50% { background-position: 100% 50%; }
      100% { background-position: 0% 50%; }
    }
    .balloon { display: inline-block; animation: floatUp 3s ease-in-out infinite; font-size: 28px; }
    .balloon-2 { animation-delay: 0.4s; }
    .balloon-3 { animation-delay: 0.8s; }
    .cake { display: inline-block; animation: bounce 1.8s ease-in-out infinite; font-size: 52px; line-height: 1; }
    .sparkle { display: inline-block; animation: sparkle 2s ease-in-out infinite; }
    .sparkle-2 { animation-delay: 0.6s; }
    .sparkle-3 { animation-delay: 1.2s; }
    .confetti-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      animation: confettiFall 2.4s ease-in-out infinite;
    }
    .hero-band {
      background: linear-gradient(120deg, #ff9a9e, #fecfef, #fad0c4, #ffecd2, #fcb69f);
      background-size: 300% 300%;
      animation: rainbowShift 8s ease infinite;
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#fff5f8;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#fff5f8;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 12px 40px rgba(255,105,180,0.18);border:1px solid #ffe0ec;">
          <tr>
            <td class="hero-band" style="padding:28px 24px 20px;text-align:center;">
              <div style="margin-bottom:8px;">
                <span class="balloon">🎈</span>
                <span class="balloon balloon-2">🎉</span>
                <span class="balloon balloon-3">🎈</span>
              </div>
              <div style="margin:6px 0 10px;">
                <span class="cake">🎂</span>
              </div>
              <h1 style="margin:0;font-size:28px;color:#5c2d82;letter-spacing:0.3px;">Happy Birthday!</h1>
              <p style="margin:10px 0 0;font-size:15px;color:#7a3e9d;font-weight:600;">A little sparkle just for you ✨</p>
              <div style="margin-top:14px;line-height:0;">
                <span class="sparkle" style="font-size:18px;">✨</span>
                <span class="confetti-dot" style="background:#ff6b9d;margin:0 4px;"></span>
                <span class="confetti-dot" style="background:#ffd166;margin:0 4px;animation-delay:0.3s;"></span>
                <span class="confetti-dot" style="background:#6bcbff;margin:0 4px;animation-delay:0.6s;"></span>
                <span class="sparkle sparkle-2" style="font-size:18px;">💖</span>
                <span class="confetti-dot" style="background:#b388ff;margin:0 4px;animation-delay:0.9s;"></span>
                <span class="sparkle sparkle-3" style="font-size:18px;">✨</span>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 32px 12px;color:#3d3d3d;font-size:15px;line-height:1.75;">
              <p style="margin:0 0 16px;">Dear <strong style="color:#c2185b;">${safeName}</strong>,</p>
              <p style="margin:0 0 16px;">
                Warmest birthday wishes from all of us in the <strong>HR Department</strong>. We hope your special day brings you joy, positivity, and moments that make you feel appreciated.
              </p>
              <p style="margin:0 0 16px;">
                Your dedication, hard work, and positive attitude contribute greatly to our workplace, and we are truly grateful to have you as part of our team.
              </p>
              <p style="margin:0 0 16px;">
                May the year ahead be filled with success, good health, and new opportunities.
              </p>
              <p style="margin:0 0 8px;font-weight:600;color:#5c2d82;">Enjoy your day to the fullest. 🎁</p>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 28px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:linear-gradient(135deg,#fff0f6,#f3e8ff);border-radius:14px;border:1px dashed #e9b8ff;">
                <tr>
                  <td style="padding:18px 20px;text-align:center;">
                    <p style="margin:0;font-size:14px;color:#6b4c8a;">With warm regards,</p>
                    <p style="margin:6px 0 0;font-size:16px;font-weight:700;color:#7b2cbf;">HR Department</p>
                    <p style="margin:10px 0 0;font-size:22px;line-height:1;">🌸 🎊 🌟</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px 20px;text-align:center;background:#faf5ff;border-top:1px solid #f3e5f5;">
              <p style="margin:0;font-size:12px;color:#9b8ab8;">Sent with love from the VeRP HR team · Vega Digital</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

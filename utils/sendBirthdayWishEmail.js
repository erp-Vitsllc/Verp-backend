import nodemailer from "nodemailer";
import { buildBirthdayWishEmailHtml } from "./buildBirthdayWishEmailHtml.js";

const createTransporter = () => {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) return null;
    return nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass },
    });
};

const dedupeEmails = (emails = []) => {
    const seen = new Set();
    return emails
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .filter((e) => {
            const key = e.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
};

/**
 * @param {{ employeeName: string, personalEmail?: string|null }} params
 * @returns {Promise<{ sent: boolean, recipients: string[] }>}
 */
export const sendBirthdayWishEmail = async ({ employeeName, personalEmail }) => {
    const transporter = createTransporter();
    if (!transporter) {
        console.error("[BirthdayWish] Email credentials are not configured.");
        return { sent: false, recipients: [] };
    }

    const recipients = dedupeEmails([personalEmail]);
    if (!recipients.length) {
        console.warn(`[BirthdayWish] No personal email for ${employeeName || "employee"} — skipped.`);
        return { sent: false, recipients: [] };
    }

    const subject = `Happy Birthday, ${String(employeeName || "there").trim()}! 🎂`;
    const html = buildBirthdayWishEmailHtml(employeeName);

    await transporter.sendMail({
        fromName: "HR Department",
        to: recipients.join(","),
        subject,
        html,
    });

    return { sent: true, recipients };
};

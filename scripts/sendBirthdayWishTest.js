import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { setupEmailSubjectTag } from "../utils/setupEmailSubjectTag.js";
import { sendBirthdayWishEmail } from "../utils/sendBirthdayWishEmail.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

setupEmailSubjectTag();

const name = process.argv[2] || "Razan";
const email = process.argv[3] || "razan.docs@gmail.com";

const result = await sendBirthdayWishEmail({
    employeeName: name,
    personalEmail: email,
});

if (result.sent) {
    const ccLine = result.cc?.length ? ` (cc: ${result.cc.join(", ")})` : "";
    console.log(`[BirthdayWish Test] Sent to ${result.recipients.join(", ")}${ccLine} for ${name}`);
} else {
    console.error("[BirthdayWish Test] Failed to send — check EMAIL_USER / EMAIL_PASS in .env");
    process.exit(1);
}

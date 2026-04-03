import nodemailer from "nodemailer";
import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import { generatePdf } from "./generatePdf.js";
import { buildResponsibilityEmailData } from "./flowchartResponsibilityEmailData.js";

/**
 * Notify the old/current holder when a reassignment request is accepted/rejected.
 * - On Reject: attach a PDF inventory preview (unassigned + parking + accessories under each asset).
 * - On Accept: send email without attachment (PDF optional / can be added later).
 */
export async function sendFlowchartReassignmentResultEmail(req, { category, action, oldSnapshot }) {
    if (!oldSnapshot) return;

    const cat = (category || "").toLowerCase().replace(/\s+/g, "");
    const act = action === "Approve" ? "approved" : "rejected";

    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        console.error("[Flowchart Result Email] Email credentials missing");
        return;
    }

    // Resolve old holder employee record
    let oldEmp = null;
    try {
        if (oldSnapshot.empObjectId) {
            oldEmp = await EmployeeBasic.findById(oldSnapshot.empObjectId).select(
                "employeeId firstName lastName companyEmail email workEmail personalEmail"
            ).lean();
        }
        if (!oldEmp && oldSnapshot.employeeId) {
            oldEmp = await EmployeeBasic.findOne({ employeeId: oldSnapshot.employeeId }).select(
                "employeeId firstName lastName companyEmail email workEmail personalEmail"
            ).lean();
        }
    } catch {
        oldEmp = null;
    }

    const recipientEmail =
        (oldEmp?.companyEmail || oldEmp?.email || oldEmp?.workEmail || oldEmp?.personalEmail || "").trim() ||
        (oldSnapshot.email || oldSnapshot.companyEmail || "").trim() ||
        null;

    if (!recipientEmail) {
        console.warn("[Flowchart Result Email] No email for old holder");
        return;
    }

    const oldName =
        `${oldEmp?.firstName || ""} ${oldEmp?.lastName || ""}`.trim() ||
        oldSnapshot.employeeName ||
        "Previous holder";

    const data = await buildResponsibilityEmailData(category);

    const limitAssets = 6;
    const limitAccessories = 8;

    const assetToHtml = (a, includeAccessories) => {
        const accs = (Array.isArray(a.accessories) ? a.accessories : []).slice(0, limitAccessories);
        const accHtml = includeAccessories
            ? accs.length
                ? `<ul style="margin:6px 0 0 18px;padding:0;">${accs.map((acc) => {
                    const n = acc?.name || "Accessory";
                    const st = acc?.status ? ` — ${acc.status}` : "";
                    const id = acc?.accessoryId ? ` (${acc.accessoryId})` : "";
                    return `<li style="margin:2px 0; font-size:13px; color:#334155;"><strong>${n}</strong>${id}${st}</li>`;
                }).join("")}</ul>`
                : `<div style="margin:6px 0 0 0; font-size:12px; color:#94a3b8;">No accessories on this asset</div>`
            : "";

        return `
            <div style="margin:10px 0; padding:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">
                <div style="font-weight:bold; color:#0f172a; font-size:14px;">${a.assetId} — ${a.name}</div>
                ${a.status ? `<div style="font-size:12px; color:#64748b; margin-top:3px;">Status: ${a.status}</div>` : ""}
                ${accHtml}
            </div>
        `;
    };

    let roleHtml = "";
    if (cat === "hr") {
        roleHtml = `
            <div style="margin-top:16px; padding:14px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#1e3a8a;">HR role overview</p>
                <ul style="margin:0 0 0 18px; padding:0;">
                    ${(data.hrBullets || []).slice(0, 8).map((b) => `<li style="margin:4px 0; font-size:13px; color:#1f2937;">${b}</li>`).join("")}
                </ul>
            </div>
            <div style="margin-top:12px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#334155; font-size:13px;">Company assets preview</p>
                ${(data.companyAssets || []).slice(0, limitAssets).map((a) => assetToHtml(a, false)).join("")}
            </div>
        `;
    }

    if (cat === "assetcontroller") {
        roleHtml = `
            <div style="margin-top:16px; padding:14px; background:#fffbeb; border:1px solid #fcd34d; border-radius:10px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#92400e;">Asset Controller inventory preview</p>
                <p style="margin:0; font-size:13px; color:#78350f;">Unassigned pool and parking are separated. Accessories are shown under each asset.</p>
            </div>
            <div style="margin-top:12px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#334155; font-size:13px;">Unassigned / pool</p>
                ${(data.unassignedAssets || []).slice(0, limitAssets).map((a) => assetToHtml(a, true)).join("")}
            </div>
            <div style="margin-top:12px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#334155; font-size:13px;">Parking / On Leave</p>
                ${(data.parkingAssets || []).slice(0, limitAssets).map((a) => assetToHtml(a, true)).join("")}
            </div>
        `;
    }

    let pdfBuffer = null;
    const attachments = [];
    if (action === "Reject") {
        // Attach a PDF snapshot of inventory preview for the old holder.
        try {
            const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/'/g, "");
            const baseUrl = frontendUrl.replace(/\/$/, "");
            const previewAs = oldSnapshot.empObjectId ? String(oldSnapshot.empObjectId) : "";
            const printUrl = `${baseUrl}/print/flowchart-position-assets/${encodeURIComponent(cat)}?previewAs=${encodeURIComponent(previewAs)}`;

            const token = req.headers.authorization?.split(" ")[1] || "";
            const requestingUserId = req.user?.id;
            const userObj = await User.findById(requestingUserId);
            const userPayload = {
                id: requestingUserId,
                isAdmin: userObj?.isAdmin || userObj?.role === "Admin" || userObj?.role === "ROOT",
                role: userObj?.role,
                employeeId: userObj?.employeeId
            };

            pdfBuffer = await generatePdf(
                printUrl,
                token,
                userPayload,
                {},
                '#flowchart-inventory-container[data-ready="true"]'
            );

            if (Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
                const safeStem = `${cat}-${(oldSnapshot.employeeId || oldSnapshot.employeeName || "holder").toString().replace(/[^\\w.-]+/g, "_")}`;
                attachments.push({
                    filename: `Flowchart-${safeStem}-Inventory.pdf`,
                    content: pdfBuffer
                });
            }
        } catch (pdfErr) {
            console.error("[Flowchart Result Email] PDF generation failed:", pdfErr?.message || pdfErr);
        }
    }

    const subject = `Flowchart ${cat} request ${act} — notification for ${oldName}`;
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
            <div style="background-color:#0ea5e9; color:white; padding:26px; text-align:center;">
                <h1 style="margin:0; font-size:20px;">Flowchart Update</h1>
            </div>
            <div style="padding:28px;">
                <p style="font-size:15px; margin:0 0 12px 0;">Hello <strong>${oldName}</strong>,</p>
                <p style="font-size:14px; color:#334155; margin:0 0 14px 0;">
                    Your <strong>${cat}</strong> responsibility reassignment request was <strong>${act}</strong>.
                </p>
                ${roleHtml}
                ${action === "Reject" ? `<p style="font-size:13px; color:#64748b; margin:14px 0 0 0;">The inventory preview is attached as a PDF.</p>` : ``}
            </div>
            <div style="background-color:#f8fafc; padding:16px; text-align:center; font-size:12px; color:#64748b; border-top:1px solid #e2e8f0;">
                <p style="margin:0;">Automated notification from VeRP</p>
            </div>
        </div>
    `;

    const transporter = nodemailer.createTransport({
        host: "smtp.office365.com",
        port: 587,
        secure: false,
        auth: { user: emailUser, pass: emailPass }
    });

    await transporter.sendMail({
        from: `"VeRP System" <${emailUser}>`,
        to: recipientEmail,
        subject,
        html,
        attachments
    });
}


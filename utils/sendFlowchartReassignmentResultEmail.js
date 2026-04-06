import nodemailer from "nodemailer";
import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import { generatePdf } from "./generatePdf.js";
import { buildResponsibilityEmailData } from "./flowchartResponsibilityEmailData.js";
import { buildAssetControllerHandoverOutcomePdfAttachment } from "./generateBulkAssetInventoryPdf.js";

/**
 * Notify the previous role holder when a reassignment request is accepted or rejected.
 * - Asset Controller + Approve: success email + PDF with “kept open / on leave” vs “assigned back to you”.
 * - Asset Controller + Reject: you stay in the role; PDF inventory snapshot attached.
 * - Other roles: existing preview HTML; PDF on reject (print route), optional narrative on approve.
 */
export async function sendFlowchartReassignmentResultEmail(
    req,
    {
        category,
        action,
        oldSnapshot,
        invitedCandidateName = "",
        assetControllerOutcome = null
    }
) {
    if (!oldSnapshot) return;

    const cat = (category || "").toLowerCase().replace(/\s+/g, "");
    const act = action === "Approve" ? "approved" : "rejected";
    const candidate = (invitedCandidateName || "").trim() || "the invited person";

    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.trim();
    if (!emailUser || !emailPass) {
        console.error("[Flowchart Result Email] Email credentials missing");
        return;
    }

    let oldEmp = null;
    try {
        if (oldSnapshot.empObjectId) {
            oldEmp = await EmployeeBasic.findById(oldSnapshot.empObjectId)
                .select("employeeId firstName lastName companyEmail email workEmail personalEmail")
                .lean();
        }
        if (!oldEmp && oldSnapshot.employeeId) {
            oldEmp = await EmployeeBasic.findOne({ employeeId: oldSnapshot.employeeId })
                .select("employeeId firstName lastName companyEmail email workEmail personalEmail")
                .lean();
        }
    } catch {
        oldEmp = null;
    }

    const recipientEmail =
        (oldEmp?.companyEmail || oldEmp?.email || oldEmp?.workEmail || oldEmp?.personalEmail || "").trim() ||
        (oldSnapshot.email || oldSnapshot.companyEmail || "").trim() ||
        null;

    if (!recipientEmail) {
        console.warn("[Flowchart Result Email] No email for previous holder");
        return;
    }

    const oldName =
        `${oldEmp?.firstName || ""} ${oldEmp?.lastName || ""}`.trim() || oldSnapshot.employeeName || "there";

    const data = await buildResponsibilityEmailData(category);

    const limitAssets = 6;
    const limitAccessories = 8;

    const assetToHtml = (a, includeAccessories) => {
        const accs = (Array.isArray(a.accessories) ? a.accessories : []).slice(0, limitAccessories);
        const accHtml = includeAccessories
            ? accs.length
                ? `<ul style="margin:6px 0 0 18px;padding:0;">${accs
                      .map((acc) => {
                          const n = acc?.name || "Accessory";
                          const st = acc?.status ? ` — ${acc.status}` : "";
                          const id = acc?.accessoryId ? ` (${acc.accessoryId})` : "";
                          return `<li style="margin:2px 0; font-size:13px; color:#334155;"><strong>${n}</strong>${id}${st}</li>`;
                      })
                      .join("")}</ul>`
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
            <div style="margin-top:16px; padding:14px; background:#ecfdf5; border:1px solid #86efac; border-radius:10px;">
                <p style="margin:0 0 8px 0; font-weight:bold; color:#14532d;">Asset Controller — quick preview</p>
                <p style="margin:0; font-size:13px; color:#166534;">Open items and on-leave items (summary below). Full detail is in the attached PDF.</p>
            </div>
            <div style="margin-top:12px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#334155; font-size:13px;">On leave</p>
                ${(data.parkingAssets || []).slice(0, limitAssets).map((a) => assetToHtml(a, true)).join("")}
            </div>
            <div style="margin-top:12px;">
                <p style="margin:0 0 10px 0; font-weight:bold; color:#334155; font-size:13px;">Not assigned to a person</p>
                ${(data.unassignedAssets || []).slice(0, limitAssets).map((a) => assetToHtml(a, true)).join("")}
            </div>
        `;
    }

    const attachments = [];

    if (cat === "assetcontroller" && action === "Approve") {
        const kept = assetControllerOutcome?.keptIds || [];
        const reassigned = assetControllerOutcome?.reassignedIds || [];
        try {
            const att = await buildAssetControllerHandoverOutcomePdfAttachment(kept, reassigned);
            attachments.push(...att);
        } catch (pdfErr) {
            console.error("[Flowchart Result Email] Asset controller outcome PDF failed:", pdfErr?.message || pdfErr);
        }
        if (attachments.length === 0) {
            console.error("[Flowchart Result Email] Approve email for asset controller has no PDF attachment — check PDF service.");
        }
    } else if (action === "Reject") {
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

            const pdfBuffer = await generatePdf(printUrl, token, userPayload, {}, '#flowchart-inventory-container[data-ready="true"]');

            if (Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 0) {
                const safeStem = `${cat}-${(oldSnapshot.employeeId || oldSnapshot.employeeName || "holder")
                    .toString()
                    .replace(/[^\w.-]+/g, "_")}`;
                attachments.push({
                    filename: `Flowchart-${safeStem}-Inventory.pdf`,
                    content: pdfBuffer
                });
            }
        } catch (pdfErr) {
            console.error("[Flowchart Result Email] PDF generation failed:", pdfErr?.message || pdfErr);
        }
    }

    let introBlock = "";
    let subject = `Flowchart ${cat} request ${act} — ${oldName}`;

    if (cat === "assetcontroller" && action === "Approve") {
        subject = `Asset Controller handover approved — ${oldName}`;
        const nk = assetControllerOutcome?.keptIds?.length ?? 0;
        const nr = assetControllerOutcome?.reassignedIds?.length ?? 0;
        introBlock = `
            <p style="font-size:14px; color:#334155; margin:0 0 12px 0;">
                Your request to hand the <strong>Asset Controller</strong> role to <strong>${candidate}</strong> was <strong style="color:#15803d;">approved</strong>.
                ${candidate} is now the Asset Controller.
            </p>
            <div style="margin:16px 0; padding:14px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px;">
                <p style="margin:0 0 8px 0; font-weight:bold; color:#14532d; font-size:13px;">What was decided about open and on-leave items</p>
                <ul style="margin:0; padding-left:18px; font-size:13px; color:#166534; line-height:1.5;">
                    <li><strong>Accepted by the new controller (${nk} item${nk === 1 ? "" : "s"}):</strong> </li>
                    <li><strong>Returned to you (${nr} item${nr === 1 ? "" : "s"}):</strong> </li>
                </ul>
            </div>
            <p style="font-size:13px; color:#475569; margin:0 0 8px 0;">
                <strong>Conclusion:</strong> Before the role changed, ${candidate} chose which items to keep under the shared open / on-leave lists and which to hand back to you. Item-by-item detail is in the attached PDF.
            </p>
            <p style="font-size:13px; color:#64748b; margin:0;"><strong>Attachment:</strong> PDF listing both groups (accepted list and returned-to-you list).</p>
        `;
    } else if (cat === "assetcontroller" && action === "Reject") {
        subject = `Asset Controller change declined — you remain in the role`;
        introBlock = `
            <p style="font-size:14px; color:#334155; margin:0 0 12px 0;">
                Hello <strong>${oldName}</strong>,
            </p>
            <p style="font-size:14px; color:#334155; margin:0 0 12px 0;">
                <strong>${candidate}</strong> did <strong>not</strong> take the <strong>Asset Controller</strong> role. <strong>You remain the Asset Controller</strong> — nothing changed in your position.
            </p>
            <p style="font-size:13px; color:#475569; margin:0 0 8px 0;">
                The handover request was declined. Your flowchart assignment is unchanged.
            </p>
            <p style="font-size:13px; color:#64748b; margin:0;">A PDF inventory snapshot is attached for your records.</p>
        `;
    } else {
        introBlock = `
            <p style="font-size:15px; margin:0 0 12px 0;">Hello <strong>${oldName}</strong>,</p>
            <p style="font-size:14px; color:#334155; margin:0 0 14px 0;">
                Your <strong>${cat}</strong> responsibility reassignment request was <strong>${act}</strong>.
            </p>
        `;
    }

    const pdfNoteOther =
        action === "Reject" && cat !== "assetcontroller"
            ? `<p style="font-size:13px; color:#64748b; margin:14px 0 0 0;">An inventory preview is attached as a PDF.</p>`
            : "";

    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
            <div style="background-color:#0ea5e9; color:white; padding:26px; text-align:center;">
                <h1 style="margin:0; font-size:20px;">${cat === "assetcontroller" && action === "Approve" ? "Handover approved" : cat === "assetcontroller" && action === "Reject" ? "Handover declined" : "Flowchart update"}</h1>
            </div>
            <div style="padding:28px;">
                ${cat === "assetcontroller" && action === "Approve" ? `<p style="font-size:15px; margin:0 0 4px 0;">Hello <strong>${oldName}</strong>,</p>` : ""}
                ${introBlock}
                ${cat === "assetcontroller" ? "" : roleHtml}
                ${pdfNoteOther}
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

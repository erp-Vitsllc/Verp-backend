import nodemailer from "nodemailer";
import {
    buildAssetControllerResponsibilityPdfAttachment,
    buildCompanyAssetsResponsibilityPdfAttachment
} from "./generateBulkAssetInventoryPdf.js";

function listHtml(title, items, mapLine) {
    if (!items || items.length === 0) {
        return `<p style="margin:12px 0 0 0;color:#64748b;font-size:13px;"><em>No items in this list at the moment.</em></p>`;
    }
    return `
        <div style="margin-top:12px;padding:16px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="font-weight:bold;margin:0 0 8px 0;">${title}</p>
            <ul style="padding-left:18px;margin:0;font-size:13px;">
                ${items.slice(0, 35).map(mapLine).join("")}
            </ul>
            ${items.length > 35 ? `<p style="margin:8px 0 0 0;font-size:12px;color:#64748b;">…and ${items.length - 35} more</p>` : ""}
        </div>`;
}

export const sendResponsibilityApprovalEmail = async ({
    employee,
    companyName,
    category,
    requestId,
    /** Prefer this for dashboard deep links — matches `id` on `GET .../dashboard/user-stats` items (e.g. Flowchart or Company _id). */
    dashboardDeepLinkId = null,
    unassignedAssets = [],
    emailData = null
}) => {
    try {
        const recipientEmail = employee.companyEmail || employee.email;
        if (!recipientEmail) {
            console.warn(`[Email Warning] No email found for employee ${employee.employeeId}`);
            return;
        }

        const emailUser = process.env.EMAIL_USER?.trim();
        const emailPass = process.env.EMAIL_PASS?.trim();

        if (!emailUser || !emailPass) {
            console.error("[Email Error] Email credentials are not configured.");
            return;
        }

        const transporter = nodemailer.createTransport({
            host: "smtp.office365.com",
            port: 587,
            secure: false,
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const subject = `New Responsibility Assigned: ${category} for ${companyName}`;
        const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/'/g, "");
        const dashId = dashboardDeepLinkId != null ? String(dashboardDeepLinkId) : String(requestId || "");
        const buttonUrl = `${frontendUrl}/Dashboard?requestId=${encodeURIComponent(dashId)}`;
        const flowchartUrl = `${frontendUrl}/Settings/FlowChart`;

        const legacyUnassigned = listHtml(
            "Unassigned assets (preview)",
            unassignedAssets,
            (a) => `<li>${a.assetId}: ${a.name}</li>`
        );

        let roleSpecificHtml = "";
        const ed = emailData;
        if (ed) {
            const catKey = (ed.categoryKey || "").toLowerCase();
            if (catKey === "hr") {
                roleSpecificHtml += `
                    <div style="margin-top:20px;padding:18px;background:#eff6ff;border-radius:8px;border:1px solid #bfdbfe;">
                        <p style="font-weight:bold;margin:0 0 10px 0;color:#1e3a8a;">HR role — responsibilities overview</p>
                        <ul style="padding-left:18px;margin:0;font-size:13px;line-height:1.5;">
                            ${(ed.hrBullets || []).map((b) => `<li>${b}</li>`).join("")}
                        </ul>
                    </div>
                    ${listHtml(
                        "Company-allocated assets (preview)",
                        ed.companyAssets || [],
                        (a) => `<li>${a.assetId}: ${a.name} (${a.status || "—"})</li>`
                    )}
                `;
            }
            if (catKey === "assetcontroller") {
                const assetBlock = (title, assets, showStatus) => {
                    const rows = assets || [];
                    if (rows.length === 0) {
                        return `<p style="margin:8px 0 0 0;color:#64748b;font-size:13px;"><em>No items in this list.</em></p>`;
                    }
                    return `<div style="margin-top:12px;padding:14px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
                        <p style="font-weight:bold;margin:0 0 8px 0;">${title}</p>
                        <ul style="padding-left:16px;margin:0;font-size:13px;">
                            ${rows.slice(0, 30).map((a) => {
                                const accs = (a.accessories || []).slice(0, 15);
                                const accHtml = accs.length
                                    ? `<ul style="margin:4px 0 6px 0;padding-left:16px;font-size:12px;color:#475569;">${accs.map((acc) => `<li>${acc.name || "Accessory"}${acc.status ? ` — ${acc.status}` : ""}</li>`).join("")}</ul>`
                                    : `<div style="font-size:11px;color:#94a3b8;margin:2px 0 6px 0;">No accessories attached</div>`;
                                return `<li style="margin-bottom:10px;"><strong>${a.assetId}</strong>: ${a.name}${showStatus ? ` (${a.status || "—"})` : ""}${accHtml}</li>`;
                            }).join("")}
                        </ul>
                        ${rows.length > 30 ? `<p style="font-size:12px;color:#64748b;margin:8px 0 0 0;">…and ${rows.length - 30} more</p>` : ""}
                    </div>`;
                };
                roleSpecificHtml += `
                    <div style="margin-top:20px;padding:18px;background:#fffbeb;border-radius:8px;border:1px solid #fcd34d;">
                        <p style="font-weight:bold;margin:0 0 10px 0;color:#92400e;">Asset Controller — inventory preview</p>
                        <p style="font-size:13px;margin:0;color:#78350f;">Accessories are listed under each main asset. A PDF with the full list is attached.</p>
                    </div>
                    ${assetBlock("Parking / On Leave", ed.parkingAssets || [], false)}
                    ${assetBlock("Unassigned / pool", ed.unassignedAssets || [], true)}
                `;
            }
        }

        const html = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #1e293b; line-height: 1.6; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; background-color: #ffffff;">
                <div style="background-color: #5174FF; color: white; padding: 30px; text-align: center;">
                    <h1 style="margin: 0; font-size: 24px;">Responsibility Assignment</h1>
                </div>
                <div style="padding: 40px;">
                    <p style="font-size: 16px;">Hello ${employee.firstName},</p>
                    
                    <p>You have been assigned as the <strong>${category}</strong> for <strong>${companyName}</strong>.</p>
                    
                    ${roleSpecificHtml}
                    ${!ed && unassignedAssets.length ? legacyUnassigned : ""}

                    <p style="font-size: 14px; color: #64748b; margin: 30px 0;">
                        Please review and approve or decline this responsibility in your dashboard.
                        After approval, use <strong>Settings → Flowchart</strong> and the position view for full asset lists.
                    </p>

                    <div style="text-align: center; margin-top: 30px; margin-bottom: 20px;">
                        <a href="${buttonUrl}" 
                           style="background-color: #5174FF; color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 15px rgba(81, 116, 255, 0.3);">
                           Review & Approve Responsibility
                        </a>
                    </div>
                    <p style="text-align:center;font-size:13px;">
                        <a href="${flowchartUrl}" style="color:#5174FF;">Open Flowchart (inventory &amp; position overview)</a>
                    </p>
                </div>
                <div style="background-color: #f8fafc; padding: 20px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
                    <p style="margin: 0;">This is an automated notification from the VeRP System.</p>
                </div>
            </div>
        `;

        const attachments = [];
        if (ed) {
            const catKey = (ed.categoryKey || "").toLowerCase();
            if (catKey === "assetcontroller") {
                try {
                    const pdfAtt = await buildAssetControllerResponsibilityPdfAttachment(
                        ed.unassignedAssets || [],
                        ed.parkingAssets || []
                    );
                    attachments.push(...pdfAtt);
                } catch (pdfErr) {
                    console.error("[Responsibility Email] Asset controller PDF attachment failed:", pdfErr?.message || pdfErr);
                }
            }
            if (catKey === "assigneduser" || catKey === "admincontroller" || catKey === "hr") {
                try {
                    const pdfAtt = await buildCompanyAssetsResponsibilityPdfAttachment(
                        ed.companyAssets || [],
                        `${catKey}-company-assets`
                    );
                    attachments.push(...pdfAtt);
                } catch (pdfErr) {
                    console.error("[Responsibility Email] Company-assets PDF attachment failed:", pdfErr?.message || pdfErr);
                }
            }
        }

        await transporter.sendMail({
            fromName: "VeRP System",
            to: recipientEmail,
            subject,
            html,
            ...(attachments.length > 0 ? { attachments } : {})
        });

        console.log(`[Email Success] Responsibility approval email sent to ${recipientEmail}`);
        return true;
    } catch (error) {
        console.error("[Email Error] Failed to send responsibility approval email:", error);
        return false;
    }
};

import DashboardAction from "../models/DashboardAction.js";

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const labelMatchOrClauses = (labels = []) => {
    const clauses = [];
    const skip = new Set(["document", "documents", "card", "expiry"]);
    for (const label of labels) {
        const raw = String(label || "").trim();
        if (!raw || skip.has(raw.toLowerCase())) continue;
        const escaped = escapeRegExp(raw);
        if (!escaped) continue;
        const re = new RegExp(escaped, "i");
        clauses.push({ extra1: { $regex: re } });
        clauses.push({ extra2: { $regex: re } });
        clauses.push({ extra3: { $regex: re } });
    }
    return clauses;
};

/**
 * Remove company expiry / not-renew / activation tasks tied to a deleted card or document.
 */
export const cleanupAllNotificationsForCompanyCardDelete = async ({
    companyObjectId,
    labels = [],
    notRenewKind = null,
    documentItemId = null,
} = {}) => {
    if (!companyObjectId) return;

    const normalizedLabels = [...new Set((labels || []).map((x) => String(x || "").trim()).filter(Boolean))];
    const orClauses = labelMatchOrClauses(normalizedLabels);

    if (orClauses.length) {
        await DashboardAction.deleteMany({
            requestId: companyObjectId,
            requestType: "Document Expiry Reminder",
            status: { $in: ["Pending", "On Hold"] },
            $or: orClauses,
        });
    }

    const notRenewRows = await DashboardAction.find({
        requestId: companyObjectId,
        requestType: "Company Document Not Renew",
        status: { $in: ["Pending", "On Hold"] },
    })
        .select("_id extra1 extra2 extra3")
        .lean();

    if (notRenewRows.length) {
        const kindNorm = String(notRenewKind || "").trim().toLowerCase();
        const docId = documentItemId ? String(documentItemId) : "";
        const ids = [];
        for (const row of notRenewRows) {
            let meta = {};
            try {
                meta = typeof row.extra3 === "object" ? row.extra3 : JSON.parse(row.extra3 || "{}");
            } catch {
                meta = {};
            }
            const rowKind = String(meta?.kind || "").trim().toLowerCase();
            const hay = `${row.extra1 || ""} ${row.extra2 || ""} ${JSON.stringify(meta)}`.toLowerCase();
            const labelHit = normalizedLabels.some((l) => {
                const ln = String(l).toLowerCase();
                // Avoid matching every row just because label list includes generic "document"
                if (ln === "document" || ln === "documents") return false;
                return hay.includes(ln);
            });
            const docHit =
                docId &&
                (String(meta?.documentItemId || "") === docId ||
                    String(meta?.arrayItemId || "") === docId ||
                    hay.includes(docId.toLowerCase()));

            // Card-level kinds (tradeLicense / establishmentCard): match whole kind.
            // Document rows: require documentItemId or a specific label hit — never wipe all docs.
            let kindHit = false;
            if (kindNorm && kindNorm !== "document") {
                kindHit = rowKind === kindNorm || rowKind.includes(kindNorm);
            }

            if (kindHit || labelHit || docHit) ids.push(row._id);
        }
        if (ids.length) {
            await DashboardAction.deleteMany({ _id: { $in: ids } });
        }
    }

    if (orClauses.length) {
        await DashboardAction.deleteMany({
            requestId: companyObjectId,
            requestType: "Company Activation",
            status: { $in: ["Pending", "On Hold"] },
            $or: orClauses,
        });
    }

    try {
        const { reconcileCompanyDocumentExpiryDashboard } = await import(
            "./processDocumentExpiryReminders.js"
        );
        await reconcileCompanyDocumentExpiryDashboard(companyObjectId);
    } catch (err) {
        console.error("[cleanupAllNotificationsForCompanyCardDelete] reconcile:", err);
    }
};

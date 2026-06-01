import Company from "../models/Company.js";
import { collectCompanyReactivationChangeLabels } from "./companyActivation.js";

const norm = (s) => String(s || "").toLowerCase().trim();

function labelsFromEntryCard(card) {
    return String(card || "")
        .split(",")
        .map((s) => s.replace(/\([^)]*\)/g, "").trim())
        .filter(Boolean);
}

/**
 * Labels HR expected fixed for this queue row.
 * Prefer labels inferred from the actual `proposedData` patch (what was submitted for that row).
 * Only parse the human `card` string when proposedData has no recognizable activation fields — otherwise
 * a combined title like "Basic Details, Trade License" would wrongly require a Basic Details save even when
 * the queued change only touched trade license fields.
 */
function plainProposedData(entry) {
    const raw = entry?.proposedData;
    if (raw == null) return {};
    if (typeof raw.toObject === "function") return raw.toObject();
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    return {};
}

function labelsRequiredForEntry(entry) {
    const pd = plainProposedData(entry);
    const fromPd = collectCompanyReactivationChangeLabels(pd, entry?.previousData);
    if (fromPd.length) return fromPd;
    return labelsFromEntryCard(entry?.card);
}

/** Match hold queue id to a pending row (_id preferred, else array index as used when hold was created). */
function resolveHoldRowId(entry, idx, unapproved) {
    const candidates = [];
    if (entry?._id != null) candidates.push(String(entry._id));
    candidates.push(String(idx));
    return candidates.find((c) => unapproved.has(c)) || null;
}

/**
 * After a successful company PATCH (non-queue path), advance activation hold progress when activation is still submitted.
 */
export async function markCompanyActivationHoldResolvedForUpdate(companyMongoId, updateData = {}) {
    if (!companyMongoId || !updateData || typeof updateData !== "object") return;

    const company = await Company.findById(companyMongoId).select(
        "activationHold pendingReactivationChanges activationStatus owners",
    );
    if (!company) return;

    const changed = collectCompanyReactivationChangeLabels(updateData, company);
    if (!changed.length) return;

    const hold = company.activationHold;
    if (!hold?.unapprovedEntryIds?.length) return;

    const unapproved = new Set(hold.unapprovedEntryIds.map((x) => String(x)));
    const pending = Array.isArray(company.pendingReactivationChanges) ? company.pendingReactivationChanges : [];
    const resolved = new Set((hold.resolvedEntryIds || []).map(String));

    const prog =
        hold.addressedLabelsByEntryId && typeof hold.addressedLabelsByEntryId === "object"
            ? { ...hold.addressedLabelsByEntryId }
            : {};

    const changedNorm = changed.map((c) => norm(c));

    pending.forEach((entry, idx) => {
        const rowId = resolveHoldRowId(entry, idx, unapproved);
        if (!rowId) return;

        const needed = labelsRequiredForEntry(entry);
        const acc = new Set((prog[rowId] || []).map((x) => String(x)));

        if (!needed.length) {
            const cardLow = norm(entry?.card || "");
            const labelHit = changed.some((c) => {
                const cl = norm(c);
                return cl && cardLow.includes(cl);
            });
            if (labelHit) {
                for (const c of changed) {
                    const cl = norm(c);
                    if (cl && cardLow.includes(cl)) acc.add(c);
                }
                prog[rowId] = [...acc];
                resolved.add(rowId);
            }
            return;
        }

        for (const need of needed) {
            const low = norm(need);
            if (changedNorm.includes(low)) acc.add(need);
        }

        prog[rowId] = [...acc];

        const done = needed.every((n) => acc.has(n));
        if (done) resolved.add(rowId);
    });

    hold.addressedLabelsByEntryId = prog;
    hold.resolvedEntryIds = [...resolved];
    company.markModified("activationHold");
    await company.save();
}

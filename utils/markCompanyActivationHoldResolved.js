import Company from "../models/Company.js";
import { collectCompanyReactivationChangeLabels } from "./companyActivation.js";
import { loadCompanyFullProfile, upsertCompanyPartitions } from "../services/companyPartitionService.js";

const norm = (s) => String(s || "").toLowerCase().trim();

const TRADE_LICENSE_UPDATE_KEYS = [
    "tradeLicenseNumber",
    "tradeLicenseIssueDate",
    "tradeLicenseExpiry",
    "tradeLicenseAttachment",
    "tradeLicenseOwnerName",
];

function isTradeLicenseOwnersBundleUpdate(updateData = {}) {
    return (
        Object.prototype.hasOwnProperty.call(updateData, "owners") &&
        TRADE_LICENSE_UPDATE_KEYS.some((k) => Object.prototype.hasOwnProperty.call(updateData, k))
    );
}

function labelsFromEntryCard(card) {
    return String(card || "")
        .split(",")
        .map((s) => s.replace(/\([^)]*\)/g, "").trim())
        .filter(Boolean);
}

function plainProposedData(entry) {
    const raw = entry?.proposedData;
    if (raw == null) return {};
    if (typeof raw.toObject === "function") return raw.toObject();
    if (typeof raw === "object" && !Array.isArray(raw)) return raw;
    return {};
}

export function labelsRequiredForActivationHoldEntry(entry) {
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

function labelsTouchedByUpdate(updateData, beforeCompany) {
    let changed = collectCompanyReactivationChangeLabels(updateData, beforeCompany);
    if (!changed.length && isTradeLicenseOwnersBundleUpdate(updateData)) {
        changed = ["Trade License"];
    }
    return changed;
}

/**
 * After a successful company PATCH, advance activation hold progress.
 * Persists `activationHold` on CompanyWorkflow (partition), not the lean Company core document.
 */
export async function markCompanyActivationHoldResolvedForUpdate(companyMongoId, updateData = {}) {
    if (!companyMongoId || !updateData || typeof updateData !== "object") return;

    const core = await Company.findById(companyMongoId).lean().maxTimeMS(8000);
    if (!core) return;

    const full = await loadCompanyFullProfile(core);
    if (!full) return;

    const changed = labelsTouchedByUpdate(updateData, full);
    if (!changed.length) return;

    const hold = full.activationHold;
    if (!hold?.unapprovedEntryIds?.length) return;

    const unapproved = new Set(hold.unapprovedEntryIds.map((x) => String(x)));
    const pending = Array.isArray(full.pendingReactivationChanges) ? full.pendingReactivationChanges : [];
    const resolved = new Set((hold.resolvedEntryIds || []).map(String));

    const prog =
        hold.addressedLabelsByEntryId && typeof hold.addressedLabelsByEntryId === "object"
            ? { ...hold.addressedLabelsByEntryId }
            : {};

    const changedNorm = changed.map((c) => norm(c));

    pending.forEach((entry, idx) => {
        const rowId = resolveHoldRowId(entry, idx, unapproved);
        if (!rowId) return;

        const needed = labelsRequiredForActivationHoldEntry(entry);
        const acc = new Set((prog[rowId] || []).map((x) => String(x)));

        if (!needed.length) {
            const cardLow = norm(entry?.card || "");
            const sectionLow = norm(entry?.section || "");
            const labelHit = changed.some((c) => {
                const cl = norm(c);
                return cl && (cardLow.includes(cl) || sectionLow.includes(cl) || cl.includes(cardLow));
            });
            if (labelHit) {
                for (const c of changed) {
                    const cl = norm(c);
                    if (cl && (cardLow.includes(cl) || sectionLow.includes(cl))) acc.add(c);
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

    await upsertCompanyPartitions(companyMongoId, {
        activationHold: {
            ...hold,
            addressedLabelsByEntryId: prog,
            resolvedEntryIds: [...resolved],
        },
    });
}

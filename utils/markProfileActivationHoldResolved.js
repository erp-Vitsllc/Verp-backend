import EmployeeBasic from "../models/EmployeeBasic.js";

const norm = (s) => String(s || "").toLowerCase().trim();

/**
 * When the employee saves a section again, mark matching held (unapproved) queue rows as resolved for resubmission.
 */
export const markProfileActivationHoldResolvedForSection = async (employeeId, sectionRaw) => {
    const section = norm(sectionRaw);
    if (!employeeId || !section) return;

    const doc = await EmployeeBasic.findOne({ employeeId }).select(
        "profileActivationHold pendingReactivationChanges",
    );
    if (!doc?.profileActivationHold?.unapprovedEntryIds?.length) return;

    const hold = doc.profileActivationHold;
    const unapproved = new Set(hold.unapprovedEntryIds.map(String));
    const pending = Array.isArray(doc.pendingReactivationChanges) ? doc.pendingReactivationChanges : [];
    const resolved = new Set((hold.resolvedEntryIds || []).map(String));

    pending.forEach((entry, idx) => {
        const id = String(entry?._id ?? idx);
        if (!unapproved.has(id)) return;
        const entrySec = norm(entry.section);
        if (entrySec === section) {
            resolved.add(id);
        }
    });

    hold.resolvedEntryIds = [...resolved];
    doc.markModified("profileActivationHold");
    await doc.save();
};

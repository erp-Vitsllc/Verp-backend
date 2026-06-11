/** Linked EmployeeBasic _id, else portal User _id — for draft editor / submitter on admin accounts without employee link. */
export function resolvePortalActorId(actor) {
    if (!actor || typeof actor !== "object") return null;
    return (
        actor.employeeObjectId ||
        actor.empObjectId ||
        actor.linkedEmployee ||
        actor._id ||
        actor.id ||
        null
    );
}

export function portalActorIdSet(reqOrUser) {
    const user = reqOrUser?.user || reqOrUser;
    const ids = new Set();
    if (!user) return ids;
    const emp = String(user.employeeObjectId || user.empObjectId || user.linkedEmployee || "").trim();
    if (emp) ids.add(emp);
    const uid = String(user._id || user.id || "").trim();
    if (uid) ids.add(uid);
    return ids;
}

export function portalActorMatchesStoredId(reqOrUser, storedId) {
    const target = String(storedId || "").trim();
    if (!target) return false;
    return portalActorIdSet(reqOrUser).has(target);
}

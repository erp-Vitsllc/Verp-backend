// getDepartmentHOD.js
import EmployeeBasic from "../models/EmployeeBasic.js";
import Flowchart from "../models/Flowchart.js";

/**
 * Retrieves the HOD (Head of Department) from the Flowchart collection.
 * @param {string} departmentType The department type ('hr', 'accounts', 'finance', 'assetcontroller').
 * @returns {Promise<Object|null>} The HOD employee object or null if not found.
 */
export const getDepartmentHOD = async (departmentType) => {
    try {
        const type = (departmentType || '').toLowerCase().replace(/\s+/g, '');
        let category = type;
        
        // Handle common aliases/formatting
        if (type === 'hr' || type === 'humanresource' || type === 'humanresources') {
            category = 'hr';
        } else if (type === 'finance' || type === 'accounts' || type === 'accounting') {
            category = 'accounts';
        } else if (type === 'assetcontroller') {
            category = 'assetcontroller';
        } else if (type === 'admincontroller') {
            category = 'admincontroller';
        } else if (type === 'assigneduser') {
            category = 'assigneduser';
        } else if (type === 'management' || type === 'generalmanagement' || type === 'ceo') {
            category = 'management';
        }

        const categoryRegex = new RegExp(`^${category.split('').join('\\s*')}$`, 'i');

        const empPopulateSelect =
            'employeeId firstName lastName companyEmail workEmail personalEmail email designation department profileStatus status signature';

        // For org "Administrator" workflows, Settings labels the row **Admin** (schema category `admin`).
        // Legacy rows may still use `admincontroller`. Prefer `admin` / `administrator` first so email + dashboard
        // go to Marwan (flowchart Admin), not an obsolete `admincontroller` row bound to a portal super-user.
        let responsibility = null;
        if (category === 'admincontroller') {
            responsibility = await Flowchart.findOne({
                category: { $regex: /^admin$/i },
                status: 'Active',
            }).populate('empObjectId', empPopulateSelect);
            if (!responsibility) {
                responsibility = await Flowchart.findOne({
                    category: { $regex: /^administrator$/i },
                    status: 'Active',
                }).populate('empObjectId', empPopulateSelect);
            }
            if (!responsibility) {
                responsibility = await Flowchart.findOne({
                    category: { $regex: categoryRegex },
                    status: 'Active',
                }).populate('empObjectId', empPopulateSelect);
            }
        } else {
            responsibility = await Flowchart.findOne({
                category: { $regex: categoryRegex },
                status: 'Active',
            }).populate('empObjectId', empPopulateSelect);
        }

        if (!responsibility) {
            let pending = null;
            if (category === 'admincontroller') {
                pending = await Flowchart.findOne({
                    category: { $regex: /^admin$/i },
                    status: 'Pending',
                    reassignmentSnapshot: { $ne: null },
                }).lean();
                if (!pending) {
                    pending = await Flowchart.findOne({
                        category: { $regex: /^administrator$/i },
                        status: 'Pending',
                        reassignmentSnapshot: { $ne: null },
                    }).lean();
                }
                if (!pending) {
                    pending = await Flowchart.findOne({
                        category: { $regex: categoryRegex },
                        status: 'Pending',
                        reassignmentSnapshot: { $ne: null },
                    }).lean();
                }
            } else {
                pending = await Flowchart.findOne({
                    category: { $regex: categoryRegex },
                    status: 'Pending',
                    reassignmentSnapshot: { $ne: null },
                }).lean();
            }
            if (pending?.reassignmentSnapshot?.empObjectId || pending?.reassignmentSnapshot?.employeeId) {
                const snapshotEmpObjectId = pending.reassignmentSnapshot.empObjectId;
                const snapshotEmployeeId = pending.reassignmentSnapshot.employeeId;
                const snapDoc = snapshotEmpObjectId
                    ? await EmployeeBasic.findById(snapshotEmpObjectId).select(
                        'employeeId firstName lastName companyEmail workEmail personalEmail email designation department profileStatus status signature'
                    )
                    : (snapshotEmployeeId
                        ? await EmployeeBasic.findOne({
                            employeeId: { $regex: buildWhitespaceAgnosticExactRegex(snapshotEmployeeId) || /^$/ }
                        }).select(
                            'employeeId firstName lastName companyEmail workEmail personalEmail email designation department profileStatus status signature'
                        )
                        : null);

                if (snapDoc) {
                    responsibility = {
                        ...pending,
                        status: 'Active',
                        empObjectId: snapDoc
                    };
                }
            }

            // First-time Pending invite (no Active row yet): use the Pending row's assignee
            // so Quotation Review / workflows can still resolve HR / Accounts.
            if (!responsibility) {
                let pendingInvite = null;
                if (category === 'admincontroller') {
                    pendingInvite = await Flowchart.findOne({
                        category: { $regex: /^admin$/i },
                        status: 'Pending',
                    }).populate('empObjectId', empPopulateSelect);
                    if (!pendingInvite) {
                        pendingInvite = await Flowchart.findOne({
                            category: { $regex: /^administrator$/i },
                            status: 'Pending',
                        }).populate('empObjectId', empPopulateSelect);
                    }
                    if (!pendingInvite) {
                        pendingInvite = await Flowchart.findOne({
                            category: { $regex: categoryRegex },
                            status: 'Pending',
                        }).populate('empObjectId', empPopulateSelect);
                    }
                } else {
                    pendingInvite = await Flowchart.findOne({
                        category: { $regex: categoryRegex },
                        status: 'Pending',
                    }).populate('empObjectId', empPopulateSelect);
                }
                if (pendingInvite?.empObjectId || pendingInvite?.employeeId) {
                    responsibility = pendingInvite;
                }
            }
        }

        if (responsibility) {
            if (responsibility.empObjectId) {
                return responsibility.empObjectId;
            }

            // Fallback: If empObjectId is missing, try to find the employee by employeeId
            const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(responsibility.employeeId);
            const employee = safeEmployeeIdRegex
                ? await EmployeeBasic.findOne({
                    employeeId: { $regex: safeEmployeeIdRegex }
                }).select('employeeId firstName lastName companyEmail workEmail personalEmail email designation department profileStatus status signature')
                : null;

            if (employee) {
                // Auto-repair the flowchart entry for next time
                responsibility.empObjectId = employee._id;
                await responsibility.save().catch(err => console.error('[getDepartmentHOD] Auto-repair failed:', err));
                return employee;
            }

            // Final Fallback: Return a partial object from Flowchart data
            // This allows the system to at least know who the person is even if record is missing
            return {
                _id: null,
                firstName: responsibility.employeeName?.split(' ')[0] || 'Unknown',
                lastName: responsibility.employeeName?.split(' ').slice(1).join(' ') || '',
                employeeId: responsibility.employeeId,
                designation: responsibility.designation,
                email: responsibility.companyEmail || null,
                isFlowchartOnly: true
            };
        }

        return null;
    } catch (error) {
        console.error(`[getDepartmentHOD] Fatal:`, error);
        return null;
    }
};

const escapeRegExp = (value) => {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Build an "exact match ignoring whitespace" regex for employeeId.
// - Escapes regex metacharacters (so employeeId like "A.123" won't match wrongly)
// - Allows different whitespace inside the string
const buildWhitespaceAgnosticExactRegex = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    const pattern = parts.map(p => escapeRegExp(p)).join('\\s*');
    return new RegExp(`^${pattern}$`, 'i');
};

/**
 * Checks if a specific user is assigned to a category in the Flowchart.
 * @param {Object} user The user object (usually from req.user)
 * @param {string} category The category to check (e.g., 'assetcontroller')
 * @returns {Promise<boolean>} True if the user is an active HOD for this category
 */
export const isUserInFlowchart = async (user, category) => {
    try {
        if (!user) return false;

        const normalizedCategory = (category || '').toLowerCase().replace(/\s+/g, '');
        const categoryRegex = new RegExp(`^${normalizedCategory.split('').join('\\s*')}$`, 'i');

        const categoryBranches =
            normalizedCategory === 'admincontroller'
                ? [
                      { category: { $regex: categoryRegex } },
                      { category: { $regex: /^admin$/i } },
                      { category: { $regex: /^administrator$/i } },
                  ]
                : [{ category: { $regex: categoryRegex } }];

        const orClauses = [];
        for (const cat of categoryBranches) {
            if (user.employeeObjectId) {
                orClauses.push({ ...cat, status: 'Active', empObjectId: user.employeeObjectId });
            }
            if (user.employeeId) {
                const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(user.employeeId);
                if (safeEmployeeIdRegex) {
                    orClauses.push({ ...cat, status: 'Active', employeeId: { $regex: safeEmployeeIdRegex } });
                }
            }
            if (user.employeeObjectId) {
                orClauses.push({
                    ...cat,
                    status: 'Pending',
                    reassignmentSnapshot: { $ne: null },
                    'reassignmentSnapshot.empObjectId': user.employeeObjectId,
                });
            }
            if (user.employeeId) {
                const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(user.employeeId);
                if (safeEmployeeIdRegex) {
                    orClauses.push({
                        ...cat,
                        status: 'Pending',
                        reassignmentSnapshot: { $ne: null },
                        'reassignmentSnapshot.employeeId': { $regex: safeEmployeeIdRegex },
                    });
                }
            }
        }

        if (orClauses.length === 0) return false;

        const exists = await Flowchart.exists({ $or: orClauses });
        return !!exists;
    } catch (error) {
        console.error(`[isUserInFlowchart] Error:`, error);
        return false;
    }
};

/**
 * Same as isUserInFlowchart but only Active assignments (excludes Pending flowchart rows).
 * Use when deciding role-based UI (e.g. HR company assets tab) so invited-but-not-approved holders are not treated as HR.
 */
export const isUserActiveInFlowchart = async (user, category) => {
    try {
        if (!user) return false;

        const normalizedCategory = (category || '').toLowerCase().replace(/\s+/g, '');
        const categoryRegex = new RegExp(`^${normalizedCategory.split('').join('\\s*')}$`, 'i');

        const categoryBranches =
            normalizedCategory === 'admincontroller'
                ? [
                      { category: { $regex: categoryRegex } },
                      { category: { $regex: /^admin$/i } },
                      { category: { $regex: /^administrator$/i } },
                  ]
                : [{ category: { $regex: categoryRegex } }];

        const orClauses = [];
        for (const cat of categoryBranches) {
            if (user.employeeObjectId) {
                orClauses.push({ ...cat, status: 'Active', empObjectId: user.employeeObjectId });
            }
            if (user.employeeId) {
                const safeEmployeeIdRegex = buildWhitespaceAgnosticExactRegex(user.employeeId);
                if (safeEmployeeIdRegex) {
                    orClauses.push({ ...cat, status: 'Active', employeeId: { $regex: safeEmployeeIdRegex } });
                }
            }
        }

        if (orClauses.length === 0) return false;

        const exists = await Flowchart.exists({ $or: orClauses });
        return !!exists;
    } catch (error) {
        console.error(`[isUserActiveInFlowchart] Error:`, error);
        return false;
    }
};

/**
 * Employee who receives company-allocation emails/dashboard (Settings → Flowchart: Assigned User, else Admin).
 * Replaces legacy HR-only routing for company-assigned assets.
 */
export const getCompanyAssetCoordinator = async () => {
    const assigned = await getDepartmentHOD('assigneduser');
    if (assigned?._id) return assigned;
    const admin = await getDepartmentHOD('admincontroller');
    if (admin?._id) return admin;
    return null;
};

export const isUserCompanyAssetCoordinator = async (user) => {
    if (!user) return false;
    if (await isUserInFlowchart(user, 'assigneduser')) return true;
    if (await isUserInFlowchart(user, 'admincontroller')) return true;
    const coord = await getCompanyAssetCoordinator();
    const eid = user.employeeObjectId?.toString?.();
    if (coord?._id && eid && coord._id.toString() === eid) return true;
    return false;
};

export const isUserActiveCompanyAssetCoordinator = async (employeeObjectId, employeeId) => {
    const u = { employeeObjectId, employeeId };
    if (await isUserActiveInFlowchart(u, 'assigneduser')) return true;
    if (await isUserActiveInFlowchart(u, 'admincontroller')) return true;
    const coord = await getCompanyAssetCoordinator();
    if (coord?._id && employeeObjectId && coord._id.toString() === employeeObjectId.toString()) return true;
    return false;
};

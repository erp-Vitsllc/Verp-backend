/**
 * Middleware to check if user has permission for a specific module and action
 * @param {string} moduleId - The module ID to check (e.g., 'hrm_employees', 'settings_user_group')
 * @param {string} permissionType - The permission type to check ('create', 'view', 'edit', 'delete', 'full')
 * @returns {Function} Express middleware function
 */
export const checkPermission = (moduleId, permissionType = 'view') => {
    return async (req, res, next) => {
        try {
            // Get user ID from token (set by authMiddleware)
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ message: "Not authorized, no user found" });
            }

            // Import here to avoid circular dependency
            const { hasPermission, isUserAdministrator } = await import("../services/permissionService.js");

            // System admin, JWT Admin/ROOT — bypass permission checks
            const isAdmin = await isUserAdministrator(userId);
            const isJwtAdmin =
                req.user?.isAdmin === true ||
                req.user?.role === "Admin" ||
                req.user?.role === "ROOT";
            if (isAdmin || isJwtAdmin) {
                return next();
            }

            // Check if user has the required permission
            const hasAccess = await hasPermission(userId, moduleId, permissionType);

            if (!hasAccess) {
                return res.status(403).json({
                    message: `Access denied. You don't have ${permissionType} permission for ${moduleId}`
                });
            }

            // User has permission, proceed
            next();
        } catch (error) {
            console.error('Error checking permission:', error);
            return res.status(500).json({ message: "Error checking permissions" });
        }
    };
};

/** Card-level field groups for PATCH /Employee/basic-details/:id (matches frontend profile cards). */
const BASIC_DETAILS_PATCH_GROUPS = [
    {
        fields: [
            "employeeId",
            "firstName",
            "lastName",
            "country",
            "status",
            "probationPeriod",
            "reportingAuthority",
            "profileApprovalStatus",
            "profileStatus",
            "profilePicture",
            "enablePortalAccess",
        ],
        modules: ["hrm_employees_view_basic"],
    },
    {
        fields: [
            "email",
            "contactNumber",
            "dateOfBirth",
            "maritalStatus",
            "numberOfDependents",
            "fathersName",
            "nationality",
        ],
        modules: ["hrm_employees_view_basic", "hrm_employees_view_personal"],
    },
    {
        fields: ["gender"],
        modules: ["hrm_employees_view_personal"],
    },
    {
        fields: ["addressLine1", "addressLine2", "city", "state", "postalCode"],
        modules: ["hrm_employees_view_permanent_address"],
    },
    {
        fields: [
            "currentAddressLine1",
            "currentAddressLine2",
            "currentCity",
            "currentState",
            "currentCountry",
            "currentPostalCode",
        ],
        modules: ["hrm_employees_view_current_address"],
    },
    {
        fields: [
            "bankName",
            "accountName",
            "accountNumber",
            "ibanNumber",
            "swiftCode",
            "ifscCode",
            "bankOtherDetails",
            "bankAttachment",
        ],
        modules: ["hrm_employees_view_bank"],
    },
    {
        fields: [
            "basic",
            "houseRentAllowance",
            "otherAllowance",
            "additionalAllowances",
            "salaryHistory",
            "offerLetter",
            "monthlySalary",
            "totalSalary",
            "basicPercentage",
            "houseRentPercentage",
            "otherAllowancePercentage",
        ],
        modules: ["hrm_employees_view_salary"],
    },
    {
        fields: ["trainingDetails"],
        modules: ["hrm_employees_list"],
    },
    {
        fields: ["documents"],
        modules: [
            "hrm_employees_view",
            "hrm_employees_view_documents_live",
            "hrm_employees_view_documents_live_with_expiry",
            "hrm_employees_view_documents_live_without_expiry",
        ],
    },
    {
        fields: ["oldDocuments"],
        modules: ["hrm_employees_view", "hrm_employees_view_documents_old"],
    },
];

const BASIC_DETAILS_PATCH_META_KEYS = new Set(["skipArchive"]);

const touchedBasicDetailsPatchGroups = (body = {}) =>
    BASIC_DETAILS_PATCH_GROUPS.filter((group) =>
        group.fields.some((field) => body[field] !== undefined && !BASIC_DETAILS_PATCH_META_KEYS.has(field)),
    );

const hasEditOrCreateAccess = async (userId, moduleId, hasPermission) =>
    (await hasPermission(userId, moduleId, "edit")) || (await hasPermission(userId, moduleId, "create"));

/**
 * PATCH /Employee/basic-details/:id — permission follows the card(s) being updated
 * (bank → hrm_employees_view_bank, salary → hrm_employees_view_salary, etc.).
 */
export const checkBasicDetailsPatchPermission = () => {
    return async (req, res, next) => {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ message: "Not authorized, no user found" });
            }

            const { hasPermission, isUserAdministrator } = await import("../services/permissionService.js");

            const isAdmin = await isUserAdministrator(userId);
            const isJwtAdmin =
                req.user?.isAdmin === true ||
                req.user?.role === "Admin" ||
                req.user?.role === "ROOT";
            if (isAdmin || isJwtAdmin) {
                return next();
            }

            const body = req.body && typeof req.body === "object" ? req.body : {};
            const groups = touchedBasicDetailsPatchGroups(body);

            if (groups.length === 0) {
                return res.status(400).json({ message: "Nothing to update" });
            }

            for (const group of groups) {
                const allowed = await Promise.all(
                    group.modules.map((moduleId) => hasEditOrCreateAccess(userId, moduleId, hasPermission)),
                );
                if (!allowed.some(Boolean)) {
                    return res.status(403).json({
                        message: `Access denied. You don't have edit permission for ${group.modules.join(" or ")}`,
                    });
                }
            }

            next();
        } catch (error) {
            console.error("Error checking basic details patch permission:", error);
            return res.status(500).json({ message: "Error checking permissions" });
        }
    };
};

/**
 * Manual employee documents (live list + S3 upload helper).
 * Matches frontend Documents tab: `DocumentsTab` gates add/edit with
 * `hrm_employees_view_documents_live` or `hrm_employees_view_documents_old` edit,
 * not necessarily parent `hrm_employees_view` edit.
 */
export const checkEmployeeManualDocumentEdit = () => {
    return async (req, res, next) => {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ message: "Not authorized, no user found" });
            }

            const { hasPermission, isUserAdministrator } = await import("../services/permissionService.js");

            const isAdmin = await isUserAdministrator(userId);
            const isJwtAdmin =
                req.user?.isAdmin === true ||
                req.user?.role === "Admin" ||
                req.user?.role === "ROOT";
            if (isAdmin || isJwtAdmin) {
                return next();
            }

            const body = req.body && typeof req.body === "object" ? req.body : {};
            const folder = String(body.folder || "").toLowerCase();

            /** Salary letter / bank attachment uploads use the same card permissions as PATCH basic-details. */
            const cardUploadPairs = [];
            if (folder.includes("/salary")) {
                cardUploadPairs.push(
                    ["hrm_employees_view_salary", "edit"],
                    ["hrm_employees_view_salary", "create"],
                );
            }
            if (folder.includes("/bank")) {
                cardUploadPairs.push(
                    ["hrm_employees_view_bank", "edit"],
                    ["hrm_employees_view_bank", "create"],
                );
            }
            for (const [moduleId, permissionType] of cardUploadPairs) {
                if (await hasPermission(userId, moduleId, permissionType)) {
                    return next();
                }
            }

            const pairs = [
                ["hrm_employees_view", "edit"],
                ["hrm_employees_view_documents_live", "edit"],
                ["hrm_employees_view_documents_live_with_expiry", "edit"],
                ["hrm_employees_view_documents_live_without_expiry", "edit"],
                ["hrm_employees_view_documents_old", "edit"],
            ];

            for (const [moduleId, permissionType] of pairs) {
                if (await hasPermission(userId, moduleId, permissionType)) {
                    return next();
                }
            }

            return res.status(403).json({
                message:
                    "Access denied. Editing employee documents requires View Employee (Edit) or Documents Live / Old (or granular live document) Edit, with View enabled for that module.",
            });
        } catch (error) {
            console.error("Error checking manual document edit permission:", error);
            return res.status(500).json({ message: "Error checking permissions" });
        }
    };
};

/**
 * Deleting archived / old document rows — align with old-documents delete or parent view delete.
 */
export const checkEmployeeOldDocumentDelete = () => {
    return async (req, res, next) => {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ message: "Not authorized, no user found" });
            }

            const { hasPermission, isUserAdministrator } = await import("../services/permissionService.js");

            const isAdmin = await isUserAdministrator(userId);
            const isJwtAdmin =
                req.user?.isAdmin === true ||
                req.user?.role === "Admin" ||
                req.user?.role === "ROOT";
            if (isAdmin || isJwtAdmin) {
                return next();
            }

            const pairs = [
                ["hrm_employees_view", "delete"],
                ["hrm_employees_view_documents_old", "delete"],
            ];

            for (const [moduleId, permissionType] of pairs) {
                if (await hasPermission(userId, moduleId, permissionType)) {
                    return next();
                }
            }

            return res.status(403).json({
                message:
                    "Access denied. Removing old employee documents requires View Employee (Delete) or Old Documents (Delete), with View enabled for that module.",
            });
        } catch (error) {
            console.error("Error checking old document delete permission:", error);
            return res.status(500).json({ message: "Error checking permissions" });
        }
    };
};

/**
 * Profile activation workflow (submit to HR, approve, hold, reject, status).
 * Matches frontend: Flowchart often grants `hrm_employees_view_activation` (view/create) without parent `hrm_employees` edit.
 * Allows any of: hrm_employees edit|create, hrm_employees_view_activation edit|create (each still requires module view per hasPermission).
 */
export const checkEmployeeProfileActivationAction = () => {
    return async (req, res, next) => {
        try {
            const userId = req.user?.id;

            if (!userId) {
                return res.status(401).json({ message: "Not authorized, no user found" });
            }

            const { hasPermission, isUserAdministrator } = await import("../services/permissionService.js");

            const isAdmin = await isUserAdministrator(userId);
            const isJwtAdmin =
                req.user?.isAdmin === true ||
                req.user?.role === "Admin" ||
                req.user?.role === "ROOT";
            if (isAdmin || isJwtAdmin) {
                return next();
            }

            const pairs = [
                ["hrm_employees", "edit"],
                ["hrm_employees", "create"],
                ["hrm_employees_view_activation", "edit"],
                ["hrm_employees_view_activation", "create"],
            ];

            for (const [moduleId, permissionType] of pairs) {
                if (await hasPermission(userId, moduleId, permissionType)) {
                    return next();
                }
            }

            return res.status(403).json({
                message:
                    "Access denied. Profile activation requires Employees (Edit or Create) or Profile Activation (Edit or Create), with View enabled for that module.",
            });
        } catch (error) {
            console.error("Error checking profile activation permission:", error);
            return res.status(500).json({ message: "Error checking permissions" });
        }
    };
};

/**
 * Middleware to check if user is admin
 * @returns {Function} Express middleware function
 */
export const requireAdmin = async (req, res, next) => {
    try {
        const userId = req.user?.id;

        if (!userId) {
            return res.status(401).json({ message: "Not authorized, no user found" });
        }

        // Import here to avoid circular dependency
        const { isUserAdministrator } = await import("../services/permissionService.js");
        const isAdmin = await isUserAdministrator(userId);

        if (!isAdmin) {
            return res.status(403).json({ message: "Access denied. Admin privileges required." });
        }

        next();
    } catch (error) {
        console.error('Error checking admin status:', error);
        return res.status(500).json({ message: "Error checking admin status" });
    }
};


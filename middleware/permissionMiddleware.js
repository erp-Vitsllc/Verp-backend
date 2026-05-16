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


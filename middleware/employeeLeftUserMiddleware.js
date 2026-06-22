import { resolveEmployeeId } from "../services/employeeService.js";
import { isLeftUserStatus } from "../utils/applyEmployeeLeftUserStatus.js";

/**
 * Block profile mutations for employees marked as Left User.
 * View/download routes are unaffected (middleware is only attached to write routes).
 */
export const rejectLeftUserProfileWrite = () => async (req, res, next) => {
    try {
        const id = req.params.id || req.params.employeeId;
        if (!id) return next();

        const resolved = await resolveEmployeeId(id);
        if (!resolved) return next();

        if (isLeftUserStatus(resolved.status)) {
            return res.status(403).json({
                message: "This employee is marked as Left User. Profile changes are not allowed.",
            });
        }

        return next();
    } catch (err) {
        return next(err);
    }
};

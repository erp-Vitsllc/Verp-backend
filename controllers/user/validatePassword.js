import User from "../../models/User.js";
import bcrypt from "bcryptjs";

// Validate password (check if new password is different from current password)
export const validatePassword = async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({
                message: "Password is required"
            });
        }

        // Validate password requirements
        if (password.length < 8) {
            return res.status(400).json({
                message: "Password must be at least 8 characters"
            });
        }
        if (!/[A-Z]/.test(password)) {
            return res.status(400).json({
                message: "Password must contain at least one uppercase letter"
            });
        }
        if (!/[a-z]/.test(password)) {
            return res.status(400).json({
                message: "Password must contain at least one lowercase letter"
            });
        }
        if (!/[0-9]/.test(password)) {
            return res.status(400).json({
                message: "Password must contain at least one number"
            });
        }

        // Find user
        const user = await User.findById(id);
        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Check if password matches current password
        if (user.password) {
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) {
                return res.status(400).json({
                    message: "New password must be different from the current password"
                });
            }
        }

        // Check if password matches any in passwordHistory
        if (user.passwordHistory && user.passwordHistory.length > 0) {
            for (const oldPasswordHash of user.passwordHistory) {
                const isMatch = await bcrypt.compare(password, oldPasswordHash);
                if (isMatch) {
                    return res.status(400).json({
                        message: "New password must be different from recently used passwords"
                    });
                }
            }
        }

        // Password is valid and different from current
        return res.status(200).json({
            message: "Password is valid"
        });
    } catch (error) {
        console.error('Error validating password:', error);
        return res.status(500).json({
            message: error.message || 'Internal server error'
        });
    }
};
















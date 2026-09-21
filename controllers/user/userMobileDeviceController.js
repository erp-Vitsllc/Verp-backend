import User from '../../models/User.js';
import RefreshToken from '../../models/RefreshToken.js';
import { isUsernameSystemSuperUser } from '../../utils/systemSuperUser.js';
import {
    changeMobileDeviceOnUser,
    changeWebDeviceOnUser,
    fixMobileDeviceOnUser,
    serializeMobileDevice,
    serializeWebLogin,
} from '../../utils/userMobileDevice.js';

function invalidId(id) {
    return !id || !String(id).match(/^[0-9a-fA-F]{24}$/);
}

async function loadUser(id) {
    return User.findById(id).select('username mobileDevice webLogin lastLoginIp');
}

function jsonDevice(user) {
    return {
        mobileDevice: serializeMobileDevice(user),
    };
}

export async function fixUserMobileDevice(req, res) {
    try {
        const { id } = req.params;
        if (invalidId(id)) {
            return res.status(400).json({ message: 'Invalid user ID format' });
        }

        const user = await loadUser(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (isUsernameSystemSuperUser(user.username)) {
            return res.status(400).json({ message: 'System admin is not locked to a mobile device.' });
        }

        const result = fixMobileDeviceOnUser(user);
        if (!result.ok) {
            return res.status(400).json({ message: result.message });
        }

        await user.save();
        const lockedId = String(user.mobileDevice?.deviceId || '').trim();
        if (lockedId) {
            await RefreshToken.deleteMany({
                userId: user._id,
                deviceId: { $ne: lockedId },
            });
        }

        return res.status(200).json({
            message: 'This phone is fixed for 30 days. WhatsApp OTP will be skipped until then.',
            ...jsonDevice(user),
        });
    } catch (error) {
        console.error('[fixUserMobileDevice]', error);
        return res.status(500).json({ message: error.message || 'Failed to fix mobile device.' });
    }
}

export async function changeUserMobileDevice(req, res) {
    try {
        const { id } = req.params;
        if (invalidId(id)) {
            return res.status(400).json({ message: 'Invalid user ID format' });
        }

        const user = await loadUser(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (isUsernameSystemSuperUser(user.username)) {
            return res.status(400).json({ message: 'System admin is not locked to a mobile device.' });
        }

        changeMobileDeviceOnUser(user);
        await user.save();
        await RefreshToken.deleteMany({ userId: user._id });

        return res.status(200).json({
            message: 'Device lock removed. The next phone that logs in will become the current device.',
            ...jsonDevice(user),
        });
    } catch (error) {
        console.error('[changeUserMobileDevice]', error);
        return res.status(500).json({ message: error.message || 'Failed to change mobile device.' });
    }
}

export async function changeUserWebDevice(req, res) {
    try {
        const { id } = req.params;
        if (invalidId(id)) {
            return res.status(400).json({ message: 'Invalid user ID format' });
        }

        const user = await loadUser(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (isUsernameSystemSuperUser(user.username)) {
            return res.status(400).json({ message: 'System admin is not locked to a laptop/browser.' });
        }

        changeWebDeviceOnUser(user);
        await user.save();

        return res.status(200).json({
            message: 'Fixed laptop cleared. The next website login will send a company-email OTP.',
            webLogin: serializeWebLogin(user),
        });
    } catch (error) {
        console.error('[changeUserWebDevice]', error);
        return res.status(500).json({ message: error.message || 'Failed to change web device.' });
    }
}

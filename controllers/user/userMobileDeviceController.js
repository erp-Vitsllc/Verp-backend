import User from '../../models/User.js';
import RefreshToken from '../../models/RefreshToken.js';
import { isUsernameSystemSuperUser } from '../../utils/systemSuperUser.js';
import {
    changeMobileDeviceOnUser,
    changeWebDeviceOnUser,
    collectStoredDeviceSessions,
    fixMobileDeviceOnUser,
    removeStoredDevice,
    serializeMobileDevice,
    serializeWebLogin,
} from '../../utils/userMobileDevice.js';

function invalidId(id) {
    return !id || !String(id).match(/^[0-9a-fA-F]{24}$/);
}

async function loadUser(id) {
    return User.findById(id).select('username mobileDevice mobileReviewBypass webLogin webLoginDevices lastLoginIp');
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
            message: 'Remembered web devices cleared. The next website login will send a company-email OTP.',
            webLogin: serializeWebLogin(user),
        });
    } catch (error) {
        console.error('[changeUserWebDevice]', error);
        return res.status(500).json({ message: error.message || 'Failed to change web device.' });
    }
}

export async function listUserDevices(req, res) {
    try {
        const users = await User.find({
            $or: [
                { 'webLoginDevices.0': { $exists: true } },
                { 'mobileDevice.deviceId': { $nin: [null, ''] } },
                { 'mobileDevice.status': 'fixed' },
                { 'webLogin.deviceId': { $nin: [null, ''] } },
                { 'webLogin.ipAddress': { $nin: [null, ''] } },
                { 'webLogin.userAgent': { $nin: [null, ''] } },
                { 'webLogin.lastSeenAt': { $ne: null } },
            ],
        }).select('name username profilePicture mobileDevice webLogin webLoginDevices');

        const sessions = [];
        for (const user of users) {
            const rows = collectStoredDeviceSessions(user);
            if (user.isModified?.()) await user.save();
            for (const row of rows) {
                sessions.push({
                    userId: String(user._id),
                    name: user.name || user.username || 'User',
                    username: user.username || '',
                    profilePicture: user.profilePicture || '',
                    ...row,
                });
            }
        }
        sessions.sort((a, b) => {
            const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
            const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
            return bt - at;
        });
        return res.status(200).json({ sessions, total: sessions.length });
    } catch (error) {
        console.error('[listUserDevices]', error);
        return res.status(500).json({ message: error.message || 'Failed to load devices.' });
    }
}

export async function terminateUserDevice(req, res) {
    try {
        const userId = String(req.body?.userId || '').trim();
        const source = String(req.body?.source || '').trim().toLowerCase();
        const deviceId = String(req.body?.deviceId || '').trim();
        if (invalidId(userId) || !deviceId || (source !== 'web' && source !== 'app')) {
            return res.status(400).json({ message: 'Choose a saved device to remove.' });
        }

        const user = await loadUser(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const removed = removeStoredDevice(user, { source, deviceId });
        if (!removed) {
            return res.status(404).json({ message: 'That device is no longer saved.' });
        }
        await user.save();
        if (source === 'app') {
            await RefreshToken.deleteMany({ userId: user._id, deviceId });
        }

        return res.status(200).json({
            message: 'Device removed. The next login from this device needs OTP.',
        });
    } catch (error) {
        console.error('[terminateUserDevice]', error);
        return res.status(500).json({ message: error.message || 'Failed to remove device.' });
    }
}

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import RefreshToken from '../models/RefreshToken.js';
import { recordActivityAsync } from '../utils/activityLog.js';
import { normalizeLoginThrough } from '../utils/loginThrough.js';
import {
  mobileDeviceLoginDenied,
  readMobileDeviceFromRequest,
  recordMobileDeviceOnUser,
  serializeMobileDevice,
} from '../utils/userMobileDevice.js';

const ACCESS_EXPIRES = process.env.MOBILE_ACCESS_EXPIRES_IN || '15m';
const REFRESH_DAYS = Number(process.env.MOBILE_REFRESH_DAYS) || 30;
const NO_APP_PERMISSION = 'You don\'t have permission to login ERP application';

function refreshSecret() {
  return process.env.JWT_REFRESH_SECRET || `${process.env.JWT_SECRET}.mobile-refresh`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(userId) {
  return jwt.sign(
    { id: userId, typ: 'access', actor: 'user' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_EXPIRES },
  );
}

function signRefreshToken(userId, jti) {
  return jwt.sign(
    { id: userId, typ: 'refresh', actor: 'user', jti },
    refreshSecret(),
    { expiresIn: `${REFRESH_DAYS}d` },
  );
}

async function persistRefreshToken(userId, refreshToken, userAgent, deviceId = '') {
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await RefreshToken.create({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    userAgent: String(userAgent || '').slice(0, 240),
    deviceId: String(deviceId || '').slice(0, 120),
  });
}

async function findUser(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;

  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^${escaped}$`, 'i');

  return User.findOne({
    $or: [
      { username: exact },
      { email: exact },
      { companyEmail: exact },
    ],
  });
}

async function portalAppAllowed(user, isSystemAdmin) {
  if (isSystemAdmin) return true;
  if (!user.employeeId) return true;

  const employee = await EmployeeBasic.findOne({ employeeId: user.employeeId })
    .select('loginThrough')
    .lean();
  if (!employee) return true;
  return normalizeLoginThrough(employee).portalApp;
}

async function linkedEmployeeObjectId(employeeId) {
  if (!employeeId) return null;
  const emp = await EmployeeBasic.findOne({ employeeId }).select('_id profilePicture');
  return emp;
}

export async function mobileLogin(req, res) {
  try {
    const identifier = String(req.body?.email || req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const adminUsername = process.env.ADMIN_USERNAME || 'admin';
    const adminPassword = process.env.ADMIN_PASSWORD;
    const isAdminLogin =
      Boolean(adminPassword) &&
      identifier.toLowerCase() === adminUsername.toLowerCase() &&
      password === adminPassword;

    let user;
    if (isAdminLogin) {
      user = await User.findOne({
        $or: [
          { username: adminUsername.toLowerCase() },
          { email: process.env.SYSTEM_ADMIN_EMAIL || 'verp@vitsllc.com' },
        ],
      });
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }
    } else {
      user = await findUser(identifier);
      if (!user) {
        return res.status(401).json({ message: 'User not found' });
      }
      if (user.status !== 'Active') {
        return res.status(403).json({
          message: `Your account is ${user.status}. Please contact administrator.`,
        });
      }
      if (!user.password) {
        return res.status(401).json({ message: 'Password not set for this user' });
      }
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
    }

    const allowed = await portalAppAllowed(user, isAdminLogin);
    if (!allowed) {
      return res.status(403).json({ message: NO_APP_PERMISSION });
    }

    const incomingDevice = readMobileDeviceFromRequest(req);
    console.log('[mobileLogin] device', {
      username: user.username,
      deviceId: incomingDevice.deviceId || null,
      deviceName: incomingDevice.deviceName || null,
      location: incomingDevice.location || null,
      ipAddress: incomingDevice.ipAddress || null,
    });
    const deviceDenied = mobileDeviceLoginDenied(user, incomingDevice, { isSystemAdmin: isAdminLogin });
    if (deviceDenied) {
      return res.status(403).json({ message: deviceDenied });
    }

    recordMobileDeviceOnUser(user, incomingDevice, { isSystemAdmin: isAdminLogin });
    if (incomingDevice.ipAddress) {
      user.lastLoginIp = incomingDevice.ipAddress;
      if (user.mobileDevice && !isAdminLogin) {
        user.mobileDevice.ipAddress = incomingDevice.ipAddress;
        user.markModified('mobileDevice');
      }
    }

    const employee = await linkedEmployeeObjectId(user.employeeId);
    const accessToken = signAccessToken(user._id);
    const refreshToken = signRefreshToken(user._id, crypto.randomUUID());
    await persistRefreshToken(user._id, refreshToken, req.headers['user-agent'], incomingDevice.deviceId);

    user.lastLogin = new Date();
    await user.save();

    recordActivityAsync({
      req,
      module: 'Mobile',
      action: 'login',
      entityType: 'User',
      entityId: String(user._id),
      summary: 'user mobile login',
      actor: {
        userId: user._id,
        name: user.name || user.username,
        employeeId: user.employeeId || '',
      },
    });

    return res.status(200).json({
      message: 'Login successful',
      accessToken,
      refreshToken,
      expiresIn: ACCESS_EXPIRES,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        username: user.username,
        employeeId: user.employeeId,
        employeeObjectId: employee?._id || null,
        profilePicture: user.profilePicture || employee?.profilePicture || null,
      },
      mobileDevice: serializeMobileDevice(user),
    });
  } catch (error) {
    console.error('[mobileLogin]', error);
    return res.status(500).json({ message: error.message || 'Login failed.' });
  }
}

export async function refreshMobileToken(req, res) {
  try {
    const incoming = String(req.body?.refreshToken || '').trim();
    if (!incoming) {
      return res.status(400).json({ message: 'refreshToken is required.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(incoming, refreshSecret());
    } catch {
      return res.status(401).json({ message: 'Invalid or expired refresh token.' });
    }

    if (decoded?.typ !== 'refresh' || decoded?.actor !== 'user' || !decoded?.id) {
      return res.status(401).json({ message: 'Invalid refresh token.' });
    }

    const stored = await RefreshToken.findOne({
      userId: decoded.id,
      tokenHash: hashToken(incoming),
    });
    if (!stored || stored.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ message: 'Refresh token is not recognized.' });
    }

    const user = await User.findById(decoded.id).select('_id status employeeId mobileDevice');
    if (!user || user.status !== 'Active') {
      await RefreshToken.deleteMany({ userId: decoded.id });
      return res.status(401).json({ message: 'User is no longer allowed to sign in.' });
    }

    const allowed = await portalAppAllowed(user, false);
    if (!allowed) {
      await RefreshToken.deleteMany({ userId: decoded.id });
      return res.status(403).json({ message: NO_APP_PERMISSION });
    }

    const incomingDevice = readMobileDeviceFromRequest(req);
    const refreshDevice = {
      ...incomingDevice,
      deviceId: incomingDevice.deviceId || stored.deviceId || '',
    };
    const deviceDenied = mobileDeviceLoginDenied(user, refreshDevice, { isSystemAdmin: false });
    if (deviceDenied) {
      await stored.deleteOne();
      return res.status(403).json({ message: deviceDenied });
    }

    recordMobileDeviceOnUser(user, refreshDevice);
    if (user.isModified()) {
      await user.save();
    }

    await stored.deleteOne();
    const accessToken = signAccessToken(user._id);
    const nextRefresh = signRefreshToken(user._id, crypto.randomUUID());
    await persistRefreshToken(user._id, nextRefresh, req.headers['user-agent'], refreshDevice.deviceId);

    return res.status(200).json({
      accessToken,
      refreshToken: nextRefresh,
      expiresIn: ACCESS_EXPIRES,
    });
  } catch (error) {
    console.error('[refreshMobileToken]', error);
    return res.status(500).json({ message: 'Failed to refresh session.' });
  }
}

export async function reportMobileDevice(req, res) {
  try {
    const userId = req.user?.id || req.user?._id;
    if (!userId) {
      return res.status(401).json({ message: 'Not authorized.' });
    }

    const user = await User.findById(userId).select('username status mobileDevice lastLoginIp');
    if (!user || user.status !== 'Active') {
      return res.status(401).json({ message: 'User is no longer allowed to sign in.' });
    }

    const incomingDevice = readMobileDeviceFromRequest(req);
    const deviceDenied = mobileDeviceLoginDenied(user, incomingDevice, {
      isSystemAdmin: Boolean(req.user?.isSystemSuperUser),
    });
    if (deviceDenied) {
      return res.status(403).json({ message: deviceDenied });
    }

    recordMobileDeviceOnUser(user, incomingDevice, {
      isSystemAdmin: Boolean(req.user?.isSystemSuperUser),
    });
    if (user.isModified()) {
      await user.save();
    }

    return res.status(200).json({
      message: 'Device recorded.',
      mobileDevice: serializeMobileDevice(user),
    });
  } catch (error) {
    console.error('[reportMobileDevice]', error);
    return res.status(500).json({ message: 'Failed to record device.' });
  }
}

export async function mobileLogout(req, res) {
  try {
    const incoming = String(req.body?.refreshToken || '').trim();
    if (incoming) {
      await RefreshToken.deleteOne({ tokenHash: hashToken(incoming) });
    }
    return res.status(200).json({ message: 'Logged out.' });
  } catch (_error) {
    return res.status(500).json({ message: 'Logout failed.' });
  }
}

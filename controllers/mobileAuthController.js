import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import RefreshToken from '../models/RefreshToken.js';
import { recordActivityAsync } from '../utils/activityLog.js';
import { normalizeLoginThrough } from '../utils/loginThrough.js';
import MobileLoginOtp from '../models/MobileLoginOtp.js';
import { sendTextMessage } from '../services/whatsappService.js';
import { resolveEmployeeWhatsAppPhone } from '../utils/sendToolsAssetWhatsAppReport.js';
import {
  applyDeviceTrust,
  expireDeviceTrustIfNeeded,
  getDeviceTrust,
  isDeviceTrustedForOtp,
  isMobileReviewBypass,
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

function maskPhone(phone) {
  const value = String(phone || '').replace(/\s/g, '');
  if (value.length < 7) return 'WhatsApp';
  return `${value.slice(0, 4)}****${value.slice(-3)}`;
}

function hasLoginCoordinates(device) {
  return Number.isFinite(device?.latitude) && Number.isFinite(device?.longitude);
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

async function resolveLoginWhatsApp(user) {
  const fromEmployee = await resolveEmployeeWhatsAppPhone(user.employeeId);
  if (fromEmployee) return fromEmployee;
  return '';
}

async function sendLoginOtp(user, deviceId) {
  const phone = await resolveLoginWhatsApp(user);
  if (!phone) {
    const error = new Error('No WhatsApp number on this user. Ask admin to add it on the employee profile.');
    error.status = 400;
    throw error;
  }

  await MobileLoginOtp.deleteMany({ userId: user._id });
  const otp = String(crypto.randomInt(100000, 1000000));
  const otpToken = crypto.randomUUID();
  await MobileLoginOtp.create({
    otpToken,
    userId: user._id,
    otpHash: hashOtp(otp),
    deviceId: String(deviceId || '').trim(),
    phone,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });

  const sent = await sendTextMessage(
    phone,
    `Your VERP login OTP is ${otp}. It is valid for 5 minutes. Do not share this code.`,
    {
      skipPaidChannelCheck: true,
      source: 'mobile_login_otp',
      employeeId: user.employeeId || '',
    },
  );
  if (!sent?.success) {
    await MobileLoginOtp.deleteMany({ otpToken });
    const error = new Error(sent?.error || 'Could not send WhatsApp OTP.');
    error.status = 502;
    throw error;
  }

  const maskedPhone = maskPhone(phone);
  console.log('[mobileLogin] OTP sent via WhatsApp', {
    username: user.username,
    employeeId: user.employeeId || null,
    maskedPhone,
  });
  return { otpToken, maskedPhone };
}

async function issueMobileSession(req, res, user, incomingDevice, isAdminLogin, { fixDevice } = {}) {
  if (isMobileReviewBypass(user)) {
    applyDeviceTrust(user, false);
  }
  expireDeviceTrustIfNeeded(user);
  const deviceDenied = mobileDeviceLoginDenied(user, incomingDevice, { isSystemAdmin: isAdminLogin });
  if (deviceDenied) {
    return res.status(403).json({ message: deviceDenied });
  }

  recordMobileDeviceOnUser(user, incomingDevice, { isSystemAdmin: isAdminLogin });
  if (!isAdminLogin && fixDevice === true && incomingDevice.deviceId) {
    applyDeviceTrust(user, true);
  }
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
    needsOtp: false,
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
    deviceTrust: getDeviceTrust(user),
  });
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
    expireDeviceTrustIfNeeded(user);
    const deviceDenied = mobileDeviceLoginDenied(user, incomingDevice, { isSystemAdmin: isAdminLogin });
    if (deviceDenied) {
      if (user.isModified?.()) await user.save();
      return res.status(403).json({ message: deviceDenied });
    }
    if (isMobileReviewBypass(user)) {
      return issueMobileSession(req, res, user, incomingDevice, isAdminLogin);
    }
    if (isAdminLogin || isDeviceTrustedForOtp(user, incomingDevice.deviceId)) {
      if (!hasLoginCoordinates(incomingDevice)) {
        return res.status(400).json({
          code: 'LOCATION_REQUIRED',
          message: 'Turn on location, then finish login.',
        });
      }
      return issueMobileSession(req, res, user, incomingDevice, isAdminLogin);
    }
    if (user.isModified?.()) {
      await user.save();
    }

    const otp = await sendLoginOtp(user, incomingDevice.deviceId);
    return res.status(200).json({
      needsOtp: true,
      otpToken: otp.otpToken,
      maskedPhone: otp.maskedPhone,
      message: `OTP sent to WhatsApp ${otp.maskedPhone}`,
    });
  } catch (error) {
    console.error('[mobileLogin]', error);
    return res.status(error.status || 500).json({ message: error.message || 'Login failed.' });
  }
}

export async function verifyMobileOtp(req, res) {
  try {
    const otpToken = String(req.body?.otpToken || '').trim();
    const otp = String(req.body?.otp || '').replace(/\s/g, '');
    if (!otpToken || !otp) {
      return res.status(400).json({ message: 'Enter the OTP sent to WhatsApp.' });
    }

    const challenge = await MobileLoginOtp.findOne({ otpToken });
    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired. Tap Login again.' });
    }
    if (challenge.attempts >= 5) {
      await challenge.deleteOne();
      return res.status(400).json({ message: 'Too many attempts. Tap Login again.' });
    }
    if (challenge.otpHash !== hashOtp(otp)) {
      challenge.attempts += 1;
      if (challenge.attempts >= 5) {
        await challenge.deleteOne();
        return res.status(400).json({ message: 'Too many attempts. Tap Login again.' });
      }
      await challenge.save();
      return res.status(400).json({ message: 'Wrong OTP. Check WhatsApp and try again.' });
    }

    const user = await User.findById(challenge.userId);
    if (!user || user.status !== 'Active') {
      await challenge.deleteOne();
      return res.status(401).json({ message: 'User is no longer allowed to sign in.' });
    }

    const incomingDevice = readMobileDeviceFromRequest(req);
    if (!incomingDevice.deviceId) incomingDevice.deviceId = challenge.deviceId;
    if (!hasLoginCoordinates(incomingDevice)) {
      return res.status(400).json({
        code: 'LOCATION_REQUIRED',
        message: 'Turn on location, then finish login.',
      });
    }
    await challenge.deleteOne();
    return issueMobileSession(req, res, user, incomingDevice, false, { fixDevice: true });
  } catch (error) {
    console.error('[verifyMobileOtp]', error);
    return res.status(500).json({ message: error.message || 'OTP check failed.' });
  }
}

export async function resendMobileOtp(req, res) {
  try {
    const otpToken = String(req.body?.otpToken || '').trim();
    if (!otpToken) {
      return res.status(400).json({ message: 'OTP session is missing. Tap Login again.' });
    }
    const challenge = await MobileLoginOtp.findOne({ otpToken });
    if (!challenge) {
      return res.status(400).json({ message: 'OTP expired. Tap Login again.' });
    }
    const user = await User.findById(challenge.userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }
    const otp = await sendLoginOtp(user, challenge.deviceId);
    return res.status(200).json({
      needsOtp: true,
      otpToken: otp.otpToken,
      maskedPhone: otp.maskedPhone,
      message: `OTP sent to WhatsApp ${otp.maskedPhone}`,
    });
  } catch (error) {
    console.error('[resendMobileOtp]', error);
    return res.status(error.status || 500).json({ message: error.message || 'Could not resend OTP.' });
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

    const user = await User.findById(decoded.id).select('_id status employeeId mobileDevice mobileReviewBypass');
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

    const user = await User.findById(userId).select('username status mobileDevice mobileReviewBypass lastLoginIp');
    if (!user || user.status !== 'Active') {
      return res.status(401).json({ message: 'User is no longer allowed to sign in.' });
    }

    expireDeviceTrustIfNeeded(user);
    const incomingDevice = readMobileDeviceFromRequest(req);
    if (req.body?.fixDevice === false) {
      applyDeviceTrust(user, false);
    }
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
      deviceTrust: getDeviceTrust(user),
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

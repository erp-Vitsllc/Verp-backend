/**
 * Sets the mobile login USER / 1234 with OTP skipped.
 * Safe to run more than once.
 *
 *   node scripts/ensureUserLogin.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { emptyMobileDevice } from '../utils/userMobileDevice.js';

dotenv.config({ path: '.env' });

const USERNAME = 'USER';
const PASSWORD = '1234';
const EMAIL = 'user@verp.local';
const DISPLAY_NAME = 'USER';

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is missing in VERP_backend/.env');
  }

  await mongoose.connect(process.env.MONGO_URI, { family: 4 });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let user = await User.findOne({ username: /^USER$/i });

  if (!user) {
    const emailTaken = await User.findOne({ email: EMAIL }).select('_id username');
    if (emailTaken) {
      throw new Error(`Email ${EMAIL} is already used by ${emailTaken.username}`);
    }
    user = await User.create({
      username: USERNAME,
      name: DISPLAY_NAME,
      email: EMAIL,
      companyEmail: EMAIL,
      password: passwordHash,
      employeeId: null,
      status: 'Active',
      enablePortalAccess: true,
      isAdmin: false,
      mobileReviewBypass: true,
      mobileDevice: emptyMobileDevice(),
      passwordExpiryDate: new Date('2099-12-31'),
      passwordHistory: [],
      loginAttempts: 0,
      lockUntil: null,
    });
    console.log('Created user USER');
  } else {
    user.username = USERNAME;
    user.name = user.name || DISPLAY_NAME;
    user.password = passwordHash;
    user.status = 'Active';
    user.enablePortalAccess = true;
    user.mobileReviewBypass = true;
    user.mobileDevice = emptyMobileDevice();
    user.passwordExpiryDate = new Date('2099-12-31');
    user.loginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    console.log('Updated user USER');
  }

  console.log('Username: USER');
  console.log('Password: 1234');
  console.log('OTP: none');
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message || error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});

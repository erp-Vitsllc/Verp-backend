/**
 * Creates / refreshes the App Store review employee + login user.
 * Safe to run more than once. Does not change other employees.
 *
 *   node scripts/ensureAppleReviewDemo.js
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeeContact from '../models/EmployeeContact.js';
import Company from '../models/Company.js';
import Attendance from '../models/Attendance.js';
import SalaryEnrollment from '../models/SalaryEnrollment.js';
import Loan from '../models/Loan.js';
import EmployeeHubRequest from '../models/EmployeeHubRequest.js';
import UtilityEntry from '../models/UtilityEntry.js';
import { emptyMobileDevice } from '../utils/userMobileDevice.js';

dotenv.config({ path: '.env' });

const EMPLOYEE_ID = 'VEGA-DEMO-APPLE';
const USERNAME = 'applereview';
const PASSWORD = 'Review123';
const EMAIL = 'applereview@verp.demo';
const DISPLAY_NAME = 'Demo Employee';

function dubaiDateKey(offsetDays = 0) {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const dubai = new Date(utc + 4 * 60 * 60000);
  dubai.setDate(dubai.getDate() + offsetDays);
  const y = dubai.getFullYear();
  const m = String(dubai.getMonth() + 1).padStart(2, '0');
  const d = String(dubai.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function weekday(dateKey) {
  return new Date(`${dateKey}T12:00:00+04:00`).getDay();
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is missing in VERP_backend/.env');
  }

  await mongoose.connect(process.env.MONGO_URI, { family: 4 });
  console.log('Mongo connected');

  const company = await Company.findOne({}).select('_id').lean();
  const today = dubaiDateKey(0);
  const thisMonth = today.slice(0, 7);

  let employee = await EmployeeBasic.findOne({ employeeId: EMPLOYEE_ID });
  if (!employee) {
    employee = await EmployeeBasic.create({
      firstName: 'Demo',
      lastName: 'Employee',
      employeeId: EMPLOYEE_ID,
      role: 'Demo',
      department: 'Review',
      designation: 'App Review',
      staffType: 'office',
      company: company?._id || null,
      status: 'Permanent',
      profileApprovalStatus: 'active',
      profileStatus: 'active',
      email: EMAIL,
      companyEmail: EMAIL,
      enablePortalAccess: true,
      loginThrough: { portalApp: true, web: false },
      dateOfJoining: new Date('2025-01-01'),
    });
    console.log('Created employee', EMPLOYEE_ID);
  } else {
    employee.firstName = 'Demo';
    employee.lastName = 'Employee';
    employee.status = 'Permanent';
    employee.profileApprovalStatus = 'active';
    employee.profileStatus = 'active';
    employee.enablePortalAccess = true;
    employee.loginThrough = { portalApp: true, web: false };
    employee.email = EMAIL;
    employee.companyEmail = EMAIL;
    if (company?._id && !employee.company) employee.company = company._id;
    await employee.save();
    console.log('Updated employee', EMPLOYEE_ID);
  }

  await EmployeeContact.findOneAndUpdate(
    { employeeId: EMPLOYEE_ID },
    {
      employeeId: EMPLOYEE_ID,
      contactNumber: '971500000000',
      whatsappNumber: '971500000000',
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  let user = await User.findOne({
    $or: [{ username: USERNAME }, { email: EMAIL }, { employeeId: EMPLOYEE_ID }],
  });
  if (!user) {
    user = await User.create({
      username: USERNAME,
      name: DISPLAY_NAME,
      email: EMAIL,
      companyEmail: EMAIL,
      password: passwordHash,
      employeeId: EMPLOYEE_ID,
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
    console.log('Created user', USERNAME);
  } else {
    user.username = USERNAME;
    user.name = DISPLAY_NAME;
    user.email = EMAIL;
    user.companyEmail = EMAIL;
    user.password = passwordHash;
    user.employeeId = EMPLOYEE_ID;
    user.status = 'Active';
    user.enablePortalAccess = true;
    user.isAdmin = false;
    user.mobileReviewBypass = true;
    user.mobileDevice = emptyMobileDevice();
    user.passwordExpiryDate = new Date('2099-12-31');
    user.loginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    console.log('Updated user', USERNAME);
  }

  await SalaryEnrollment.findOneAndUpdate(
    { employeeId: EMPLOYEE_ID },
    { employeeId: EMPLOYEE_ID, fromMonth: '2025-01', salaryDate: '1', processDate: '1' },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  const sampleDays = [];
  for (let offset = -8; offset <= -1; offset += 1) {
    const date = dubaiDateKey(offset);
    if (!date.startsWith(thisMonth)) continue;
    const day = weekday(date);
    if (day === 0 || day === 6) continue;
    sampleDays.push(date);
  }

  for (const date of sampleDays) {
    await Attendance.findOneAndUpdate(
      { date, employeeMongoId: String(employee._id) },
      {
        date,
        employeeMongoId: String(employee._id),
        employeeId: EMPLOYEE_ID,
        employeeName: DISPLAY_NAME,
        statusKey: 'on_office',
        statusLabel: 'Present',
        timeIn: '09:00:00',
        timeOut: '18:00:00',
        punchSource: 'app',
        checkOutSource: 'app',
        approvalStatus: 'approved',
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  await Attendance.deleteMany({ date: today, employeeMongoId: String(employee._id) });
  console.log('Cleared today punch so Check in is available');

  const existingLoan = await Loan.findOne({ employeeId: EMPLOYEE_ID, loanId: 'DEMO-LOAN-001' });
  if (!existingLoan) {
    await Loan.create({
      employeeId: EMPLOYEE_ID,
      employeeObjectId: employee._id,
      loanId: 'DEMO-LOAN-001',
      type: 'Loan',
      amount: 500,
      paidAmount: 0,
      repaidAmount: 0,
      duration: 5,
      monthStart: thisMonth,
      originalMonthStart: thisMonth,
      originalDuration: 5,
      reason: 'Sample loan for App Store review',
      status: 'Approved',
      approvalStatus: 'Approved',
      appliedDate: new Date(),
    });
    console.log('Created sample loan');
  }

  const existingTask = await EmployeeHubRequest.findOne({
    requesterEmpId: EMPLOYEE_ID,
    description: 'Sample task for App Store review',
  });
  if (!existingTask) {
    await EmployeeHubRequest.create({
      kind: 'certificate',
      description: 'Sample task for App Store review',
      requester: employee._id,
      requesterEmpId: EMPLOYEE_ID,
      requesterName: DISPLAY_NAME,
      assignedTo: employee._id,
      assignedToEmpId: EMPLOYEE_ID,
      status: 'Pending',
    });
    console.log('Created sample task');
  }

  const utilityId = 'demo-apple-utility';
  await UtilityEntry.findOneAndUpdate(
    { _id: utilityId },
    {
      _id: utilityId,
      type: 'Internet',
      status: 'Active',
      values: { provider: 'Demo ISP', accountNumber: 'DEMO-NET-001' },
      assignedTo: DISPLAY_NAME,
      assignedToType: 'Employee',
      assignedToId: String(employee._id),
      assignedAt: new Date(),
      pendingStatusChange: null,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  console.log('\nApple review account is ready');
  console.log('Username:  applereview');
  console.log('Password:  Review123');
  console.log('OTP:       none (needsOtp is not returned)');
  console.log('Employee:  VEGA-DEMO-APPLE');

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});

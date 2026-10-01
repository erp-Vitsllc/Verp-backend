import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: '.env' });

await mongoose.connect(process.env.MONGO_URI, { family: 4 });
const db = mongoose.connection.db;

const emps = await db.collection('employeebasics').find({
  $or: [
    { employeeId: 'VEGA-HR-00008' },
    { firstName: /jishnu/i },
    { lastName: /baburajan|pillai/i },
    { employeeName: /jishnu/i },
  ],
}).project({
  firstName: 1, lastName: 1, employeeId: 1, companyEmail: 1, email: 1, workEmail: 1,
  status: 1, profileStatus: 1,
}).toArray();

const ids = emps.map((e) => String(e._id));
const codes = emps.map((e) => e.employeeId).filter(Boolean);

console.log('EMPLOYEES', JSON.stringify(emps.map((e) => ({
  id: String(e._id),
  employeeId: e.employeeId,
  name: `${e.firstName} ${e.lastName}`,
  status: e.status,
  profileStatus: e.profileStatus,
  companyEmail: e.companyEmail || '',
  email: e.email || '',
  workEmail: e.workEmail || '',
})), null, 2));

const users = await db.collection('users').find({
  $or: [
    { employeeId: { $in: codes } },
    { name: /JISHNU BABURAJAN/i },
    { email: { $in: emps.flatMap((e) => [e.companyEmail, e.email, e.workEmail].filter(Boolean)) } },
  ],
}).project({ name: 1, username: 1, employeeId: 1, email: 1, companyEmail: 1, status: 1 }).toArray();

console.log('USERS', JSON.stringify(users.map((u) => ({
  id: String(u._id),
  name: u.name,
  username: u.username,
  employeeId: u.employeeId,
  email: u.email,
  companyEmail: u.companyEmail,
  status: u.status,
})), null, 2));

const collections = (await db.listCollections().toArray()).map((c) => c.name).filter((n) => /attend|employee|user/i.test(n));
console.log('COLLECTIONS', collections);

const attendance = await db.collection('attendances').find({
  date: { $in: ['2026-10-01', '2026-09-30', '2026-10-02'] },
  $or: [
    { employeeMongoId: { $in: ids } },
    { employeeId: { $in: codes } },
    { employeeName: /JISHNU BABURAJAN/i },
  ],
}).toArray();

console.log('ATTENDANCE', JSON.stringify(attendance.map((a) => ({
  id: String(a._id),
  date: a.date,
  employeeMongoId: a.employeeMongoId,
  mongoType: a.employeeMongoId == null ? 'null' : a.employeeMongoId.constructor?.name || typeof a.employeeMongoId,
  employeeId: a.employeeId,
  employeeName: a.employeeName,
  statusKey: a.statusKey,
  statusLabel: a.statusLabel,
  timeIn: a.timeIn,
  timeOut: a.timeOut,
  punchSource: a.punchSource,
  updatedAt: a.updatedAt,
})), null, 2));

const dupGroups = await db.collection('attendances').aggregate([
  { $match: { date: '2026-10-01' } },
  { $group: {
    _id: '$employeeMongoId',
    n: { $sum: 1 },
    names: { $addToSet: '$employeeName' },
    times: { $push: '$timeIn' },
    codes: { $addToSet: '$employeeId' },
  } },
  { $match: { n: { $gt: 1 } } },
  { $limit: 30 },
]).toArray();
console.log('DUP_TODAY', JSON.stringify(dupGroups, null, 2));

const codeDups = await db.collection('employeebasics').aggregate([
  { $match: { employeeId: { $in: codes } } },
  { $group: { _id: '$employeeId', n: { $sum: 1 }, ids: { $push: { $toString: '$_id' } } } },
]).toArray();
console.log('CODE_COUNTS', JSON.stringify(codeDups, null, 2));

const empCount = await db.collection('employeebasics').countDocuments();
const todayCount = await db.collection('attendances').countDocuments({ date: '2026-10-01' });
const anyAtt = await db.collection('attendances').countDocuments();
const sample = await db.collection('attendances').find({}).sort({ date: -1 }).limit(3).project({ date: 1, employeeName: 1, employeeId: 1, timeIn: 1, statusKey: 1 }).toArray();
const nameHits = await db.collection('employeebasics').find({
  $or: [
    { firstName: /jishnu|akash|arun/i },
    { lastName: /pillai|neupane/i },
  ],
}).project({ firstName: 1, lastName: 1, employeeId: 1 }).limit(20).toArray();
console.log('COUNTS', { empCount, todayCount, anyAtt });
console.log('LATEST_ATT', JSON.stringify(sample, null, 2));
console.log('NAME_HITS', JSON.stringify(nameHits.map((e) => ({
  id: String(e._id),
  employeeId: e.employeeId,
  name: `${e.firstName} ${e.lastName}`,
})), null, 2));

await mongoose.disconnect();

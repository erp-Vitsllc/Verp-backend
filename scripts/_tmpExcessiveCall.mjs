import 'dotenv/config';
import axios from 'axios';
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGO_URI);
const snap = await mongoose.connection.collection('locatorgpssnapshots').findOne(
    { deviceId: 71601 },
    { projection: { deviceName: 1, uniqueId: 1, deviceId: 1 } },
);
console.log('snap', { name: snap?.deviceName, uniqueId: snap?.uniqueId, deviceId: snap?.deviceId });
await mongoose.disconnect();

const login = await axios.post('https://pro.mylocatorplus.com/locator-clients/api/v1/login', {
    user_name: process.env.LOCATOR_USERNAME,
    user_password: process.env.LOCATOR_PASSWORD,
    isAdmin: process.env.LOCATOR_IS_ADMIN || 'customer',
});
const token = login.data?.data?.token;
const vehicles = login.data?.data?.vehicles || [];
const match = vehicles.find((v) => /17912|Veloz/i.test(JSON.stringify(v)));
console.log('vehicleKeys', vehicles[0] ? Object.keys(vehicles[0]) : null);
console.log('match', match ? {
    id: match.id,
    name: match.name,
    uniqueId: match.uniqueId,
    vehicleID: match.vehicleID,
} : null);

const body = {
    fromDate: '28-09-2026 00:00:00',
    toDate: '30-09-2026 00:00:00',
    reportID: 62,
    vehIDs: [[
        snap?.deviceName || 'Veloz 17912 Abid',
        snap?.uniqueId || match?.uniqueId || '',
        Number(match?.id || match?.vehicleID || 71601),
    ]],
};
console.log('body', JSON.stringify(body));

const res = await axios.post(
    'https://pro.mylocatorplus.com/gateway/index.php/ReportCreator',
    JSON.stringify(body),
    {
        headers: {
            Xtoken: token,
            'X-XSRF-TOKEN': token,
            'Content-Type': 'application/json',
        },
        timeout: 60000,
        validateStatus: () => true,
    },
);
const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
console.log('status', res.status, 'len', text.length);
console.log(text.slice(0, 1500));

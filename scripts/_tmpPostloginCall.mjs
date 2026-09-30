import 'dotenv/config';
import axios from 'axios';

const body = {
    isAdmin: process.env.LOCATOR_IS_ADMIN || 'pro',
    user_name: process.env.LOCATOR_USERNAME,
    user_password: process.env.LOCATOR_PASSWORD,
};
const urls = [
    'https://pro.mylocatorplus.com/gateway/index.php/api-v1/user/postlogin',
    'https://pro.mylocatorplus.com/gateway/index.php/user/postlogin',
    'https://pro.mylocatorplus.com/locator-clients/api/v1/user/postlogin',
];
for (const url of urls) {
    try {
        const res = await axios.post(url, body, {
            timeout: 30000,
            validateStatus: () => true,
            headers: { 'Content-Type': 'application/json' },
        });
        const data = res.data;
        const text = typeof data === 'string' ? data : JSON.stringify(data);
        const keys = data && typeof data === 'object' ? Object.keys(data) : [];
        const nested = data?.data && typeof data.data === 'object' ? Object.keys(data.data) : [];
        const tokenLen = String(data?.token || data?.data?.token || '').length;
        console.log(url);
        console.log(' status', res.status, 'keys', keys, 'nested', nested, 'tokenLen', tokenLen, 'len', text.length);
        console.log(' head', text.slice(0, 220).replace(process.env.LOCATOR_PASSWORD, '***'));
    } catch (err) {
        console.log(url, 'ERR', err.message);
    }
}

import dotenv from 'dotenv';
dotenv.config();

const base = 'http://localhost:5000/api';
const email = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD;

if (!password) {
    console.error('No ADMIN_PASSWORD');
    process.exit(1);
}

const loginRes = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
});
const loginJson = await loginRes.json();
const token = loginJson.token;
if (!token) {
    console.error('Login failed', loginRes.status, loginJson);
    process.exit(1);
}

const endpoints = [
    '/AssetType?scope=tools',
    '/AssetAccessoryCatalog',
    '/AssetType/meta/role',
    '/Employee/me',
    '/Company?scope=responsibilities',
];

for (const path of endpoints) {
    const r = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const text = await r.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text.slice(0, 200);
    }
    console.log(path, r.status, typeof body === 'object' ? JSON.stringify(body).slice(0, 300) : body);
}

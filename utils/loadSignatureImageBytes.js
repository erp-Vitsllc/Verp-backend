import axios from 'axios';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import s3Client, { bucketName } from '../config/s3Client.js';
import { downloadS3ObjectBytes, getSignedFileUrl } from './s3Upload.js';
import { resolveSignatureUrlForPdf } from './generateBulkAssetInventoryPdf.js';
import { emailFrontendUrl } from './resolveFrontendBaseUrl.js';

function signatureObject(sig) {
    if (!sig) return null;
    if (typeof sig === 'string') return { url: sig };
    return sig;
}

async function findLatestSignatureKeyForEmployee(employeeId) {
    if (!employeeId) return null;
    const prefix = `employee-signatures/${employeeId}/`;
    try {
        const res = await s3Client.send(
            new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix }),
        );
        const keys = (res.Contents || [])
            .map((c) => c.Key)
            .filter((k) => k && /\.(png|jpe?g|webp)$/i.test(k));
        if (!keys.length) return null;
        keys.sort((a, b) => b.localeCompare(a));
        return keys[0];
    } catch {
        return null;
    }
}

async function downloadKey(key) {
    if (!key) return null;
    return downloadS3ObjectBytes(key);
}

/**
 * Load digital signature image bytes from employee profile signature field.
 * Uses direct S3 download first; falls back to newest file in employee-signatures/{id}/.
 */
export async function loadSignatureImageBytes(sig, employeeId = null) {
    const obj = signatureObject(sig);
    if (!obj && !employeeId) return null;

    if (obj?.url?.startsWith('data:')) {
        return Buffer.from(obj.url.split(',')[1], 'base64');
    }

    const keys = obj ? [obj.publicId, obj.url, obj.data].filter(Boolean) : [];
    for (const key of keys) {
        if (String(key).startsWith('data:')) {
            return Buffer.from(String(key).split(',')[1], 'base64');
        }
        const bytes = await downloadKey(key);
        if (bytes?.length) return bytes;
    }

    const empId = employeeId || obj?.employeeId;
    if (empId) {
        const latestKey = await findLatestSignatureKeyForEmployee(empId);
        const bytes = await downloadKey(latestKey);
        if (bytes?.length) return bytes;
    }

    for (const key of keys) {
        if (!key || String(key).startsWith('data:')) continue;
        try {
            const signed = await getSignedFileUrl(key);
            if (signed && /^https:\/\//i.test(signed)) {
                const res = await axios.get(signed, {
                    responseType: 'arraybuffer',
                    timeout: 25000,
                    maxRedirects: 5,
                    validateStatus: (s) => s === 200,
                });
                if (res.data?.byteLength) return Buffer.from(res.data);
            }
        } catch {
            /* try next */
        }
    }

    const apiUrl = resolveSignatureUrlForPdf(obj, emailFrontendUrl());
    if (apiUrl && /^https:\/\//i.test(apiUrl) && !/localhost|127\.0\.0\.1/i.test(apiUrl)) {
        try {
            const res = await axios.get(apiUrl, {
                responseType: 'arraybuffer',
                timeout: 25000,
                validateStatus: (s) => s === 200,
            });
            if (res.data?.byteLength) return Buffer.from(res.data);
        } catch {
            /* ignore */
        }
    }

    return null;
}

import dotenv from 'dotenv';

dotenv.config();

/** S3-compatible object storage (Wasabi). Legacy IDRIVE_* env names still supported. */
export function getS3Endpoint() {
    const raw = process.env.S3_ENDPOINT || process.env.IDRIVE_ENDPOINT || '';
    if (!raw) return '';
    return raw.startsWith('http') ? raw : `https://${raw}`;
}

export function getS3Region() {
    return process.env.S3_REGION || process.env.IDRIVE_REGION || 'ap-southeast-1';
}

export function getS3AccessKey() {
    return process.env.S3_ACCESS_KEY || process.env.IDRIVE_ACCESS_KEY || '';
}

export function getS3SecretKey() {
    return process.env.S3_SECRET_KEY || process.env.IDRIVE_SECRET_KEY || '';
}

export function getS3BucketName() {
    return String(process.env.S3_BUCKET_NAME || process.env.IDRIVE_BUCKET_NAME || '').trim();
}

/** Extra buckets to try on read when object is missing from the primary bucket. */
export function getS3FallbackBucketNames() {
    const primary = getS3BucketName();
    const fromEnv = String(process.env.S3_FALLBACK_BUCKETS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    // Team historically used both names against the same shared Mongo keys.
    const knownAlternates = ['verp-storage', 'local-bucket-verp'];
    const merged = [...fromEnv];
    for (const name of knownAlternates) {
        if (name && name !== primary && !merged.includes(name)) merged.push(name);
    }
    return merged.filter((name) => name && name !== primary);
}

/** Ordered list: primary write bucket first, then read fallbacks. */
export function getS3ReadBucketNames() {
    const primary = getS3BucketName();
    const buckets = [];
    if (primary) buckets.push(primary);
    for (const name of getS3FallbackBucketNames()) {
        if (name && !buckets.includes(name)) buckets.push(name);
    }
    return buckets;
}

const ALLOWED_STORAGE_HOST_PATTERNS = [
    /\.wasabisys\.com$/i,
    /\.idrivee2\.com$/i,
    /^s3\.[^.]+\.amazonaws\.com$/i,
];

export function isAllowedStorageHostname(hostname = '') {
    const h = String(hostname || '').toLowerCase();
    if (!h || h.includes('localhost') || h === '127.0.0.1') return false;
    return ALLOWED_STORAGE_HOST_PATTERNS.some((re) => re.test(h));
}

/** SSRF-safe check for externally fetched attachment URLs. */
export function isValidStorageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        return isAllowedStorageHostname(parsed.hostname);
    } catch {
        return false;
    }
}

export function looksLikeObjectStorageUrl(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;
    try {
        const { hostname } = new URL(url);
        return isAllowedStorageHostname(hostname) || /\.s3\./i.test(url);
    } catch {
        return false;
    }
}

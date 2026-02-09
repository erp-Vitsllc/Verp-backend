/**
 * Validates if the provided URL is a secure, allowed storage URL (IDrive e2).
 * Helper for preventing SSRF attacks.
 * 
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if valid and allowed, false otherwise
 */
export const isValidStorageUrl = (url) => {
    if (!url || typeof url !== 'string') return false;

    // Strict regex for IDrive e2: https://subdomain.idrivee2.com/path
    // This explicitly blocks local IPs, localhost, and other domains
    const idriveRegex = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.idrivee2\.com\/[^\s<>]+$/i;

    if (!idriveRegex.test(url)) return false;

    try {
        const parsed = new URL(url);
        // Secondary check for sanity
        const hostname = parsed.hostname.toLowerCase();
        if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) return false;
        return parsed.protocol === 'https:';
    } catch (e) {
        return false;
    }
};

/**
 * Validates if the provided URL is a secure, allowed storage URL (IDrive e2).
 * Helper for preventing SSRF attacks.
 * 
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if valid and allowed, false otherwise
 */
export const isValidStorageUrl = (url) => {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        // Strict whitelist of allowed hostnames
        // adjust this if you use other providers (e.g. AWS S3, Cloudinary)
        return parsed.hostname === 'idrivee2.com' || parsed.hostname.endsWith('.idrivee2.com');
    } catch (e) {
        return false;
    }
};

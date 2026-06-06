import { isValidStorageUrl as isAllowedStorageUrl } from '../config/storageConfig.js';

/**
 * Validates if the provided URL is a secure, allowed object-storage URL (Wasabi / legacy iDrive).
 * Helper for preventing SSRF attacks.
 */
export const isValidStorageUrl = (url) => isAllowedStorageUrl(url);

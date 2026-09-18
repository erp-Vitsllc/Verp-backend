import NotificationEmailPermission from '../models/NotificationEmailPermission.js';
import {
    buildPermissionCatalogView,
    clearNotificationEmailPermissionCache,
} from '../utils/notificationEmailPermission.js';
import { flattenNotificationEmailCatalog } from '../constants/notificationEmailCatalog.js';
import { canManageNotificationEmailPermission } from '../utils/settingsInboxAccess.js';

const ALLOWED_KEYS = new Set(flattenNotificationEmailCatalog().map((item) => item.key));

export async function getNotificationEmailPermissionAccess(req, res) {
    try {
        const allowed = await canManageNotificationEmailPermission(req);
        return res.status(200).json({ allowed });
    } catch (error) {
        console.error('[NotificationEmailPermission] access check failed:', error?.message || error);
        return res.status(200).json({ allowed: false });
    }
}

export async function listNotificationEmailPermissions(req, res) {
    try {
        const groups = await buildPermissionCatalogView();
        return res.status(200).json({ groups });
    } catch (error) {
        console.error('[NotificationEmailPermission] list failed:', error?.message || error);
        return res.status(500).json({ message: error?.message || 'Failed to load permissions' });
    }
}

export async function getNotificationEmailPermissionMap(req, res) {
    try {
        const groups = await buildPermissionCatalogView();
        const map = {};
        const byDashboardType = {};
        const catalog = flattenNotificationEmailCatalog();
        for (const group of groups) {
            for (const mod of group.modules) {
                for (const item of mod.items) {
                    map[item.key] = {
                        notification: item.notification,
                        email: item.email,
                        whatsapp: item.whatsapp,
                    };
                }
            }
        }
        for (const item of catalog) {
            const channels = map[item.key];
            for (const type of item.dashboardTypes || []) {
                byDashboardType[type] = channels;
            }
        }
        return res.status(200).json({ map, byDashboardType });
    } catch (error) {
        return res.status(500).json({ message: error?.message || 'Failed to load permission map' });
    }
}

function parseChannelFlag(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return undefined;
}

export async function updateNotificationEmailPermission(req, res) {
    try {
        const rawKeys = Array.isArray(req.body?.eventKeys)
            ? req.body.eventKeys
            : [req.body?.eventKey || req.params?.eventKey];
        const eventKeys = [...new Set(
            rawKeys.map((key) => String(key || '').trim()).filter((key) => ALLOWED_KEYS.has(key)),
        )];
        if (!eventKeys.length) {
            return res.status(400).json({ message: 'Unknown event key.' });
        }
        const patch = {};
        const notification = parseChannelFlag(req.body?.notification);
        const email = parseChannelFlag(req.body?.email);
        const whatsapp = parseChannelFlag(req.body?.whatsapp);
        if (typeof notification === 'boolean') patch.notification = notification;
        if (typeof email === 'boolean') patch.email = email;
        if (typeof whatsapp === 'boolean') patch.whatsapp = whatsapp;
        if (!Object.keys(patch).length) {
            return res.status(400).json({ message: 'No channel updates provided.' });
        }
        patch.updatedByName = String(req.user?.name || req.user?.username || '').trim();
        patch.updatedByUserId = String(req.user?.id || req.user?._id || '').trim();

        await NotificationEmailPermission.bulkWrite(
            eventKeys.map((eventKey) => ({
                updateOne: {
                    filter: { eventKey },
                    update: { $set: { ...patch, eventKey } },
                    upsert: true,
                },
            })),
            { ordered: false },
        );
        clearNotificationEmailPermissionCache();
        return res.status(200).json({
            ok: true,
            eventKeys,
            item: {
                eventKey: eventKeys[0],
                notification: patch.notification,
                email: patch.email,
                whatsapp: patch.whatsapp,
            },
        });
    } catch (error) {
        console.error('[NotificationEmailPermission] update failed:', error?.message || error);
        return res.status(500).json({ message: error?.message || 'Failed to save permission' });
    }
}

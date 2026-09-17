import NotificationEmailPermission from '../models/NotificationEmailPermission.js';
import {
    buildPermissionCatalogView,
    clearNotificationEmailPermissionCache,
} from '../utils/notificationEmailPermission.js';
import { flattenNotificationEmailCatalog } from '../constants/notificationEmailCatalog.js';

const ALLOWED_KEYS = new Set(flattenNotificationEmailCatalog().map((item) => item.key));

export async function getNotificationEmailPermissionAccess(req, res) {
    return res.status(200).json({ allowed: true });
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

export async function updateNotificationEmailPermission(req, res) {
    try {
        const eventKey = String(req.body?.eventKey || req.params?.eventKey || '').trim();
        if (!eventKey || !ALLOWED_KEYS.has(eventKey)) {
            return res.status(400).json({ message: 'Unknown event key.' });
        }
        const patch = {};
        if (typeof req.body?.notification === 'boolean') patch.notification = req.body.notification;
        if (typeof req.body?.email === 'boolean') patch.email = req.body.email;
        if (typeof req.body?.whatsapp === 'boolean') patch.whatsapp = req.body.whatsapp;
        if (!Object.keys(patch).length) {
            return res.status(400).json({ message: 'No channel updates provided.' });
        }
        patch.updatedByName = String(req.user?.name || req.user?.username || '').trim();
        patch.updatedByUserId = String(req.user?.id || req.user?._id || '').trim();

        const row = await NotificationEmailPermission.findOneAndUpdate(
            { eventKey },
            { $set: patch },
            { upsert: true, new: true },
        ).lean();
        clearNotificationEmailPermissionCache();
        return res.status(200).json({
            ok: true,
            item: {
                eventKey,
                notification: row.notification !== false,
                email: row.email !== false,
                whatsapp: row.whatsapp !== false,
            },
        });
    } catch (error) {
        console.error('[NotificationEmailPermission] update failed:', error?.message || error);
        return res.status(500).json({ message: error?.message || 'Failed to save permission' });
    }
}

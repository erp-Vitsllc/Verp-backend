import AdminDeletionArchive from '../models/AdminDeletionArchive.js';
import {
    ARCHIVE_CATEGORIES,
    ARCHIVE_TOP_MODULES,
    categoryLabel,
    topModuleLabel,
} from '../constants/adminDeletionArchiveConstants.js';
import { inferAdminDeletionArchiveMeta } from '../utils/inferAdminDeletionArchive.js';
import { restoreArchivedRecord } from './adminDeletionRestoreService.js';
import {
    ADMIN_DELETION_ARCHIVE_RETENTION_DAYS,
} from '../constants/adminDeletionArchiveConstants.js';
import {
    computeArchiveExpiresAt,
    enrichArchiveRetentionFields,
    isArchiveExpired,
    purgeExpiredAdminDeletionArchives,
} from '../utils/adminDeletionArchiveRetention.js';

export { purgeExpiredAdminDeletionArchives, ADMIN_DELETION_ARCHIVE_RETENTION_DAYS };

function deletedByFromReq(req) {
    return {
        userId: req.user?.id || req.user?._id,
        name: req.user?.name || req.user?.username || '',
        employeeId: req.user?.employeeId || '',
    };
}

export async function createAdminDeletionArchiveFromDeletion(req, opts = {}) {
    const meta = opts.archive || inferAdminDeletionArchiveMeta(opts);
    const snapshot = opts.deletedPayload != null ? opts.deletedPayload : {};

    const deletedAt = new Date();
    const doc = await AdminDeletionArchive.create({
        topModule: meta.topModule || 'other',
        category: meta.category || 'list',
        entityType: meta.entityType || 'unknown',
        moduleName: opts.moduleName || '',
        recordId: String(opts.recordId || meta.subtitle || ''),
        title: meta.title || opts.moduleName || 'Deleted record',
        subtitle: meta.subtitle || '',
        details: meta.details || opts.details || '',
        parentRef: meta.parentRef || {},
        snapshot,
        restoreDescriptor: meta.restoreDescriptor || { type: meta.entityType },
        deletedBy: deletedByFromReq(req),
        status: 'pending',
        deletedAt,
        expiresAt: computeArchiveExpiresAt(deletedAt),
    });

    return doc;
}

export async function getArchiveTree() {
    await purgeExpiredAdminDeletionArchives();

    const now = new Date();
    const pending = await AdminDeletionArchive.find({
        status: 'pending',
        expiresAt: { $gt: now },
    })
        .select('topModule category title subtitle recordId moduleName deletedAt entityType expiresAt')
        .sort({ deletedAt: -1 })
        .lean();

    const modules = Object.values(ARCHIVE_TOP_MODULES).map((m) => ({
        key: m.key,
        label: m.label,
        count: 0,
        categories: [],
    }));
    const moduleMap = Object.fromEntries(modules.map((m) => [m.key, m]));

    for (const item of pending) {
        const modKey = item.topModule || 'other';
        if (!moduleMap[modKey]) {
            moduleMap[modKey] = {
                key: modKey,
                label: topModuleLabel(modKey),
                count: 0,
                categories: [],
            };
            modules.push(moduleMap[modKey]);
        }
        const mod = moduleMap[modKey];
        mod.count += 1;

        const catKey = item.category || 'list';
        let cat = mod.categories.find((c) => c.key === catKey);
        if (!cat) {
            cat = {
                key: catKey,
                label: categoryLabel(modKey, catKey),
                count: 0,
                items: [],
            };
            mod.categories.push(cat);
        }
        cat.count += 1;
        cat.items.push(enrichArchiveRetentionFields(item));
    }

    return modules
        .filter((m) => m.count > 0)
        .map((m) => ({
            ...m,
            categories: m.categories
                .filter((c) => c.count > 0)
                .sort((a, b) => a.label.localeCompare(b.label)),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getArchiveCategoryMeta() {
    return {
        topModules: Object.values(ARCHIVE_TOP_MODULES),
        categoriesByModule: ARCHIVE_CATEGORIES,
        retentionDays: ADMIN_DELETION_ARCHIVE_RETENTION_DAYS,
    };
}

export async function listArchiveItems({ topModule, category, status = 'pending' }) {
    if (status === 'pending') {
        await purgeExpiredAdminDeletionArchives();
    }
    const filter = { status };
    if (topModule) filter.topModule = topModule;
    if (category) filter.category = category;
    if (status === 'pending') {
        filter.expiresAt = { $gt: new Date() };
    }
    const rows = await AdminDeletionArchive.find(filter).sort({ deletedAt: -1 }).lean();
    return rows.map((row) => enrichArchiveRetentionFields(row));
}

export async function getArchiveById(id) {
    const row = await AdminDeletionArchive.findById(id).lean();
    if (!row) return null;
    if (row.status === 'pending' && isArchiveExpired(row)) {
        await purgeExpiredAdminDeletionArchives();
        return null;
    }
    return enrichArchiveRetentionFields(row);
}

export async function restoreArchiveById(id, req) {
    const archive = await AdminDeletionArchive.findById(id);
    if (!archive) throw new Error('Archive record not found.');
    if (archive.status !== 'pending') throw new Error('This record is no longer available for restore.');
    if (isArchiveExpired(archive)) {
        await purgeExpiredAdminDeletionArchives();
        throw new Error(
            `This record exceeded the ${ADMIN_DELETION_ARCHIVE_RETENTION_DAYS}-day recovery period and was permanently removed.`,
        );
    }

    await restoreArchivedRecord(archive);

    archive.status = 'restored';
    archive.restoredAt = new Date();
    archive.restoredBy = deletedByFromReq(req);
    await archive.save();

    return archive;
}

export async function purgeArchiveById(id, req) {
    const archive = await AdminDeletionArchive.findById(id);
    if (!archive) throw new Error('Archive record not found.');
    if (archive.status === 'purged') throw new Error('Record already permanently deleted.');

    archive.status = 'purged';
    archive.purgedAt = new Date();
    archive.purgedBy = deletedByFromReq(req);
    archive.snapshot = { purged: true };
    await archive.save();

    return archive;
}

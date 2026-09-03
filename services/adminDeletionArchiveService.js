import AdminDeletionArchive from '../models/AdminDeletionArchive.js';
import {
    ARCHIVE_CATEGORIES,
    ARCHIVE_TOP_MODULES,
    categoryLabel,
    topModuleLabel,
} from '../constants/adminDeletionArchiveConstants.js';
import { inferAdminDeletionArchiveMeta } from '../utils/inferAdminDeletionArchive.js';
import { countDeletionAttachments } from '../utils/listDeletionAttachmentRefs.js';
import { enrichDeletionPayloadAttachmentKeys } from '../utils/adminDeletionArchiveRun.js';
import { signDeletionAttachmentUrls } from '../utils/signDeletionAttachmentUrls.js';
import {
    preserveDeletionAttachments,
    deletePreservedDeletionAttachments,
} from '../utils/preserveDeletionAttachments.js';
import mongoose from 'mongoose';
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
import { recordActivityAsync } from '../utils/activityLog.js';

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
    const snapshot = enrichDeletionPayloadAttachmentKeys(
        opts.deletedPayload != null ? opts.deletedPayload : {}
    );
    const archiveId = new mongoose.Types.ObjectId();
    const preservedAttachments = await preserveDeletionAttachments(String(archiveId), snapshot);
    const preservedAvailable = preservedAttachments.filter(
        (p) => !p.unavailable && (p.storageKey || p.originalKey)
    ).length;
    const attachmentCount = preservedAvailable || countDeletionAttachments(snapshot);

    const deletedAt = new Date();
    const retentionDaysRaw = Number(opts.retentionDays);
    const retentionDays =
        Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0
            ? retentionDaysRaw
            : ADMIN_DELETION_ARCHIVE_RETENTION_DAYS;
    const doc = await AdminDeletionArchive.create({
        _id: archiveId,
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
        retentionDays,
        expiresAt: computeArchiveExpiresAt(deletedAt, retentionDays),
        attachmentCount,
        preservedAttachments,
    });

    // System-wide activity feed (skip if caller already logged a richer row)
    if (req && !req._activityLogged) {
        const title = doc.title || doc.moduleName || 'record';
        recordActivityAsync({
            req,
            module: topModuleLabel(doc.topModule) || 'Settings',
            action: 'delete',
            entityType: doc.entityType || 'DeletedRecord',
            entityId: doc.recordId || String(doc._id),
            summary: `deleted ${title}${doc.subtitle ? ` (${doc.subtitle})` : ''}`,
            viewHref: `/Settings/DeletedRecords?item=${encodeURIComponent(String(doc._id))}`,
            metadata: {
                archiveId: String(doc._id),
                topModule: doc.topModule,
                category: doc.category,
            },
        });
    }

    return doc;
}

export async function getArchiveAttachmentsForView(id) {
    const row = await AdminDeletionArchive.findById(id)
        .select('snapshot status preservedAttachments')
        .lean();
    if (!row) throw new Error('Archive record not found.');
    if (row.status !== 'pending') throw new Error('Attachments are only available for pending recovery items.');
    if (isArchiveExpired(row)) {
        await purgeExpiredAdminDeletionArchives();
        throw new Error('This record is no longer in recovery.');
    }
    const attachments = await signDeletionAttachmentUrls(row.snapshot, row.preservedAttachments);
    return attachments;
}

export async function getArchiveTree() {
    await purgeExpiredAdminDeletionArchives();

    const now = new Date();
    const pending = await AdminDeletionArchive.find({
        status: 'pending',
        expiresAt: { $gt: now },
    })
        .select(
            'topModule category title subtitle recordId moduleName deletedAt entityType expiresAt retentionDays attachmentCount status snapshot'
        )
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
            `This record exceeded the ${archive.retentionDays || ADMIN_DELETION_ARCHIVE_RETENTION_DAYS}-day recovery period and was permanently removed.`,
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

    const snapshotBeforePurge = archive.snapshot;
    // Only remove recovery copies under admin-deletion-archive/. Never wipe original
    // live document keys from Wasabi (company/employee attachments are production-critical).
    await deletePreservedDeletionAttachments(archive.preservedAttachments, { deleteOriginals: false });
    void snapshotBeforePurge;

    archive.status = 'purged';
    archive.purgedAt = new Date();
    archive.purgedBy = deletedByFromReq(req);
    archive.snapshot = { purged: true };
    await archive.save();

    return archive;
}

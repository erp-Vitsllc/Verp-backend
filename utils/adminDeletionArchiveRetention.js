import AdminDeletionArchive from '../models/AdminDeletionArchive.js';
import { ADMIN_DELETION_ARCHIVE_RETENTION_DAYS } from '../constants/adminDeletionArchiveConstants.js';
import { countDeletionAttachments } from './listDeletionAttachmentRefs.js';
import {
    deletePreservedDeletionAttachments,
    deleteDeletionSnapshotSourceAttachments,
} from './preserveDeletionAttachments.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function computeArchiveExpiresAt(deletedAt = new Date()) {
    const base = deletedAt instanceof Date ? deletedAt : new Date(deletedAt);
    const expires = new Date(base.getTime());
    expires.setDate(expires.getDate() + ADMIN_DELETION_ARCHIVE_RETENTION_DAYS);
    return expires;
}

export function resolveArchiveExpiresAt(archive) {
    if (archive?.expiresAt) return new Date(archive.expiresAt);
    if (archive?.deletedAt) return computeArchiveExpiresAt(archive.deletedAt);
    return computeArchiveExpiresAt(new Date());
}

/** Whole days until automatic permanent removal (0 = expires today or already expired). */
export function getArchiveDaysRemaining(archiveOrExpiresAt) {
    const expiresAt =
        archiveOrExpiresAt instanceof Date
            ? archiveOrExpiresAt
            : resolveArchiveExpiresAt(archiveOrExpiresAt);
    const diff = expiresAt.getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / MS_PER_DAY));
}

export function isArchiveExpired(archive) {
    return resolveArchiveExpiresAt(archive).getTime() <= Date.now();
}

const systemPurgedBy = {
    name: 'System (60-day retention)',
    employeeId: '',
};

/**
 * Backfill missing expiresAt on pending rows (legacy archives).
 */
export async function backfillMissingArchiveExpiryDates() {
    const missing = await AdminDeletionArchive.find({
        status: 'pending',
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }],
    })
        .select('_id deletedAt')
        .lean();

    if (!missing.length) return 0;

    const ops = missing.map((row) => ({
        updateOne: {
            filter: { _id: row._id },
            update: { $set: { expiresAt: computeArchiveExpiresAt(row.deletedAt || new Date()) } },
        },
    }));
    await AdminDeletionArchive.bulkWrite(ops, { ordered: false });
    return missing.length;
}

/**
 * Permanently purge pending archives past retention (removed from Deleted Records UI).
 */
export async function purgeExpiredAdminDeletionArchives() {
    await backfillMissingArchiveExpiryDates();

    const now = new Date();
    const legacyCutoff = new Date(now.getTime() - ADMIN_DELETION_ARCHIVE_RETENTION_DAYS * MS_PER_DAY);

    const expired = await AdminDeletionArchive.find({
        status: 'pending',
        $or: [{ expiresAt: { $lte: now } }, { expiresAt: null, deletedAt: { $lte: legacyCutoff } }],
    }).select('preservedAttachments snapshot');

    if (!expired.length) return 0;

    for (const row of expired) {
        await deletePreservedDeletionAttachments(row.preservedAttachments);
        if (row.snapshot && row.snapshot.purged !== true) {
            await deleteDeletionSnapshotSourceAttachments(row.snapshot);
        }
    }

    const purgeTime = new Date();
    await AdminDeletionArchive.updateMany(
        { _id: { $in: expired.map((d) => d._id) } },
        {
            $set: {
                status: 'purged',
                purgedAt: purgeTime,
                purgedBy: systemPurgedBy,
                snapshot: { purged: true, autoRetention: true },
            },
        },
    );

    console.log(
        `[AdminDeletionArchive] Auto-purged ${expired.length} record(s) after ${ADMIN_DELETION_ARCHIVE_RETENTION_DAYS}-day retention.`,
    );
    return expired.length;
}

export function resolveArchiveAttachmentCount(archive) {
    if (!archive) return 0;
    if (typeof archive.attachmentCount === 'number' && archive.attachmentCount >= 0) {
        return archive.attachmentCount;
    }
    if (archive.snapshot && archive.snapshot.purged !== true) {
        return countDeletionAttachments(archive.snapshot);
    }
    return 0;
}

const ARCHIVE_STATUS_LABELS = {
    pending: 'Pending recovery',
    restored: 'Restored',
    purged: 'Purged',
};

function formatCompanyProfileStatusAtDeletion(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return '';
    const status = snapshot.companyStatus != null ? String(snapshot.companyStatus).trim() : '';
    const activation =
        snapshot.activationStatus != null ? String(snapshot.activationStatus).trim() : '';
    if (status && activation) return `${status} / ${activation}`;
    return status || activation || '';
}

export function enrichArchiveRetentionFields(archive) {
    if (!archive) return archive;
    const expiresAt = resolveArchiveExpiresAt(archive);
    const daysRemaining = getArchiveDaysRemaining(expiresAt);
    const attachmentCount = resolveArchiveAttachmentCount(archive);
    const { snapshot, ...rest } = archive;
    const status = String(archive.status || 'pending').toLowerCase();
    return {
        ...rest,
        attachmentCount,
        expiresAt,
        retentionDays: ADMIN_DELETION_ARCHIVE_RETENTION_DAYS,
        daysRemaining,
        isExpired: daysRemaining <= 0,
        status,
        statusLabel: ARCHIVE_STATUS_LABELS[status] || status,
        companyProfileStatus: formatCompanyProfileStatusAtDeletion(snapshot),
    };
}

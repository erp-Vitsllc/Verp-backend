const ATTACHMENT_HISTORY_FIELDS = {
    label: { type: String, default: '' },
    name: { type: String, default: '' },
    url: { type: String, default: '' },
    publicId: { type: String, default: '' },
    mimeType: { type: String, default: 'application/pdf' },
    source: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
    trigger: {
        type: String,
        enum: ['management-approval', 'schedule-edit', 'accessory-edit', 'regenerated'],
        default: 'management-approval',
    },
    scheduleFromMonth: { type: String, default: '' },
    scheduleToMonth: { type: String, default: '' },
    durationFrom: { type: Number, default: null },
    durationTo: { type: Number, default: null },
};

export { ATTACHMENT_HISTORY_FIELDS };

/**
 * Append attachment snapshots to history (keeps every generation — initial + each edit).
 */
export function appendApprovalAttachmentHistory(doc, entries = [], { trigger = 'management-approval', scheduleChange = null } = {}) {
    if (!doc || !Array.isArray(entries) || entries.length === 0) return;

    if (!Array.isArray(doc.approvalAttachmentHistory)) {
        doc.approvalAttachmentHistory = [];
    }

    const addedAt = new Date();
    const scheduleMeta =
        trigger === 'schedule-edit' && scheduleChange
            ? {
                  scheduleFromMonth: scheduleChange.fromMonth ?? '',
                  scheduleToMonth: scheduleChange.toMonth ?? '',
                  durationFrom: scheduleChange.fromDuration ?? null,
                  durationTo: scheduleChange.toDuration ?? null,
              }
            : {};

    entries.forEach((entry) => {
        if (!entry?.publicId && !entry?.data && !entry?.base64) return;
        if (!entry?.publicId && !entry?.name) return;
        doc.approvalAttachmentHistory.push({
            label: entry.label || entry.name || 'Document',
            name: entry.name || '',
            url: entry.url || '',
            publicId: entry.publicId || '',
            mimeType: entry.mimeType || 'application/pdf',
            source: entry.source || '',
            addedAt: entry.addedAt || addedAt,
            trigger: entry.trigger || trigger,
            ...scheduleMeta,
        });
    });
}

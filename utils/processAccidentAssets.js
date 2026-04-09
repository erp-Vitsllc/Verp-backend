import AssetItem from '../models/AssetItem.js';
import { sendAssetServiceEmail } from './sendAssetServiceEmail.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEN_DAYS_MS = 10 * DAY_MS;

const uniqueById = (arr) => {
    const map = new Map();
    for (const x of arr) {
        if (!x?._id) continue;
        map.set(String(x._id), x);
    }
    return [...map.values()];
};

export const processAccidentAssets = async () => {
    try {
        const now = new Date();

        const accidentAssets = await AssetItem.find({
            status: 'Accident',
            accidentStartedAt: { $ne: null },
            accidentActiveUntil: { $ne: null }
        }).populate('assignedTo actionRequiredBy');

        for (const asset of accidentAssets) {
            const startedAt = asset.accidentStartedAt ? new Date(asset.accidentStartedAt) : null;
            const activeUntil = asset.accidentActiveUntil ? new Date(asset.accidentActiveUntil) : null;
            if (!startedAt || !activeUntil) continue;

            // Cap accident active window to 60 days from start.
            if (now >= activeUntil) {
                asset.status = asset.assignedTo ? 'Assigned' : 'Unassigned';
                asset.accidentStartedAt = null;
                asset.accidentActiveUntil = null;
                asset.accidentReminderLastSentAt = null;
                await asset.save();
                continue;
            }

            const lastSent = asset.accidentReminderLastSentAt ? new Date(asset.accidentReminderLastSentAt) : null;
            const shouldSend =
                !lastSent || (now.getTime() - lastSent.getTime()) >= TEN_DAYS_MS;
            if (!shouldSend) continue;

            const recipients = uniqueById(
                [asset.assignedTo, asset.actionRequiredBy].filter(Boolean)
            );
            if (recipients.length === 0) continue;

            for (const recipient of recipients) {
                await sendAssetServiceEmail({
                    asset,
                    recipient,
                    type: 'Warning',
                    details: {
                        serviceDuration: 'Accident Active (max 60 days)',
                        description: `Accident status is still active. Ends by ${activeUntil.toLocaleDateString()}.`
                    },
                    sender: { firstName: 'System', lastName: 'Automated' }
                });
            }

            asset.accidentReminderLastSentAt = now;
            await asset.save();
        }
    } catch (e) {
        console.error('[processAccidentAssets] Non-fatal:', e?.message || e);
    }
};


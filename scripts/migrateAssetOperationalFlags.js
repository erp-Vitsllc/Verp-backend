/**
 * One-time migration: move legacy status values (On Leave, Service, On Service, …)
 * into onLeaveActive / onServiceActive booleans and normalize asset.status.
 *
 * Run from VERP_backend: node scripts/migrateAssetOperationalFlags.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import AssetItem from '../models/AssetItem.js';
import { migrateLegacyOperationalFlags } from '../utils/assetOperationalFlags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const LEGACY_LEAVE = /^on\s+leave$/i;
const LEGACY_SERVICE = /^(service|on\s+service|waiting\s+for\s+service|maintenance)$/i;

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
        console.error('MONGO_URI / MONGODB_URI not set');
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log('Connected. Scanning assets with legacy operational statuses…');

    const candidates = await AssetItem.find({
        $or: [
            { status: { $regex: LEGACY_LEAVE } },
            { status: { $regex: LEGACY_SERVICE } },
        ],
    });

    let updated = 0;
    for (const doc of candidates) {
        const before = { status: doc.status, onLeave: doc.onLeaveActive, onService: doc.onServiceActive };
        migrateLegacyOperationalFlags(doc);
        if (doc.isModified()) {
            await doc.save();
            updated += 1;
            console.log(
                `[${doc.assetId}] ${before.status} → status=${doc.status}, onLeaveActive=${doc.onLeaveActive}, onServiceActive=${doc.onServiceActive}`,
            );
        }
    }

    console.log(`Done. Migrated ${updated} of ${candidates.length} candidate(s).`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

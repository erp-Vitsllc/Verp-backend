/**
 * One-time: copy live Registration/Insurance document expiry onto asset top-level fields.
 * Fixes vehicle list rows where cards were added before addAssetDocument synced expiry.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import AssetItem from '../models/AssetItem.js';
import { syncVehicleExpiryFieldsFromLiveDocuments } from '../utils/vehicleDocumentRenewal.js';

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
    console.error('MONGO_URI missing');
    process.exit(1);
}

await mongoose.connect(uri);

const vehicles = await AssetItem.find({
    assetId: { $regex: /^VEGA-VHCL-/i },
    documents: { $exists: true, $ne: [] },
});

let updated = 0;
for (const asset of vehicles) {
    const beforeReg = asset.registrationExpiryDate
        ? new Date(asset.registrationExpiryDate).toISOString().slice(0, 10)
        : null;
    const beforeIns = asset.insuranceExpiryDate
        ? new Date(asset.insuranceExpiryDate).toISOString().slice(0, 10)
        : null;

    syncVehicleExpiryFieldsFromLiveDocuments(asset);

    const afterReg = asset.registrationExpiryDate
        ? new Date(asset.registrationExpiryDate).toISOString().slice(0, 10)
        : null;
    const afterIns = asset.insuranceExpiryDate
        ? new Date(asset.insuranceExpiryDate).toISOString().slice(0, 10)
        : null;

    if (beforeReg !== afterReg || beforeIns !== afterIns) {
        await asset.save();
        updated += 1;
        console.log(
            `${asset.assetId}: reg ${beforeReg || '-'} -> ${afterReg || '-'}, ins ${beforeIns || '-'} -> ${afterIns || '-'}`,
        );
    }
}

console.log(`Done. Updated ${updated} of ${vehicles.length} vehicles with documents.`);
await mongoose.disconnect();

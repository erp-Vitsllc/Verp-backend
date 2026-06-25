import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import AssetItem from '../models/AssetItem.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetType from '../models/AssetType.js';
import AssetHistory from '../models/AssetHistory.js';
import Fine from '../models/Fine.js';
import { getSignedFileUrl } from '../utils/s3Upload.js';
import { getDepartmentHOD } from '../utils/getDepartmentHOD.js';

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
await mongoose.connect(uri);

const uid = new mongoose.Types.ObjectId();
const assetQuery = {
    $or: [{ status: { $ne: 'Draft' } }, { createdBy: uid }],
    $and: [{ $or: [{ plateNumber: { $exists: false } }, { plateNumber: null }, { plateNumber: '' }] }],
};

try {
    const assets = await AssetItem.find(assetQuery)
        .populate('typeId')
        .populate('categoryId')
        .lean();
    console.log('assets:', assets.length);

    const flowAc = await getDepartmentHOD('assetcontroller');
    console.log('flowAc:', flowAc?.employeeId || 'null');

    const assetIds = assets.map((a) => a._id);
    const fines = await Fine.find({ assetObjectId: { $in: assetIds } }).lean();
    console.log('fines:', fines.length);

    const lostHistoryRows = await AssetHistory.find({
        assetId: { $in: assetIds },
        $or: [
            { action: { $in: ['Lost', 'End of Life'] } },
            { 'details.fineId': { $exists: true, $ne: null } },
        ],
    }).lean();
    console.log('history:', lostHistoryRows.length);

    for (const a of assets.slice(0, 3)) {
        await getSignedFileUrl(a.imagePreview);
        await getSignedFileUrl(a.photo);
    }
    console.log('signed urls ok');
} catch (e) {
    console.error('FAIL:', e.message);
    console.error(e.stack);
}

await mongoose.disconnect();

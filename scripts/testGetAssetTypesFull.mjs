import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import AssetCategory from '../models/AssetCategory.js';
import AssetType from '../models/AssetType.js';
import AssetItem from '../models/AssetItem.js';
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
    const categories = await AssetCategory.find({ isActive: true }).populate('typeId');
    const types = await AssetType.find({ isActive: true });
    const assets = await AssetItem.find(assetQuery)
        .populate('typeId')
        .populate('categoryId')
        .populate('actionRequiredBy', 'firstName lastName employeeId')
        .populate('assignedCompany', 'name nickName companyId companyEmail')
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId department primaryReportee reportingAuthority',
            populate: [
                { path: 'primaryReportee', select: 'firstName lastName' },
                { path: 'reportingAuthority', select: 'firstName lastName' },
            ],
        })
        .lean();

    const assetIds = assets.map((a) => a._id);
    const assetHumanIds = [...new Set(assets.map((a) => a.assetId).filter(Boolean))];
    const fineQuery = [{ assetObjectId: { $in: assetIds } }];
    if (assetHumanIds.length) fineQuery.push({ assetId: { $in: assetHumanIds } });
    let fines = await Fine.find({ $or: fineQuery })
        .select('fineId fineStatus assetId assetObjectId accessoryId accessoryObjectId createdAt')
        .lean();

    const lostHistoryRows = await AssetHistory.find({
        assetId: { $in: assetIds },
        $or: [
            { action: { $in: ['Lost', 'End of Life'] } },
            { 'details.fineId': { $exists: true, $ne: null } },
        ],
    })
        .select('assetId action date details comments')
        .sort({ date: -1 })
        .lean();

    const fineByFineId = new Map(fines.map((f) => [f.fineId, f]));
    const matchFinesToAsset = (a) =>
        fines.filter(
            (f) =>
                f.assetObjectId?.toString() === a._id.toString() ||
                (f.assetId && a.assetId && f.assetId === a.assetId),
        );

    const signIf = async (key) => (key ? getSignedFileUrl(key) : null);

    const assetRows = await Promise.all(
        assets.map(async (a) => {
            const assetFines = matchFinesToAsset(a);
            const accList = (a.accessories || []).map((acc) => ({ ...acc }));
            return {
                assetId: a.assetId,
                imagePreview: await signIf(a.imagePreview),
                photo: await signIf(a.photo),
                accessories: accList,
            };
        }),
    );

    console.log('OK unified build', {
        categories: categories.length,
        types: types.length,
        assets: assetRows.length,
        fines: fines.length,
    });
} catch (e) {
    console.error('FAIL:', e.message);
    console.error(e.stack);
}

await mongoose.disconnect();

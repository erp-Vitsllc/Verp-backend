import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/erp_system';

const assetItemSchema = new mongoose.Schema({
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: String
}, { timestamps: true, strict: false });
const AssetItem = mongoose.model('AssetItem', assetItemSchema);

const employeeBasicSchema = new mongoose.Schema({
    employeeId: String
}, { strict: false });
const EmployeeBasic = mongoose.model('EmployeeBasic', employeeBasicSchema);

const userSchema = new mongoose.Schema({
    employeeId: String
}, { strict: false });
const User = mongoose.model('User', userSchema);

const assetHistorySchema = new mongoose.Schema({
    assetId: mongoose.Schema.Types.ObjectId,
    action: String,
    date: Date,
    performedBy: mongoose.Schema.Types.ObjectId,
    comments: String,
    details: mongoose.Schema.Types.Mixed
}, { timestamps: true });
const AssetHistory = mongoose.model('AssetHistory', assetHistorySchema);

async function backfill() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log('Connected to DB');

        const allAssets = await AssetItem.find({});
        console.log(`Checking ${allAssets.length} assets...`);

        let fixedCount = 0;
        for (const asset of allAssets) {
            const hasCreated = await AssetHistory.findOne({ assetId: asset._id, action: 'Created' });
            if (!hasCreated) {
                console.log(`Backfilling 'Created' history for Asset ${asset.assetId}...`);

                let performedBy = null;
                if (asset.createdBy) {
                    const user = await User.findById(asset.createdBy);
                    if (user && user.employeeId) {
                        const emp = await EmployeeBasic.findOne({ employeeId: user.employeeId });
                        if (emp) performedBy = emp._id;
                    }
                }

                await AssetHistory.create({
                    assetId: asset._id,
                    action: 'Created',
                    date: asset.createdAt || new Date(),
                    performedBy: performedBy,
                    comments: performedBy ? 'Asset created (Backfilled)' : 'Asset created (System Backfill - creator unknown)',
                    details: { status: asset.status }
                });
                fixedCount++;
            }
        }

        console.log(`\nBackfill complete. Fixed ${fixedCount} records.`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

backfill();

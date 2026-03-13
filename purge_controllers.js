
import mongoose from 'mongoose';
import Company from './models/Company.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    await mongoose.connect(process.env.MONGO_URI);

    console.log('--- PURGING ASSET CONTROLLER SYSTEM-WIDE ---');
    const result = await Company.updateMany(
        {},
        { $pull: { responsibilities: { category: 'assetcontroller' } } }
    );
    console.log(`Successfully removed all asset controllers from ${result.modifiedCount} companies.`);

    console.log('\n--- VERIFYING ---');
    const remaining = await Company.find({ 'responsibilities.category': 'assetcontroller' });
    if (remaining.length === 0) {
        console.log('System is now completely clean of Asset Controllers.');
    } else {
        console.log(`WARNING: Still found ${remaining.length} companies with asset controllers.`);
    }

    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});

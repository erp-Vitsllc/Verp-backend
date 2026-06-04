import mongoose from 'mongoose';

const MONGO_URI = 'mongodb+srv://razan69214_db_user:sAfjPF7T9dih%40V-@cluster0.24vmanb.mongodb.net/mydb?retryWrites=true&w=majority&readPreference=primaryPreferred&appName=VERP-Backend';

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    // Query AssetItem collection which contains services.
    const assets = await mongoose.connection.db.collection('assetitems').find({
        'services.serviceType': 'Body Work'
    }).toArray();

    console.log(`Found ${assets.length} assets with Body Work services.`);

    for (const asset of assets) {
        console.log(`\nAsset ID: ${asset._id} (${asset.name || asset.title || 'unnamed'})`);
        const bodyWorks = asset.services.filter(s => String(s.serviceType).trim() === 'Body Work');
        for (const s of bodyWorks) {
            console.log(`  - Service ID: ${s._id}`);
            console.log(`    Date: ${s.date}`);
            console.log(`    Paid By: ${s.paidBy}`);
            console.log(`    Status / Stage: ${s.workflowSnapshot?.stage || 'no snapshot'}`);
            console.log(`    Remark snippet: ${JSON.stringify(s.remark || '').slice(0, 150)}...`);
        }
    }

    await mongoose.disconnect();
}

main().catch(console.error);

const mongoose = require('mongoose');

const uri = "mongodb+srv://razandocs_db_user:aqrOEJ7wJKY2apBw@cluster0.x1mrrrd.mongodb.net/verp";

async function run() {
    await mongoose.connect(uri);
    console.log("Connected to MongoDB");
    
    const db = mongoose.connection.db;
    const assetsCollection = db.collection('assetitems');
    
    const asset1 = await assetsCollection.findOne({ _id: new mongoose.Types.ObjectId('6a294207f0fca38c84fe1525') });
    if (asset1) {
        console.log("Asset 1 (6a294207f0fca38c84fe1525):", {
            name: asset1.name,
            assetId: asset1.assetId,
            type: asset1.type,
            category: asset1.category,
            typeId: asset1.typeId,
            categoryId: asset1.categoryId,
            isVehicle: asset1.isVehicle,
            plateNumber: asset1.plateNumber
        });
    } else {
        console.log("Asset 1 not found");
    }
    
    const asset2 = await assetsCollection.findOne({ _id: new mongoose.Types.ObjectId('6a2941d8b7905307905688f5') });
    if (asset2) {
        console.log("Asset 2 (6a2941d8b7905307905688f5):", {
            name: asset2.name,
            assetId: asset2.assetId,
            type: asset2.type,
            category: asset2.category,
            typeId: asset2.typeId,
            categoryId: asset2.categoryId,
            isVehicle: asset2.isVehicle,
            plateNumber: asset2.plateNumber
        });
    } else {
        console.log("Asset 2 not found");
    }
    
    await mongoose.disconnect();
}

run().catch(console.error);

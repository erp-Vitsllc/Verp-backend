import mongoose from 'mongoose';
import dotenv from 'dotenv';
import AssetItem from './models/AssetItem.js';
import EmployeeBasic from './models/EmployeeBasic.js';
import Company from './models/Company.js';

dotenv.config();

mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(async () => {
    console.log('Connected to DB');
    const items = await AssetItem.find({});
    let updated = 0;
    for (const item of items) {
        if (!item.assignedTo && !item.assignedCompany) {
            item.ownership = 'Unassigned';
        } else if (item.assignedToType === 'Company' && item.assignedCompany) {
            const comp = await Company.findById(item.assignedCompany);
            item.ownership = comp ? comp.name : 'Unknown Company';
        } else if (item.assignedTo) {
            const emp = await EmployeeBasic.findById(item.assignedTo);
            item.ownership = emp ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() : 'Unknown Employee';
        }
        await item.save();
        updated++;
    }
    console.log(`Updated ${updated} items.`);
    process.exit(0);
}).catch(console.error);

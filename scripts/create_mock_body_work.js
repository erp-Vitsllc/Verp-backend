import mongoose from 'mongoose';

const MONGO_URI = 'mongodb+srv://razan69214_db_user:sAfjPF7T9dih%40V-@cluster0.24vmanb.mongodb.net/mydb?retryWrites=true&w=majority&readPreference=primaryPreferred&appName=VERP-Backend';

async function main() {
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB');

    const assetId = '69da152985e5e02a68fcf664';
    
    // Check if asset exists
    const asset = await mongoose.connection.db.collection('assetitems').findOne({ _id: new mongoose.Types.ObjectId(assetId) });
    if (!asset) {
        console.error('Asset not found');
        await mongoose.disconnect();
        return;
    }
    console.log(`Found asset: ${asset.name}`);

    // Define the new service record ID
    const serviceRecordId = new mongoose.Types.ObjectId();

    const remarkObj = {
        amountMode: 'amount',
        currentKm: 125000,
        liableOn: 'person',
        liablePersonId: '6974b82c4c95f9fdf21e8739', // Marwan Alnuaimi
        vehicleOwnerEmployeeId: '6974b82c4c95f9fdf21e8739',
        bodyWorkImages: [
            {
                url: 'https://images.unsplash.com/photo-1597404298304-27e1b70284b2?w=500',
                name: 'dent_left_door.jpg'
            },
            {
                url: 'https://images.unsplash.com/photo-1619642751034-765dfdf7c58e?w=500',
                name: 'paint_scratch.jpg'
            }
        ],
        requestStatus: 'submitted',
        vendorName: 'Emirates Motor Company',
        approvedQuotationChoice: 'q1',
        quotationAmounts: {
            q1: 450,
            q2: 520,
            q3: 480
        },
        adminScheduledServiceDate: '2026-05-15',
        adminServiceDurationDays: 4,
        garageLocation: 'Abu Dhabi Main Service Center',
        serviceReturnDate: '2026-05-19'
    };

    const newService = {
        _id: serviceRecordId,
        serviceType: 'Body Work',
        date: new Date('2026-05-15T09:00:00Z'),
        description: 'Dent repair on driver-side door and rear bumper painting.',
        paidBy: 'Person',
        value: 450,
        remark: JSON.stringify(remarkObj),
        attachment: 'asset-service-attachments/quotation1.pdf',
        quotation2: 'asset-service-attachments/quotation2.pdf',
        quotation3: 'asset-service-attachments/quotation3.pdf',
        currentKm: 125000
    };

    const workflowHistory = [
        {
            stage: 'pending_hr',
            action: 'created',
            note: 'Service logged: Body Work',
            byName: 'Marwan Alnuaimi',
            bySignatureUrl: '',
            at: new Date('2026-05-15T09:05:00Z'),
            _id: new mongoose.Types.ObjectId()
        },
        {
            stage: 'pending_hr',
            action: 'approve',
            note: 'Approved for employee liability. Proceed to finance.',
            byName: 'Raseel Muhammad Rasheed',
            bySignatureUrl: 'employee-signatures/53371/signature_1777552837958.png',
            at: new Date('2026-05-15T09:20:00Z'),
            _id: new mongoose.Types.ObjectId()
        },
        {
            stage: 'pending_accounts',
            action: 'approve',
            note: 'Accounts approval cleared.',
            byName: 'VISHNU PRASAD',
            bySignatureUrl: 'employee-signatures/82693/signature_1772107716243.png',
            at: new Date('2026-05-15T09:30:00Z'),
            _id: new mongoose.Types.ObjectId()
        },
        {
            stage: 'pending_admin',
            action: 'approve',
            note: 'Admin action form submitted: Emirates Motor Company',
            byName: 'Raseel Muhammad Rasheed',
            bySignatureUrl: 'employee-signatures/53371/signature_1777552837958.png',
            at: new Date('2026-05-15T09:40:00Z'),
            _id: new mongoose.Types.ObjectId()
        }
    ];

    const activeWorkflow = {
        serviceRecordId: serviceRecordId,
        stage: 'scheduled_service',
        previousStatus: 'Unassigned',
        serviceTypeLabel: 'Body Work',
        scheduledServiceDate: new Date('2026-05-15T00:00:00Z'),
        serviceDurationDays: 4,
        serviceWindowEndDate: new Date('2026-05-19T08:00:00Z'),
        history: workflowHistory,
        accountsHold: {
            days: null,
            heldAt: null,
            holdUntilDate: null,
            remindAt: null,
            reminderSentAt: null,
            reason: ''
        }
    };

    // Construct the updated services array
    const services = asset.services || [];
    services.push(newService);

    // Update asset document
    await mongoose.connection.db.collection('assetitems').updateOne(
        { _id: new mongoose.Types.ObjectId(assetId) },
        {
            $set: {
                services: services,
                activeServiceWorkflow: activeWorkflow,
                status: 'On Service',
                currentKilometer: 125000,
                lastServiceDate: new Date('2026-05-15T09:00:00Z')
            }
        }
    );

    console.log('Successfully created mock Body Work service request and updated workflow status.');

    await mongoose.disconnect();
}

main().catch(console.error);

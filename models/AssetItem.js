import mongoose from 'mongoose';

const assetItemSchema = new mongoose.Schema({
    typeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AssetType',
        required: true
    },
    categoryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AssetCategory',
        required: true
    },
    assetId: { // Custom ID like VEGA-ASSET-001
        type: String,
        required: true,
        unique: true
    },
    name: { // Specific Asset Name
        type: String,
        required: true,
        trim: true
    },
    assetValue: {
        type: Number,
        default: 0
    },
    purchaseDate: {
        type: Date,
        default: null
    },
    quantity: {
        type: Number,
        default: 1
    },
    warranty: {
        type: String,
        trim: true
    },
    warrantyYears: {
        type: Number,
        default: 0
    },
    warrantyAttachment: {
        type: String,
        default: null
    },
    invoiceNumber: {
        type: String,
        trim: true
    },
    invoiceFile: { // URL to uploaded invoice
        type: String,
        default: null
    },
    imagePreview: { // Cropped image
        type: String,
        default: null
    },
    photo: { // Alternative name for image
        type: String,
        default: null
    },
    images: [{
        url: { type: String, required: true },
        caption: { type: String, default: '' },
        date: { type: Date, default: Date.now }
    }],
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    assignedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    status: {
        type: String,
        enum: ['Assigned', 'Unassigned', 'Maintenance', 'On Service', 'Service', 'Lost', 'Returned', 'Pending', 'End of Life', 'Out of Service'],
        default: 'Unassigned'
    },
    assignmentType: {
        type: String,
        enum: ['Permanent', 'Temporary', null],
        default: null
    },
    assignedDays: {
        type: Number,
        default: null
    },
    acceptanceStatus: {
        type: String,
        enum: ['Pending', 'Accepted', 'Rejected'],
        default: 'Pending'
    },
    actionRequiredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic',
        default: null
    },
    pendingAction: {
        type: String,
        enum: ['End of Life', 'Loss and Damage', null],
        default: null
    },
    pendingActionDetails: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    acceptedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic',
        default: null
    },
    negotiationHistory: [{
        sender: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic' },
        message: { type: String },
        action: { type: String, enum: ['AcceptWithComments', 'Comment'] },
        file: { type: String, default: null }, // URL to uploaded attachment
        date: { type: Date, default: Date.now }
    }],
    accessories: [{
        accessoryId: { type: String },
        name: { type: String, required: true },
        amount: { type: Number, default: 0 },
        attachment: { type: String, default: null },
        status: {
            type: String,
            enum: ['Attached', 'Transfered', 'Lost', 'Damaged', 'End of Life'],
            default: 'Attached'
        },
        // Pending approval workflow for accessory-level actions
        pendingAction: {
            type: String,
            enum: ['Transfer', 'Loss and Damage', 'End of Life', null],
            default: null
        },
        pendingActionDetails: {
            targetAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetItem', default: null },
            reason: { type: String, default: null },
            attachment: { type: String, default: null },
            fineData: { type: mongoose.Schema.Types.Mixed, default: null },
            requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
            requestedAt: { type: Date, default: null }
        }
    }],
    accessoriesAttachment: { type: String, default: null },
    vehicleCode: { type: String, trim: true },
    plateNumber: { type: String, trim: true },
    modelYear: { type: String, trim: true },
    currentKilometer: { type: Number, default: 0 },
    registrationExpiryDate: { type: Date, default: null },
    insuranceExpiryDate: { type: Date, default: null },
    oilChangeDate: { type: Date, default: null },
    gearOilDueDate: { type: Date, default: null },
    lastServiceDate: { type: Date, default: null },
    nextServiceDate: { type: Date, default: null },
    documents: [{
        type: { type: String },
        issueAuthority: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        description: { type: String },
        attachment: { type: String } // URL to uploaded document
    }],
    services: [{
        serviceType: { type: String, enum: ['Oil Service', 'Taxi Charge', 'Mechanical Work', 'Body Work', 'Accident Repair', 'Other'] },
        date: { type: Date, default: Date.now },
        expiryDate: { type: Date },
        serviceDuration: { type: String },   // e.g. "7 days", "2 weeks"
        currentKm: { type: Number },
        description: { type: String },
        paidBy: { type: String, enum: ['Company', 'Employee'] },
        value: { type: Number },
        remark: { type: String },
        invoice: { type: String },           // URL to uploaded invoice
        attachment: { type: String }         // URL to any supporting attachment
    }]
}, {
    timestamps: true
});

// Middleware to auto-generate accessory IDs if missing
assetItemSchema.pre('save', function (next) {
    if (this.accessories && this.accessories.length > 0) {
        this.accessories.forEach((acc, index) => {
            if (!acc.accessoryId) {
                const charCode = 65 + (index % 26);
                const suffixNum = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
                acc.accessoryId = `${this.assetId}${String.fromCharCode(charCode)}${suffixNum}`;
            }
        });
    }
    next();
});

const AssetItem = mongoose.model('AssetItem', assetItemSchema);

export default AssetItem;

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
        enum: ['Assigned', 'Unassigned', 'Maintenance', 'Lost', 'Returned'],
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
        attachment: { type: String, default: null }
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

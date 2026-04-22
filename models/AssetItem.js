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
    assignedToType: {
        type: String,
        enum: ['Employee', 'Company'],
        default: 'Employee'
    },
    assignedCompany: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        default: null
    },
    assignedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    status: {
        type: String,
        enum: ['Assigned', 'Unassigned', 'Maintenance', 'On Service', 'Online', 'Service', 'Accident', 'Lost', 'Returned', 'Pending', 'End of Life', 'Out of Service', 'Draft', 'Rejected', 'On Leave', 'Submitted for Approval'],
        default: 'Unassigned'
    },
    ownership: {
        type: String,
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
    assignedDate: {
        type: Date,
        default: null
    },
    temporaryEndDate: {
        type: Date,
        default: null
    },
    temporaryReminderSentAt: {
        type: Date,
        default: null
    },
    temporaryExpiredSentAt: {
        type: Date,
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
        enum: ['End of Life', 'Loss and Damage', 'Leave', 'Return Asset', 'Asset Transfer', 'Retention Confirmation', null],
        default: null
    },
    pendingActionDetails: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    onLeaveStartDate: {
        type: Date,
        default: null
    },
    onLeaveEndDate: {
        type: Date,
        default: null
    },
    onLeaveDuration: {
        type: Number, // Duration in days
        default: null
    },
    parkingExtendedDays: {
        type: Number,
        default: 0
    },
    parkingReminderSentAt: {
        type: Date,
        default: null
    },
    parkingDurationCompleteSentAt: {
        type: Date,
        default: null
    },
    acceptedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic',
        default: null
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
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
        description: { type: String, default: '', trim: true },
        attachment: { type: String, default: null },
        status: {
            type: String,
            enum: ['Attached', 'Transfered', 'Lost', 'Damaged', 'End of Life', 'Pending'],
            default: 'Attached'
        },
        // Pending approval workflow for accessory-level actions
        pendingAction: {
            type: String,
            default: null,
            validate: {
                validator: function (v) {
                    if (v == null || v === "" || v === "null") return true;
                    return ['Transfer', 'Loss and Damage', 'End of Life', 'Add', 'Unattach'].includes(v);
                },
                message: 'Invalid pending action'
            }
        },
        pendingActionDetails: {
            targetAssetId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetItem', default: null },
            catalogItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'AssetAccessoryCatalog', default: null },
            reason: { type: String, default: null },
            attachment: { type: String, default: null },
            fineData: { type: mongoose.Schema.Types.Mixed, default: null },
            requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
            requestedAt: { type: Date, default: null }
        }
    }],
    /** Accessories removed from this asset after Loss & Damage was finalized (fine created). Keeps list/history without re-embedding the line. */
    lostDetachedAccessories: [{
        accessoryId: { type: String, trim: true },
        name: { type: String, default: '' },
        amount: { type: Number, default: 0 },
        fineId: { type: String, default: '' },
        detachedAt: { type: Date, default: Date.now }
    }],
    accessoriesAttachment: { type: String, default: null },
    vehicleCode: { type: String, trim: true },
    /** UAE emirate selected in Add Vehicle (drives license plate artwork). */
    plateEmirate: { type: String, trim: true, default: '' },
    plateNumber: { type: String, trim: true },
    modelYear: { type: String, trim: true },
    currentKilometer: { type: Number, default: 0 },
    registrationExpiryDate: { type: Date, default: null },
    insuranceExpiryDate: { type: Date, default: null },
    oilChangeDate: { type: Date, default: null },
    gearOilDueDate: { type: Date, default: null },
    lastServiceDate: { type: Date, default: null },
    nextServiceDate: { type: Date, default: null },
    accidentStartedAt: { type: Date, default: null },
    accidentActiveUntil: { type: Date, default: null },
    accidentReminderLastSentAt: { type: Date, default: null },
    /** Multi-step approval: requester → HR → Accounts → Asset Controller (on service), then complete. */
    activeServiceWorkflow: {
        serviceRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
        stage: { type: String, default: null },
        previousStatus: { type: String, default: null },
        serviceTypeLabel: { type: String, default: '' },
        accountsHold: {
            reason: { type: String, default: '' },
            days: { type: Number, default: null },
            heldAt: { type: Date, default: null },
            holdUntilDate: { type: Date, default: null },
            remindAt: { type: Date, default: null },
            reminderSentAt: { type: Date, default: null },
        },
        history: [{
            stage: { type: String },
            action: { type: String },
            note: { type: String, default: '' },
            byName: { type: String, default: '' },
            at: { type: Date, default: Date.now }
        }]
    },
    documents: [{
        type: { type: String },
        issueAuthority: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        description: { type: String },
        attachment: { type: String } // URL to uploaded document
    }],
    services: [{
        serviceType: {
            type: String,
            enum: [
                'Oil Service',
                'Tire Change',
                'Mechanical Work',
                'Body Work',
                'Accident Repair',
                'Car Wash',
                'Taxi Charge',
                'Other',
            ],
        },
        date: { type: Date, default: Date.now },
        expiryDate: { type: Date },
        serviceDuration: { type: String },   // e.g. "7 days", "2 weeks"
        currentKm: { type: Number },
        description: { type: String },
        paidBy: { type: String, enum: ['Company', 'Employee', 'Person'] },
        value: { type: Number },
        remark: { type: String },
        invoice: { type: String },           // URL to uploaded invoice
        attachment: { type: String },        // Primary quotation / combined attachment URL
        quotation2: { type: String },        // Optional 2nd quotation (Tire / Mechanical / Body / Accident)
        quotation3: { type: String },        // Optional 3rd quotation
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic' },
        lastWarningSentAt: { type: Date, default: null },
        reminderSentAt: { type: Date, default: null },
        durationCompleteSentAt: { type: Date, default: null },
        /** Frozen copy of multi-step approval when workflow completes/rejects (fleet tracker per row). */
        workflowSnapshot: {
            stage: { type: String, default: null },
            serviceTypeLabel: { type: String, default: '' },
            serviceRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
            history: [{
                stage: { type: String },
                action: { type: String },
                note: { type: String, default: '' },
                byName: { type: String, default: '' },
                at: { type: Date, default: Date.now }
            }]
        }
    }]
}, {
    timestamps: true
});

// Middleware to auto-generate accessory IDs if missing and normalize accessory pendingAction
assetItemSchema.pre('save', function (next) {
    if (this.accessories && this.accessories.length > 0) {
        this.accessories.forEach((acc, index) => {
            if (!acc.accessoryId) {
                const charCode = 65 + (index % 26);
                const suffixNum = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
                acc.accessoryId = `${this.assetId}${String.fromCharCode(charCode)}${suffixNum}`;
            }
            // Normalize pendingAction: string 'null' or empty string -> actual null
            if (acc.pendingAction === 'null' || acc.pendingAction === '') {
                acc.pendingAction = null;
            }
        });
    }
    if (this.services && this.services.length > 0) {
        this.services.forEach((svc) => {
            if (!svc._id) {
                svc._id = new mongoose.Types.ObjectId();
            }
        });
    }
    next();
});

assetItemSchema.pre('save', async function (next) {
    if (this.isModified('assignedTo') || this.isModified('assignedCompany') || this.isModified('status')) {
        if (!this.assignedTo && !this.assignedCompany) {
            this.ownership = 'Unassigned';
        } else if (this.assignedToType === 'Company' && this.assignedCompany) {
            const comp = await mongoose.model('Company').findById(this.assignedCompany).select('name');
            this.ownership = comp ? comp.name : 'Unknown Company';
        } else if (this.assignedTo) {
            const emp = await mongoose.model('EmployeeBasic').findById(this.assignedTo).select('firstName lastName');
            this.ownership = emp ? `${emp.firstName || ''} ${emp.lastName || ''}`.trim() : 'Unknown Employee';
        }
    }
    next();
});

const AssetItem = mongoose.model('AssetItem', assetItemSchema);

export default AssetItem;

import mongoose from 'mongoose';

const assetHistorySchema = mongoose.Schema({
    assetId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'AssetItem',
        required: true
    },
    action: {
        type: String,
        required: true,
        enum: [
            'Created',
            'Assigned',
            'Accepted',
            'Rejected',
            'Returned',
            'Unassigned',
            'Lost',
            'Comment',
            'Service',
            'Restored',
            'Live',
            'End of Life',
            'Out of Service',
            'Service Send',
            'Service Receive',
            'Transfer',
            'On Leave',
            'Extend'
        ]
    },
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
        ref: 'Company'
    },
    performedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
    },
    comments: {
        type: String
    },
    file: {
        type: String,
        default: null
    },
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    },
    date: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

const AssetHistory = mongoose.model('AssetHistory', assetHistorySchema);

export default AssetHistory;

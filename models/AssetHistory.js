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
        enum: ['Assigned', 'Accepted', 'Rejected', 'Returned', 'Unassigned', 'Comment']
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'EmployeeBasic'
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
    date: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

const AssetHistory = mongoose.model('AssetHistory', assetHistorySchema);

export default AssetHistory;

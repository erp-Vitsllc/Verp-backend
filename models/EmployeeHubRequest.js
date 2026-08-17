import mongoose from 'mongoose';
import { HUB_KINDS } from '../utils/employeeHubRequestTypes.js';

const employeeHubRequestSchema = new mongoose.Schema(
    {
        kind: {
            type: String,
            required: true,
            enum: HUB_KINDS,
        },
        /** Which asset area the request is about. Only set for the 'assets' kind. */
        assetType: {
            type: String,
            default: '',
            trim: true,
        },
        description: {
            type: String,
            required: true,
            trim: true,
        },
        attachmentName: {
            type: String,
            default: '',
            trim: true,
        },
        requester: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            required: true,
            index: true,
        },
        requesterEmpId: { type: String, default: '', trim: true },
        requesterName: { type: String, default: '', trim: true },
        assignedTo: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'EmployeeBasic',
            required: true,
            index: true,
        },
        assignedToEmpId: { type: String, default: '', trim: true },
        status: {
            type: String,
            enum: ['Pending', 'Approved', 'Rejected'],
            default: 'Pending',
            index: true,
        },
        decisionNote: { type: String, default: '', trim: true },
        decidedAt: { type: Date, default: null },
        decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeBasic', default: null },
    },
    { timestamps: true },
);

employeeHubRequestSchema.index({ assignedTo: 1, status: 1, kind: 1 });

export default mongoose.model('EmployeeHubRequest', employeeHubRequestSchema);

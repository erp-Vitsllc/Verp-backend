import mongoose from 'mongoose';

/** Idempotency: one tools monthly WhatsApp PDF per employee per calendar month. */
const toolsMonthlyReportLogSchema = new mongoose.Schema(
    {
        monthKey: { type: String, required: true, trim: true },
        employeeId: { type: String, required: true, trim: true },
        assetCount: { type: Number, default: 0 },
        sentAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

toolsMonthlyReportLogSchema.index({ monthKey: 1, employeeId: 1 }, { unique: true });

export default mongoose.model('ToolsMonthlyReportLog', toolsMonthlyReportLogSchema);

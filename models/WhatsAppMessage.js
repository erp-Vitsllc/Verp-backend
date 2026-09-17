import mongoose from 'mongoose';

const whatsAppMessageSchema = new mongoose.Schema(
    {
        waMessageId: { type: String, default: '', trim: true, index: true },
        conversationPhone: { type: String, required: true, trim: true, index: true },
        direction: {
            type: String,
            enum: ['in', 'out'],
            required: true,
            index: true,
        },
        source: {
            type: String,
            enum: ['manual', 'auto', 'broadcast', 'template', 'webhook'],
            default: 'manual',
            index: true,
        },
        status: {
            type: String,
            enum: ['queued', 'sent', 'delivered', 'read', 'failed', 'received'],
            default: 'queued',
            index: true,
        },
        messageType: { type: String, default: 'text', trim: true },
        body: { type: String, default: '' },
        templateName: { type: String, default: '', trim: true },
        fromPhone: { type: String, default: '', trim: true },
        toPhone: { type: String, default: '', trim: true },
        contactName: { type: String, default: '', trim: true },
        employeeId: { type: String, default: '', trim: true, index: true },
        sentByUserId: { type: String, default: '', trim: true },
        sentByName: { type: String, default: '', trim: true },
        error: { type: String, default: '' },
        occurredAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true },
);

whatsAppMessageSchema.index({ conversationPhone: 1, occurredAt: 1 });
whatsAppMessageSchema.index({ waMessageId: 1, direction: 1 });

export default mongoose.model('WhatsAppMessage', whatsAppMessageSchema);

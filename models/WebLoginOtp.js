import mongoose from 'mongoose';

const webLoginOtpSchema = new mongoose.Schema(
  {
    otpToken: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    otpHash: { type: String, required: true },
    deviceId: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

webLoginOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('WebLoginOtp', webLoginOtpSchema);

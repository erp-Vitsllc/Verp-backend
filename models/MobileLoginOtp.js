import mongoose from 'mongoose';

const mobileLoginOtpSchema = new mongoose.Schema(
  {
    otpToken: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    otpHash: { type: String, required: true },
    deviceId: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

mobileLoginOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('MobileLoginOtp', mobileLoginOtpSchema);

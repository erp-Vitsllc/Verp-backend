import mongoose from 'mongoose';

const dayScheduleSchema = new mongoose.Schema(
    {
        isOffDay: { type: Boolean, default: false },
        startHour: { type: String, default: '09' },
        startMinute: { type: String, default: '00' },
        startMeridiem: { type: String, enum: ['AM', 'PM'], default: 'AM' },
        endHour: { type: String, default: '06' },
        endMinute: { type: String, default: '00' },
        endMeridiem: { type: String, enum: ['AM', 'PM'], default: 'PM' },
    },
    { _id: false },
);

const weekSchema = new mongoose.Schema(
    {
        monday: { type: dayScheduleSchema, default: () => ({}) },
        tuesday: { type: dayScheduleSchema, default: () => ({}) },
        wednesday: { type: dayScheduleSchema, default: () => ({}) },
        thursday: { type: dayScheduleSchema, default: () => ({}) },
        friday: { type: dayScheduleSchema, default: () => ({}) },
        saturday: { type: dayScheduleSchema, default: () => ({ isOffDay: true }) },
        sunday: { type: dayScheduleSchema, default: () => ({ isOffDay: true }) },
    },
    { _id: false },
);

/**
 * Company working-time schedules for Site and Office categories.
 * Single document per company (singleton keyed by key='default').
 */
const workingTimeSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            default: 'default',
            trim: true,
        },
        site: { type: weekSchema, default: () => ({}) },
        office: { type: weekSchema, default: () => ({}) },
        /** Weekly schedules for custom work locations, keyed by WorkLocation.key. */
        extra: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true },
);

export default mongoose.model('WorkingTime', workingTimeSchema);

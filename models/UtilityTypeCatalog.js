import mongoose from 'mongoose';

/** Dropdown type names for Add Utility (admin-managed). */
const utilityTypeCatalogSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        active: { type: Boolean, default: true },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            default: null,
        },
    },
    { timestamps: true },
);

utilityTypeCatalogSchema.index(
    { name: 1 },
    { unique: true, collation: { locale: 'en', strength: 2 } },
);

export default mongoose.model('UtilityTypeCatalog', utilityTypeCatalogSchema);

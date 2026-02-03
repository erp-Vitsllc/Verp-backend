import AssetType from '../models/AssetType.js';

// @desc    Create a new asset type
// @route   POST /api/AssetType
// @access  Private
export const createAssetType = async (req, res) => {
    try {
        const { assetId, type, category, total, assigned, unassigned, description } = req.body;

        if (!assetId || !type || !category) {
            return res.status(400).json({ message: 'Asset ID, Type, and Category are required' });
        }

        const existingId = await AssetType.findOne({ assetId });
        if (existingId) {
            return res.status(400).json({ message: 'Asset ID already exists' });
        }

        const assetType = await AssetType.create({
            assetId,
            type,
            category,
            total: Number(total) || 0,
            assigned: Number(assigned) || 0,
            unassigned: Number(unassigned) || 0,
            description
        });

        res.status(201).json(assetType);
    } catch (error) {
        console.error('Error creating asset type:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get all asset types
// @route   GET /api/AssetType
// @access  Private
export const getAssetTypes = async (req, res) => {
    try {
        const assetTypes = await AssetType.find({ isActive: true }).sort({ createdAt: -1 });
        res.status(200).json(assetTypes);
    } catch (error) {
        console.error('Error fetching asset types:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete asset type (soft delete)
// @route   DELETE /api/AssetType/:id
// @access  Private
export const deleteAssetType = async (req, res) => {
    try {
        const { id } = req.params;

        const assetType = await AssetType.findById(id);

        if (!assetType) {
            return res.status(404).json({ message: 'Asset type not found' });
        }

        // Soft delete
        assetType.isActive = false;
        await assetType.save();

        res.status(200).json({ message: 'Asset type deleted successfully' });
    } catch (error) {
        console.error('Error deleting asset type:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

import VehicleOilServiceType from '../models/VehicleOilServiceType.js';
import { isReqUserSystemSuperUser } from '../utils/systemSuperUser.js';

const DEFAULT_OIL_TYPES = ['Engine Oil'];

async function ensureDefaultOilTypes() {
    for (const name of DEFAULT_OIL_TYPES) {
        const exists = await VehicleOilServiceType.findOne({
            name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        }).lean();
        if (!exists) {
            await VehicleOilServiceType.create({ name, active: true });
        }
    }
}

export const listVehicleOilServiceTypes = async (req, res) => {
    try {
        await ensureDefaultOilTypes();
        const rows = await VehicleOilServiceType.find({ active: true })
            .sort({ name: 1 })
            .select('name')
            .lean();
        return res.json(rows.map((r) => r.name));
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load oil types' });
    }
};

export const addVehicleOilServiceType = async (req, res) => {
    try {
        if (!(await isReqUserSystemSuperUser(req.user))) {
            return res.status(403).json({ message: 'Only system super user can add oil types.' });
        }
        const name = String(req.body?.name || '').trim();
        if (!name) {
            return res.status(400).json({ message: 'Oil type name is required.' });
        }
        const existing = await VehicleOilServiceType.findOne({
            name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        });
        if (existing) {
            if (!existing.active) {
                existing.active = true;
                await existing.save();
            }
            return res.json({ message: 'Oil type already exists', name: existing.name });
        }
        const created = await VehicleOilServiceType.create({
            name,
            active: true,
            createdBy: req.user?.id || req.user?._id || null,
        });
        return res.status(201).json({ message: 'Oil type added', name: created.name });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to add oil type' });
    }
};

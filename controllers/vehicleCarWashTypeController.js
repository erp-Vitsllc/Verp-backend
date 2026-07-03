import VehicleCarWashType from '../models/VehicleCarWashType.js';
import { isReqUserSystemSuperUser } from '../utils/systemSuperUser.js';
import { isUserAdministrator } from '../services/permissionService.js';

async function canManageCarWashTypes(reqUser) {
    if (!reqUser) return false;
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    const uid = reqUser.id || reqUser._id;
    if (uid && (await isUserAdministrator(uid))) return true;
    return false;
}

export const listVehicleCarWashTypes = async (req, res) => {
    try {
        const rows = await VehicleCarWashType.find({ active: true })
            .sort({ name: 1 })
            .select('name')
            .lean();
        return res.json(rows.map((r) => r.name));
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load car wash types' });
    }
};

export const addVehicleCarWashType = async (req, res) => {
    try {
        if (!(await canManageCarWashTypes(req.user))) {
            return res.status(403).json({ message: 'Only administrator or super user can add car wash types.' });
        }
        const name = String(req.body?.name || '').trim();
        if (!name) {
            return res.status(400).json({ message: 'Car wash type name is required.' });
        }
        const existing = await VehicleCarWashType.findOne({
            name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        });
        if (existing) {
            if (!existing.active) {
                existing.active = true;
                await existing.save();
            }
            return res.json({ message: 'Car wash type already exists', name: existing.name });
        }
        const created = await VehicleCarWashType.create({
            name,
            active: true,
            createdBy: req.user?.id || req.user?._id || null,
        });
        return res.status(201).json({ message: 'Car wash type added', name: created.name });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to add car wash type' });
    }
};

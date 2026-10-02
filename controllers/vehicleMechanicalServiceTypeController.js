import VehicleMechanicalServiceType from '../models/VehicleMechanicalServiceType.js';
import { isReqUserSystemSuperUser } from '../utils/systemSuperUser.js';
import { isUserAdministrator } from '../services/permissionService.js';

async function canManageMechanicalServiceTypes(reqUser) {
    if (!reqUser) return false;
    if (await isReqUserSystemSuperUser(reqUser)) return true;
    const uid = reqUser.id || reqUser._id;
    if (uid && (await isUserAdministrator(uid))) return true;
    return false;
}

export const listVehicleMechanicalServiceTypes = async (req, res) => {
    try {
        const rows = await VehicleMechanicalServiceType.find({ active: true })
            .sort({ name: 1 })
            .select('name')
            .lean();
        return res.json(rows.map((r) => r.name));
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to load mechanical service types' });
    }
};

export const addVehicleMechanicalServiceType = async (req, res) => {
    try {
        if (!(await canManageMechanicalServiceTypes(req.user))) {
            return res.status(403).json({ message: 'Only administrator or super user can add types.' });
        }
        const name = String(req.body?.name || '').trim();
        if (!name) {
            return res.status(400).json({ message: 'Type of service name is required.' });
        }
        const existing = await VehicleMechanicalServiceType.findOne({
            name: { $regex: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        });
        if (existing) {
            if (!existing.active) {
                existing.active = true;
                await existing.save();
            }
            return res.json({ message: 'Type of service already exists', name: existing.name });
        }
        const created = await VehicleMechanicalServiceType.create({
            name,
            active: true,
            createdBy: req.user?.id || req.user?._id || null,
        });
        return res.status(201).json({ message: 'Type of service added', name: created.name });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to add type of service' });
    }
};

import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import {
    listActiveWorkLocations,
    createWorkLocation,
    deleteWorkLocation,
} from '../utils/workLocationHelpers.js';

function requirePortalSuperUser(req, res) {
    if (isJwtSystemSuperUser(req.user)) return true;
    res.status(403).json({
        message: 'Only the admin super user can add or remove work locations.',
    });
    return false;
}

export async function getWorkLocations(req, res) {
    try {
        const workLocations = await listActiveWorkLocations();
        return res.status(200).json({ workLocations });
    } catch (error) {
        console.error('[getWorkLocations]', error);
        return res.status(500).json({ message: error.message || 'Failed to load work locations.' });
    }
}

export async function postWorkLocation(req, res) {
    try {
        if (!requirePortalSuperUser(req, res)) return;
        const workLocation = await createWorkLocation({
            label: req.body?.label || req.body?.name,
        });
        return res.status(201).json(workLocation);
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({ message: error.message || 'Failed to add work location.' });
    }
}

export async function removeWorkLocation(req, res) {
    try {
        if (!requirePortalSuperUser(req, res)) return;
        const result = await deleteWorkLocation(req.params.id);
        return res.status(200).json(result);
    } catch (error) {
        const status = error.status || 500;
        return res.status(status).json({
            message: error.message || 'Failed to delete work location.',
            ...(error.payload || {}),
        });
    }
}

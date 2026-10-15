import { forceAssignPendingToolsAsset, revertPendingToolsAssignment, userIsToolsAssetController } from '../../utils/toolsAssignmentAckEscalation.js';

async function actorId(req) {
    return req.user?.employeeObjectId || null;
}

export const forceAssignUnacknowledgedToolsAsset = async (req, res) => {
    try {
        const allowed = await userIsToolsAssetController(req);
        if (!allowed) {
            return res.status(403).json({ message: 'Only the asset controller can force assign this asset.' });
        }
        const result = await forceAssignPendingToolsAsset({
            assetId: req.params.id,
            actorEmployeeId: await actorId(req),
        });
        return res.status(result.status).json({ message: result.message, notify: result.notify || null });
    } catch (error) {
        console.error('[forceAssignUnacknowledgedToolsAsset]', error?.message || error);
        return res.status(500).json({ message: 'Could not force assign this asset.' });
    }
};

export const revertUnacknowledgedToolsAssignment = async (req, res) => {
    try {
        const allowed = await userIsToolsAssetController(req);
        if (!allowed) {
            return res.status(403).json({ message: 'Only the asset controller can return this assignment.' });
        }
        const result = await revertPendingToolsAssignment({
            assetId: req.params.id,
            actorEmployeeId: await actorId(req),
        });
        return res.status(result.status).json({ message: result.message });
    } catch (error) {
        console.error('[revertUnacknowledgedToolsAssignment]', error?.message || error);
        return res.status(500).json({ message: 'Could not return this assignment.' });
    }
};

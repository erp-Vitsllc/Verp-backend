import AssetItem from '../models/AssetItem.js';
import { isJwtSystemSuperUser } from '../utils/systemSuperUser.js';
import {
    evaluateVehicleSoldChecks,
    isVehicleSold,
} from '../utils/vehicleSoldGate.js';

async function loadVehicle(id) {
    if (!id) return null;
    return AssetItem.findById(id)
        .select(
            'plateNumber assignedTo assignedToType assignedCompany status pendingAction onServiceActive activeServiceWorkflow services vehicleDispositionStatus vehicleDispositionWorkflow nextServiceDate',
        )
        .populate('assignedTo', 'firstName lastName');
}

export async function getVehicleSoldReadiness(req, res) {
    try {
        if (!isJwtSystemSuperUser(req.user)) {
            return res.status(403).json({ message: 'Only the portal super user can sell a vehicle.' });
        }
        const asset = await loadVehicle(req.params.id);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });
        const readiness = await evaluateVehicleSoldChecks(asset);
        return res.json(readiness);
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to check sold readiness.' });
    }
}

export async function sellVehicleDirect(req, res) {
    try {
        if (!isJwtSystemSuperUser(req.user)) {
            return res.status(403).json({ message: 'Only the portal super user can sell a vehicle.' });
        }
        const description = String(req.body?.description || '').trim();
        if (description.length < 3) {
            return res.status(400).json({ message: 'Enter a description before selling this vehicle.' });
        }

        const asset = await loadVehicle(req.params.id);
        if (!asset) return res.status(404).json({ message: 'Vehicle not found.' });
        if (isVehicleSold(asset)) {
            return res.status(400).json({ message: 'This vehicle is already sold.' });
        }

        const readiness = await evaluateVehicleSoldChecks(asset);
        if (!readiness.canSell) {
            const failed = readiness.checks.filter((row) => !row.passed).map((row) => row.label);
            return res.status(400).json({
                message: `Cannot sell until every check passes: ${failed.join('; ')}.`,
                checks: readiness.checks,
            });
        }

        const byName = String(req.user?.name || req.user?.username || 'Super User').trim();
        const priorHistory = Array.isArray(asset.vehicleDispositionWorkflow?.history)
            ? asset.vehicleDispositionWorkflow.history.slice(-20)
            : [];
        asset.vehicleDispositionStatus = 'sold';
        asset.set('vehicleDispositionWorkflow', {
            targetStatus: 'sold',
            stage: 'complete',
            note: description,
            requestedAt: new Date(),
            requestedByName: byName,
            soldValue: asset.vehicleDispositionWorkflow?.soldValue ?? null,
            history: [
                ...priorHistory,
                {
                    stage: 'complete',
                    action: 'sold',
                    note: description,
                    byName,
                    at: new Date(),
                },
            ],
        });
        asset.nextServiceDate = null;
        asset.onServiceActive = false;
        await asset.save();

        return res.json({
            message: 'Vehicle marked as sold.',
            vehicleDispositionStatus: 'sold',
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to sell vehicle.' });
    }
}

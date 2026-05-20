import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { buildBulkAssetInventoryPdfAttachment } from '../utils/generateBulkAssetInventoryPdf.js';
import {
    notifyAdminDeletedAccessoryCatalogEntry,
    isReqUserAdmin,
    scheduleManagementAdminDeletionEmail,
} from '../utils/sendAdminDeletionNotificationEmails.js';
import { generateVegaAccessoryCatalogId, syncAllAccessoryInstancesForAsset } from '../utils/syncAssetAccessoryCatalog.js';

const generateAccessoryCatalogId = generateVegaAccessoryCatalogId;

function effectiveCatalogRowStatus(row) {
    if (row?.status != null && String(row.status).trim() !== '') {
        return String(row.status).trim();
    }
    if (row?.recordType === 'instance' && row?.assetItemId) {
        return 'Attached';
    }
    return 'Unattached';
}

function isTerminalCatalogRowStatus(st) {
    return st === 'Lost' || st === 'EndOfLife' || st === 'End of Life';
}

function formatEmployeeDisplay(emp) {
    if (!emp || typeof emp !== 'object') return '';
    const fn = emp.firstName || '';
    const ln = emp.lastName || '';
    const full = `${fn} ${ln}`.trim();
    if (full) return full;
    return emp.employeeId ? String(emp.employeeId).trim() : '';
}

function formatAssetControllerDisplay(ac) {
    if (!ac) return '';
    if (ac.firstName || ac.lastName) {
        return `${ac.firstName || ''} ${ac.lastName || ''}`.trim();
    }
    if (ac.employeeName) return String(ac.employeeName).trim();
    return '';
}

function catalogRowAssetItemIdKey(row) {
    const id = row?.assetItemId;
    if (!id) return null;
    if (typeof id === 'object' && id._id != null) return id._id.toString();
    return id.toString();
}

export const getAccessoryCatalogHistory = async (req, res) => {
    try {
        const doc = await AssetAccessoryCatalog.findById(req.params.id).lean();
        if (!doc) {
            return res.status(404).json({ message: 'Accessory not found' });
        }

        const raw = Array.isArray(doc.history) ? [...doc.history] : [];
        raw.sort((a, b) => new Date(a.at) - new Date(b.at));
        if (raw.length === 0 && doc.createdAt) {
            raw.push({
                at: doc.createdAt,
                action: 'created',
                message: `Catalog entry "${doc.name}" (${doc.accessoryCatalogId})`
            });
        }

        const events = raw.map((e) => ({
            at: e.at,
            action: e.action,
            message: e.message,
            assetId: e.assetId || null,
            assetName: e.assetName || null,
            assetObjectId: e.assetObjectId || null
        }));

        res.json({
            accessoryCatalogId: doc.accessoryCatalogId,
            name: doc.name,
            events
        });
    } catch (error) {
        console.error('getAccessoryCatalogHistory:', error);
        res.status(500).json({ message: 'Failed to load accessory history' });
    }
};

export const getAccessoryCatalog = async (req, res) => {
    try {
        const list = await AssetAccessoryCatalog.find({ isActive: true })
            .sort({ createdAt: -1 })
            .lean();

        const assetControllerHod = await getDepartmentHOD('assetcontroller');
        const acDisplay = formatAssetControllerDisplay(assetControllerHod);

        const assetIdsNeedingOwner = [
            ...new Set(
                list
                    .filter((row) => {
                        const st = effectiveCatalogRowStatus(row);
                        if (isTerminalCatalogRowStatus(st)) return false;
                        if (!catalogRowAssetItemIdKey(row)) return false;
                        return st === 'Attached' || st === 'Pending';
                    })
                    .map((row) => catalogRowAssetItemIdKey(row))
            )
        ];

        let assetMap = new Map();
        if (assetIdsNeedingOwner.length > 0) {
            const assets = await AssetItem.find({ _id: { $in: assetIdsNeedingOwner } })
                .select('assignedTo assignedToType assignedCompany assetId')
                .populate('assignedTo', 'firstName lastName employeeId')
                .populate('assignedCompany', 'name companyId')
                .lean();
            assetMap = new Map(assets.map((a) => [a._id.toString(), a]));
        }

        const enriched = list.map((row) => {
            const st = effectiveCatalogRowStatus(row);
            let ownedByDisplay = '';

            if (isTerminalCatalogRowStatus(st)) {
                ownedByDisplay = '';
            } else if (st === 'Unattached') {
                ownedByDisplay = acDisplay;
            } else if (st === 'Pending' && !catalogRowAssetItemIdKey(row)) {
                ownedByDisplay = acDisplay;
            } else if ((st === 'Attached' || st === 'Pending') && catalogRowAssetItemIdKey(row)) {
                const asset = assetMap.get(catalogRowAssetItemIdKey(row));
                if (!asset) {
                    ownedByDisplay = acDisplay;
                } else if (asset.assignedToType === 'Company' && asset.assignedCompany) {
                    const companyName =
                        typeof asset.assignedCompany === 'object'
                            ? (asset.assignedCompany.name || '').trim()
                            : '';
                    ownedByDisplay = companyName || acDisplay;
                } else if (asset.assignedTo) {
                    ownedByDisplay = formatEmployeeDisplay(asset.assignedTo) || acDisplay;
                } else {
                    ownedByDisplay = acDisplay;
                }
            } else {
                ownedByDisplay = acDisplay;
            }

            return { ...row, ownedByDisplay };
        });

        res.json(enriched);
    } catch (error) {
        console.error('getAccessoryCatalog:', error);
        res.status(500).json({ message: 'Failed to load accessories catalog' });
    }
};

export const createAccessoryCatalog = async (req, res) => {
    try {
        const { name, price, description } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ message: 'Name is required' });
        }
        const accessoryCatalogId = await generateAccessoryCatalogId();
        const trimmedName = String(name).trim();
        const doc = await AssetAccessoryCatalog.create({
            recordType: 'catalog',
            accessoryCatalogId,
            name: trimmedName,
            price: price != null && price !== '' ? Number(price) : 0,
            description: description != null ? String(description).trim() : '',
            status: 'Unattached',
            history: [{
                at: new Date(),
                action: 'created',
                message: `Accessory "${trimmedName}" created in catalog (${accessoryCatalogId})`
            }]
        });
        res.status(201).json(doc);
    } catch (error) {
        console.error('createAccessoryCatalog:', error);
        res.status(500).json({ message: 'Failed to create accessory' });
    }
};

export const updateAccessoryCatalog = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, price, description } = req.body;
        const doc = await AssetAccessoryCatalog.findById(id);
        if (!doc || !doc.isActive) {
            return res.status(404).json({ message: 'Accessory not found' });
        }
        const changed = [];
        if (name !== undefined) {
            if (!String(name).trim()) return res.status(400).json({ message: 'Name is required' });
            doc.name = String(name).trim();
            changed.push('name');
        }
        if (price !== undefined) {
            doc.price = price !== '' && price != null ? Number(price) : 0;
            changed.push('price');
        }
        if (description !== undefined) {
            doc.description = String(description ?? '').trim();
            changed.push('description');
        }
        if (changed.length) {
            doc.history = doc.history || [];
            doc.history.push({
                at: new Date(),
                action: 'updated',
                message: `Catalog entry updated (${changed.join(', ')})`
            });
            doc.markModified('history');
        }
        await doc.save();
        res.json(doc);
    } catch (error) {
        console.error('updateAccessoryCatalog:', error);
        res.status(500).json({ message: 'Failed to update accessory' });
    }
};

export const deleteAccessoryCatalog = async (req, res) => {
    try {
        const { id } = req.params;
        const doc = await AssetAccessoryCatalog.findById(id);
        if (!doc) return res.status(404).json({ message: 'Accessory not found' });
        doc.history = doc.history || [];
        doc.history.push({
            at: new Date(),
            action: 'removed',
            message: `Accessory removed from catalog (${doc.accessoryCatalogId})`
        });
        doc.markModified('history');
        doc.isActive = false;
        await doc.save();
        if (await isReqUserAdmin(req.user)) {
            const performedBy = req.user?.name || req.user?.employeeId || 'Administrator';
            const catalogSnapshot = doc.toObject ? doc.toObject() : doc;
            scheduleManagementAdminDeletionEmail(req, {
                moduleName: 'Accessory catalog',
                recordId: doc.accessoryCatalogId || String(doc._id),
                details: doc.name || 'Accessory catalog entry',
                deletedPayload: catalogSnapshot,
            });
            void notifyAdminDeletedAccessoryCatalogEntry({
                accessoryCatalogId: doc.accessoryCatalogId,
                name: doc.name,
                performedBy
            }).catch((e) => console.error('[notify catalog accessory delete]', e?.message || e));
        }
        res.json({ message: 'Accessory removed' });
    } catch (error) {
        console.error('deleteAccessoryCatalog:', error);
        res.status(500).json({ message: 'Failed to delete accessory' });
    }
};

export const requestAttachAccessoryCatalog = async (req, res) => {
    try {
        const { id } = req.params;
        const { targetAssetId } = req.body;

        if (!targetAssetId) return res.status(400).json({ message: 'targetAssetId is required' });

        const catalog = await AssetAccessoryCatalog.findById(id);
        if (!catalog || !catalog.isActive) return res.status(404).json({ message: 'Accessory not found in catalog' });
        if (catalog.status === 'Pending') return res.status(400).json({ message: 'Accessory already has a pending attach request' });

        const targetAsset = await AssetItem.findById(targetAssetId)
            .populate('assignedTo', 'firstName lastName employeeId companyEmail')
            .select('assetId name status assignedTo accessories')
            .lean();
        if (!targetAsset) return res.status(404).json({ message: 'Target asset not found' });
        if (targetAsset.status === 'Draft') return res.status(400).json({ message: 'Draft assets cannot receive accessories' });

        const requesterEmpId = req.user?.employeeObjectId?.toString?.() || null;
        const assigneeOid = targetAsset.assignedTo?._id?.toString?.() || null;
        const isAssigneeRequester = !!(requesterEmpId && assigneeOid && requesterEmpId === assigneeOid);
        const isAdminRequester =
            req.user?.isAdmin === true || req.user?.role === 'Admin' || req.user?.role === 'ROOT';
        const isAcRequester = await isUserInFlowchart(req.user, 'assetcontroller').catch(() => false);

        let approver = null;
        if (targetAsset.assignedTo?._id) {
            // Assignee (holder) requests → AC approves. AC/Admin requests → assignee approves. Anyone else (e.g. assigner) → AC approves.
            if (isAssigneeRequester && !isAdminRequester) {
                approver = await getDepartmentHOD('assetcontroller');
            } else if (isAcRequester || isAdminRequester) {
                approver = await EmployeeBasic.findById(targetAsset.assignedTo._id)
                    .select('_id firstName lastName employeeId companyEmail workEmail personalEmail email primaryReportee')
                    .populate('primaryReportee', 'firstName lastName companyEmail workEmail personalEmail email')
                    .lean();
            } else {
                approver = await getDepartmentHOD('assetcontroller');
            }
        }
        if (!approver?._id) {
            approver = await getDepartmentHOD('assetcontroller');
        }
        if (!approver?._id) return res.status(400).json({ message: 'No approver found for target asset' });

        const targetDoc = await AssetItem.findById(targetAssetId);
        targetDoc.accessories.push({
            // Preserve catalog ACC ID across all asset flows
            accessoryId: catalog.accessoryCatalogId,
            name: catalog.name,
            amount: Number(catalog.price || 0),
            description: catalog.description || '',
            status: 'Pending',
            pendingAction: 'Add',
            pendingActionDetails: {
                reason: `Attach catalog accessory "${catalog.name}" to asset ${targetDoc.assetId}`,
                requestedBy: req.user.employeeObjectId || null,
                requestedAt: new Date(),
                catalogItemId: catalog._id,
                addApprovalKind: 'AssetController'
            }
        });
        targetDoc.actionRequiredBy = approver._id;
        targetDoc.markModified('accessories');
        await targetDoc.save();
        try {
            await syncAllAccessoryInstancesForAsset(targetDoc);
        } catch (syncErr) {
            console.error('[requestAttachAccessoryCatalog sync]', syncErr?.message || syncErr);
        }
        catalog.status = 'Pending';
        catalog.history = catalog.history || [];
        catalog.history.push({
            at: new Date(),
            action: 'attach_requested',
            message: `Attach requested to asset ${targetDoc.assetId} — ${targetDoc.name}`,
            assetId: targetDoc.assetId,
            assetName: targetDoc.name,
            assetObjectId: targetDoc._id
        });
        catalog.markModified('history');
        await catalog.save();

        await DashboardAction.create({
            assignedTo: approver._id,
            assignedToEmpId: approver.employeeId,
            requestId: targetDoc._id,
            requestType: 'Asset Accessory Approval',
            status: 'Pending',
            subjectEmployeeId: targetAsset.assignedTo?.employeeId || '',
            subjectName: targetAsset.assignedTo ? `${targetAsset.assignedTo.firstName || ''} ${targetAsset.assignedTo.lastName || ''}`.trim() : targetDoc.name,
            requestedByName: req.user.employeeId || 'System',
            extra1: `${targetDoc.assetId} — Accessory: ${catalog.name}`
        });

        try {
            let catAttachPdf = [];
            try {
                catAttachPdf = await buildBulkAssetInventoryPdfAttachment(req, [targetDoc._id.toString()], 'catalog-attach-request-inventory');
            } catch (e) {
                /* non-fatal */
            }
            await sendAssetActionApprovalEmail(
                {
                    ...targetDoc.toObject(),
                    assignedTo: targetAsset.assignedTo,
                    name: `${targetDoc.name} - Accessory: ${catalog.name}`
                },
                `Attach catalog accessory "${catalog.name}"`,
                approver,
                { name: req.user.employeeId || 'System' },
                'Catalog accessory attach request pending approval.',
                catAttachPdf
            );
        } catch (emailErr) {
            console.error('[requestAttachAccessoryCatalog] Email send failed (non-fatal):', emailErr.message);
        }

        return res.status(200).json({
            message: 'Attach request sent for approval.',
            approverEmployeeId: approver.employeeId || null,
            approverName: `${approver.firstName || ''} ${approver.lastName || ''}`.trim() || approver.employeeId || 'Approver'
        });
    } catch (error) {
        console.error('requestAttachAccessoryCatalog:', error);
        res.status(500).json({ message: 'Failed to request accessory attach' });
    }
};

import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';
import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import DashboardAction from '../models/DashboardAction.js';
import { getDepartmentHOD, isUserInFlowchart } from '../utils/getDepartmentHOD.js';
import { sendAssetActionApprovalEmail } from '../utils/sendAssetActionApprovalEmail.js';
import { buildBulkAssetInventoryPdfAttachment } from '../utils/generateBulkAssetInventoryPdf.js';

const generateAccessoryCatalogId = async () => {
    const prefix = 'asset-acc-cat-';
    const regex = new RegExp(`^${prefix}\\d+$`);
    const item = await AssetAccessoryCatalog.findOne({
        accessoryCatalogId: { $regex: regex }
    }).sort({ accessoryCatalogId: -1 });

    if (!item?.accessoryCatalogId) return `${prefix}001`;

    const idStr = item.accessoryCatalogId;
    const numberStr = idStr.substring(prefix.length);
    const numericPart = parseInt(numberStr, 10);
    const nextNum = Number.isNaN(numericPart) ? 1 : numericPart + 1;
    return `${prefix}${String(nextNum).padStart(3, '0')}`;
};

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
        res.json(list);
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
            name: catalog.name,
            amount: Number(catalog.price || 0),
            description: catalog.description || '',
            status: 'Pending',
            pendingAction: 'Add',
            pendingActionDetails: {
                reason: `Attach catalog accessory "${catalog.name}" to asset ${targetDoc.assetId}`,
                requestedBy: req.user.employeeObjectId || null,
                requestedAt: new Date(),
                catalogItemId: catalog._id
            }
        });
        targetDoc.actionRequiredBy = approver._id;
        targetDoc.markModified('accessories');
        await targetDoc.save();
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

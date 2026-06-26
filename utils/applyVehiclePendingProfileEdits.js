import AssetType from '../models/AssetType.js';
import { uploadDocumentToS3 } from './s3Upload.js';

const normType = (t) => String(t || '').toLowerCase().trim();

async function resolveBrandTypeId(brandName) {
    const trimmed = String(brandName || '').trim();
    if (!trimmed) return null;
    let tDoc = await AssetType.findOne({ name: trimmed, isActive: true });
    if (!tDoc) {
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        tDoc = await AssetType.findOne({
            name: { $regex: new RegExp(`^${escaped}$`, 'i') },
            isActive: true,
        });
    }
    return tDoc?._id || null;
}

async function applyPutAssetType(asset, body = {}) {
    const updates = { ...body };
    const brandInput = String(updates.brand ?? updates.type ?? '').trim();
    if (brandInput) {
        asset.vehicleBrand = brandInput;
        const typeId = await resolveBrandTypeId(brandInput);
        if (typeId) asset.typeId = typeId;
    }
    delete updates.brand;
    delete updates.type;

    for (const [key, val] of Object.entries(updates)) {
        if (key === 'photo' || key === 'imagePreview') {
            if (val && String(val).startsWith('data:image')) {
                try {
                    const uploadResult = await uploadDocumentToS3(val, 'asset-photos');
                    asset.photo = uploadResult.publicId;
                    asset.imagePreview = uploadResult.publicId;
                } catch {
                    asset[key] = val;
                }
            } else if (val != null) {
                asset[key] = val;
            }
            continue;
        }
        if (val !== undefined) asset[key] = val;
    }
}

async function applyDocumentStep(asset, step) {
    const body = step.body || {};
    if (step.op === 'delete_document') {
        const docId = step.docId;
        const doc = asset.documents.id(docId);
        if (doc) doc.deleteOne();
        return;
    }
    if (step.op === 'post_document') {
        let documentUrl = null;
        if (body.document?.data) {
            const uploadResult = await uploadDocumentToS3(
                body.document.data,
                'asset-documents',
                body.document.name || body.document.fileName || 'document',
            );
            documentUrl = uploadResult.publicId;
        }
        asset.documents.push({
            type: body.type,
            issueAuthority: body.issueAuthority || null,
            issueDate: body.issueDate || null,
            expiryDate: body.expiryDate || null,
            description: body.description || null,
            attachment: documentUrl,
        });
        return;
    }
    if (step.op === 'put_document') {
        const doc = asset.documents.id(step.docId);
        if (!doc) throw new Error('Document not found for pending edit');
        if (body.type) doc.type = body.type;
        if (body.issueAuthority !== undefined) doc.issueAuthority = body.issueAuthority;
        if (body.issueDate !== undefined) doc.issueDate = body.issueDate;
        if (body.expiryDate !== undefined) doc.expiryDate = body.expiryDate;
        if (body.description !== undefined) doc.description = body.description;
        if (body.document?.data) {
            const uploadResult = await uploadDocumentToS3(
                body.document.data,
                'asset-documents',
                body.document.name || body.document.fileName || 'document',
            );
            doc.attachment = uploadResult.publicId;
        }
    }
}

/**
 * Apply queued profile-edit steps for one pending entry (or all entries).
 * @param {import('mongoose').Document} asset Mongoose AssetItem document
 * @param {{ steps?: unknown[] }} pendingEntry
 */
export async function applyVehiclePendingProfileEditEntry(asset, pendingEntry) {
    const steps = Array.isArray(pendingEntry?.steps) ? pendingEntry.steps : [];
    for (const step of steps) {
        if (!step || typeof step !== 'object') continue;
        if (step.op === 'put_asset_type') {
            await applyPutAssetType(asset, step.body || {});
            continue;
        }
        if (['delete_document', 'post_document', 'put_document'].includes(step.op)) {
            await applyDocumentStep(asset, step);
        }
    }
}

export async function applyAllVehiclePendingProfileEdits(asset) {
    const pending = Array.isArray(asset.vehiclePendingProfileEdits) ? asset.vehiclePendingProfileEdits : [];
    for (const entry of pending) {
        await applyVehiclePendingProfileEditEntry(asset, entry);
    }
}

export function isProtectedVehicleDocumentType(typeName) {
    const t = normType(typeName);
    return t === 'registration' || t === 'registration attachment' || t === 'insurance' || t === 'insurance attachment';
}

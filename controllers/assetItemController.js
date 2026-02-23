import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import AssetHistory from '../models/AssetHistory.js';
import { getSignedFileUrl, uploadDocumentToS3 } from '../utils/s3Upload.js';
import { generatePdf } from '../utils/generatePdf.js';
import User from '../models/User.js';
import { sendAssetAssignmentEmail } from '../utils/sendAssetAssignmentEmail.js';
import { sendAssetResponseEmail } from '../utils/sendAssetResponseEmail.js';

// @desc    Get all items for a specific asset type
// @route   GET /api/AssetItem/:typeId
// @access  Private
export const getAssetItems = async (req, res) => {
    try {
        const { typeId } = req.params;

        // Find items and populate assignedTo for name display
        const items = await AssetItem.find({ typeId: typeId })
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId department primaryReportee reportingAuthority',
                populate: [
                    { path: 'primaryReportee', select: 'firstName lastName' },
                    { path: 'reportingAuthority', select: 'firstName lastName' }
                ]
            })
            .sort({ assetId: 1 });

        // Sign URLs for each item
        const signedItems = await Promise.all(items.map(async (item) => {
            const itemObj = item.toObject();
            if (itemObj.photo) {
                itemObj.photo = await getSignedFileUrl(itemObj.photo);
            }
            if (itemObj.imagePreview) {
                itemObj.imagePreview = await getSignedFileUrl(itemObj.imagePreview);
            }
            return itemObj;
        }));

        res.status(200).json(signedItems);
    } catch (error) {
        console.error('Error fetching asset items:', error);
        res.status(500).json({ message: 'Server Error' });
    }

};

// @desc    Get all assigned assets (regardless of type)
// @route   GET /api/AssetItem/assigned/all
// @access  Private
export const getAllAssignedAssets = async (req, res) => {
    try {
        const items = await AssetItem.find({
            status: { $in: ['Assigned', 'Active', 'Returned'] },
            assignedTo: { $ne: null }
        })
            .select('assetId name assignedTo')
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId'
            })
            .sort({ name: 1 });

        res.status(200).json(items);
    } catch (error) {
        console.error('Error fetching assigned assets:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Create a new asset item
// @route   POST /api/AssetItem
// @access  Private
export const createAssetItem = async (req, res) => {
    try {
        let { assetTypeId, name, photo, status, categoryId, assetValue, purchaseDate, warrantyYears, lastServiceDate, accessories } = req.body;

        if (!assetTypeId || !name) {
            return res.status(400).json({ message: 'Asset Type and Name are required' });
        }

        // Handle Photo Upload
        let photoS3Key = photo;
        if (photo && photo.startsWith('data:image')) {
            try {
                const uploadResult = await uploadDocumentToS3(photo, 'asset-photos');
                photoS3Key = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading asset photo to S3:', error);
            }
        }

        // Fetch the starting numeric part for IDs
        const prefix = 'VEGA-ASSET-';
        const regex = new RegExp(`^${prefix}\\d+$`);
        const lastItem = await AssetItem.findOne({
            assetId: { $regex: regex }
        }).sort({ assetId: -1 });

        let startingNum = 1;
        if (lastItem && lastItem.assetId) {
            const numStr = lastItem.assetId.substring(prefix.length);
            const numericPart = parseInt(numStr, 10);
            if (!isNaN(numericPart)) startingNum = numericPart + 1;
        }

        const newItemId = `${prefix}${String(startingNum).padStart(3, '0')}`;

        // Helper to generate accessory suffix (A, B, C...)
        const generateAccessoryId = (assetId, index) => {
            const charCode = 65 + (index % 26);
            const suffixNum = Math.floor(index / 26) > 0 ? String(Math.floor(index / 26)) : '';
            return `${assetId}${String.fromCharCode(charCode)}${suffixNum}`;
        };

        const formattedAccessories = (accessories || []).map((acc, accIdx) => ({
            ...acc,
            accessoryId: generateAccessoryId(newItemId, accIdx)
        }));

        const newItem = await AssetItem.create({
            typeId: assetTypeId,
            categoryId: categoryId || null,
            assetId: newItemId,
            name,
            photo: photoS3Key,
            imagePreview: photoS3Key,
            assetValue: assetValue || 0,
            purchaseDate: purchaseDate || null,
            warrantyYears: warrantyYears || 0,
            status: status || 'Unassigned',
            lastServiceDate: lastServiceDate || null,
            accessories: formattedAccessories
        });

        // Update counts on AssetType
        await updateAssetTypeCounts(assetTypeId);

        res.status(201).json(newItem);
    } catch (error) {
        console.error('Error creating asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get single asset item details
// @route   GET /api/AssetItem/detail/:id
// @access  Private
export const getAssetItemDetail = async (req, res) => {
    try {
        const { id } = req.params;
        const item = await AssetItem.findById(id)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee signature',
                populate: [
                    {
                        path: 'reportingAuthority',
                        select: 'firstName lastName'
                    },
                    {
                        path: 'primaryReportee',
                        select: 'firstName lastName'
                    }
                ]
            })
            .populate({
                path: 'assignedBy',
                select: 'firstName lastName employeeId signature'
            })
            .populate('typeId', 'name imagePreview')
            .populate('categoryId', 'name imagePreview');

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const itemObj = item.toObject();

        // Sign URLs
        if (itemObj.invoiceFile) {
            itemObj.invoiceFile = await getSignedFileUrl(itemObj.invoiceFile);
        }
        if (itemObj.warrantyAttachment) {
            itemObj.warrantyAttachment = await getSignedFileUrl(itemObj.warrantyAttachment);
        }
        if (itemObj.typeId?.imagePreview) {
            itemObj.typeId.imagePreview = await getSignedFileUrl(itemObj.typeId.imagePreview);
        }
        if (itemObj.categoryId?.imagePreview) {
            itemObj.categoryId.imagePreview = await getSignedFileUrl(itemObj.categoryId.imagePreview);
        }
        if (itemObj.imagePreview) {
            itemObj.imagePreview = await getSignedFileUrl(itemObj.imagePreview);
        }
        if (itemObj.photo) {
            itemObj.photo = await getSignedFileUrl(itemObj.photo);
        }
        if (itemObj.accessories && itemObj.accessories.length > 0) {
            for (let acc of itemObj.accessories) {
                if (acc.attachment) {
                    acc.attachment = await getSignedFileUrl(acc.attachment);
                }
            }
        }

        if (itemObj.assignedBy?.signature?.url) {
            itemObj.assignedBy.signature.url = await getSignedFileUrl(itemObj.assignedBy.signature.url);
        }

        if (itemObj.assignedTo?.signature?.url) {
            itemObj.assignedTo.signature.url = await getSignedFileUrl(itemObj.assignedTo.signature.url);
        }

        if (itemObj.documents && itemObj.documents.length > 0) {
            for (let doc of itemObj.documents) {
                if (doc.attachment) {
                    doc.attachment = await getSignedFileUrl(doc.attachment);
                }
            }
        }

        if (itemObj.services && itemObj.services.length > 0) {
            for (let service of itemObj.services) {
                if (service.invoice) {
                    service.invoice = await getSignedFileUrl(service.invoice);
                }
            }
        }

        res.status(200).json(itemObj);
    } catch (error) {
        console.error('Error fetching asset item detail:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Assign an asset item to an employee
// @route   PUT /api/AssetItem/:id/assign
// @access  Private
export const assignAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        const { assignedTo, assignmentType, assignedDays } = req.body;

        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Employee and assignment type are required' });
        }

        const item = await AssetItem.findById(id);
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Check if assigner (current user) has a signature
        if (!req.user.employeeObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const assigner = await EmployeeBasic.findById(req.user.employeeObjectId);
        if (!assigner || !assigner.signature || !assigner.signature.url) {
            return res.status(403).json({ message: "cant you cant assign u r signator not added" });
        }

        item.assignedTo = assignedTo;
        item.assignedBy = req.user.employeeObjectId;
        item.assignmentType = assignmentType;
        item.assignedDays = assignmentType === 'Temporary' ? assignedDays : null;
        item.status = 'Pending';
        item.acceptanceStatus = 'Pending';
        item.actionRequiredBy = assignedTo; // Assignee must respond first
        item.negotiationHistory = [];

        await item.save();

        // Log to Asset History
        await AssetHistory.create({
            assetId: item._id,
            action: 'Assigned',
            assignedTo: assignedTo,
            performedBy: req.user.employeeObjectId
        });

        // Update counts on AssetType
        await updateAssetTypeCounts(item.typeId);

        const updatedItem = await AssetItem.findById(id)
            .populate({
                path: 'assignedTo',
                select: 'firstName lastName employeeId profilePicture companyEmail workEmail department dateOfJoining reportingAuthority primaryReportee',
                populate: [
                    {
                        path: 'reportingAuthority',
                        select: 'firstName lastName'
                    },
                    {
                        path: 'primaryReportee',
                        select: 'firstName lastName'
                    }
                ]
            })
            .populate({
                path: 'assignedBy',
                select: 'firstName lastName employeeId signature'
            })
            .populate('typeId', 'name imagePreview')
            .populate('categoryId', 'name imagePreview');

        // Send Email Notification
        try {
            const employee = updatedItem.assignedTo;
            if (employee) {
                // Check if employee is a User
                let recipient = await User.findOne({ employeeId: employee.employeeId });

                // If not a user, find manager (primaryReportee)
                if (!recipient && employee.primaryReportee) {
                    recipient = await EmployeeBasic.findById(employee.primaryReportee);
                }

                if (recipient) {
                    await sendAssetAssignmentEmail({
                        asset: updatedItem,
                        employee: employee,
                        recipient: recipient
                    });
                }
            }
        } catch (emailErr) {
            console.error('Error in asset assignment email trigger:', emailErr);
        }

        res.status(200).json(updatedItem);
    } catch (error) {
        console.error('Error assigning asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Bulk assign asset items to an employee
// @route   PUT /api/AssetItem/bulk/assign
// @access  Private
export const bulkAssignAssetItems = async (req, res) => {
    try {
        const { assetIds, assignedTo, assignmentType, assignedDays } = req.body;

        if (!assetIds || !Array.isArray(assetIds) || assetIds.length === 0) {
            return res.status(400).json({ message: 'No assets selected' });
        }
        if (!assignedTo || !assignmentType) {
            return res.status(400).json({ message: 'Employee and assignment type are required' });
        }

        // Check if assigner (current user) has a signature
        if (!req.user.employeeObjectId) {
            return res.status(403).json({ message: "You are not linked to an employee profile." });
        }

        const assigner = await EmployeeBasic.findById(req.user.employeeObjectId);
        if (!assigner || !assigner.signature || !assigner.signature.url) {
            return res.status(403).json({ message: "cant you cant assign u r signator not added" });
        }

        // Update all items
        const updateData = {
            assignedTo,
            assignedBy: req.user.employeeObjectId,
            assignmentType,
            assignedDays: assignmentType === 'Temporary' ? assignedDays : null,
            status: 'Pending',
            acceptanceStatus: 'Pending',
            actionRequiredBy: assignedTo, // Assignee must respond
            negotiationHistory: []
        };

        await AssetItem.updateMany(
            { _id: { $in: assetIds } },
            { $set: updateData }
        );

        // Log history for each asset
        const historyEntries = assetIds.map(assetId => ({
            assetId,
            action: 'Assigned',
            assignedTo,
            performedBy: req.user.employeeObjectId,
            date: new Date()
        }));
        await AssetHistory.insertMany(historyEntries);

        // Update counts for all unique typeIds affected
        const items = await AssetItem.find({ _id: { $in: assetIds } }).select('typeId');
        const uniqueTypeIds = [...new Set(items.map(i => i.typeId.toString()))];

        for (const typeId of uniqueTypeIds) {
            await updateAssetTypeCounts(typeId);
        }

        // Send Email Notification
        try {
            const employee = await EmployeeBasic.findById(assignedTo);
            const firstAsset = await AssetItem.findById(assetIds[0]).populate('categoryId');

            if (employee && firstAsset) {
                // Check if employee is a User
                let recipient = await User.findOne({ employeeId: employee.employeeId });

                // If not a user, find manager (primaryReportee)
                if (!recipient && employee.primaryReportee) {
                    recipient = await EmployeeBasic.findById(employee.primaryReportee);
                }

                if (recipient) {
                    await sendAssetAssignmentEmail({
                        asset: firstAsset, // Use first asset as sample for category etc
                        employee: employee,
                        recipient: recipient,
                        isBulk: true,
                        assetCount: assetIds.length
                    });
                }
            }
        } catch (emailErr) {
            console.error('Error in bulk asset assignment email trigger:', emailErr);
        }

        res.status(200).json({ message: `${assetIds.length} assets assigned successfully` });
    } catch (error) {
        console.error('Error bulk assigning assets:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Download Asset Handover Form PDF
// @route   GET /api/AssetItem/handover-pdf/:id
// @access  Private
export const downloadHandoverPdf = async (req, res) => {
    try {
        const { id } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // URL to the frontend print page we created
        const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
        const baseUrl = origin || process.env.FRONTEND_URL || 'http://localhost:3000';
        const printUrl = `${baseUrl}/print/asset-handover/${id}`;

        console.log(`Generating Asset Handover PDF from: ${printUrl}`);

        const token = req.headers.authorization?.split(' ')[1] || '';

        // Prepare user payload for Puppeteer auth
        const requestingUserId = req.user?.id;
        const userObj = await User.findById(requestingUserId);

        const userPayload = {
            id: requestingUserId,
            isAdmin: userObj?.isAdmin || userObj?.role === 'Admin' || userObj?.role === 'ROOT',
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const permissions = {}; // Default permissions

        // Use the specific selector in our print page
        const selector = '#asset-handover-container';

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, selector);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="HandoverForm-${asset.assetId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error generating Asset Handover PDF:', error);
        res.status(500).json({ message: 'Failed to generate PDF', error: error.message });
    }
};

// @desc    Respond to asset assignment (Accept/Reject/Negotiate)
// @route   PUT /api/AssetItem/:id/respond
// @access  Private (Assigned User or Assigner)
export const respondToAssignment = async (req, res) => {
    try {
        const { id } = req.params;
        const { action, comments } = req.body; // action: 'Accept', 'Reject', 'AcceptWithComments'

        if (!['Accept', 'Reject', 'AcceptWithComments'].includes(action)) {
            return res.status(400).json({ message: 'Invalid action.' });
        }

        const item = await AssetItem.findById(id).populate('assignedTo assignedBy');
        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const currentUser = req.user.employeeObjectId;
        const isAssignee = item.assignedTo?._id.toString() === currentUser.toString();
        const isAssigner = item.assignedBy?._id.toString() === currentUser.toString();

        // Check if user is involved
        if (!isAssignee && !isAssigner) {
            return res.status(403).json({ message: 'You are not authorized to respond to this assignment.' });
        }

        // Check if action is required by this user
        // If actionRequiredBy is set, only that user can act.
        if (item.actionRequiredBy && item.actionRequiredBy.toString() !== currentUser.toString()) {
            return res.status(403).json({ message: 'It is not your turn to respond.' });
        }

        const actor = isAssignee ? item.assignedTo : item.assignedBy;
        let notifyRecipient = isAssignee ? item.assignedBy : item.assignedTo;

        if (action === 'Reject') {
            // Rejection resets the assignment completely
            if (notifyRecipient) {
                await sendAssetResponseEmail({
                    asset: item,
                    actor,
                    recipient: notifyRecipient,
                    action: 'Reject',
                    comment: comments
                });
            }

            item.status = 'Unassigned';
            item.assignedTo = null;
            item.assignedBy = null;
            item.assignmentType = null;
            item.assignedDays = null;
            item.acceptanceStatus = 'Rejected';
            item.actionRequiredBy = null;
            item.negotiationHistory = [];

        } else if (action === 'Accept') {
            // Final Acceptance
            item.status = 'Assigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;

            if (notifyRecipient) {
                await sendAssetResponseEmail({
                    asset: item,
                    actor,
                    recipient: notifyRecipient,
                    action: 'Accept',
                    comment: comments
                });
            }

            // Notify Reportee (Manager) if different from Assigner
            if (isAssignee && item.assignedTo?.primaryReportee) {
                try {
                    const managerId = item.assignedTo.primaryReportee._id || item.assignedTo.primaryReportee;
                    const assignerId = item.assignedBy?._id;

                    if (managerId.toString() !== assignerId?.toString()) {
                        const manager = await EmployeeBasic.findById(managerId);
                        if (manager) {
                            await sendAssetResponseEmail({
                                asset: item,
                                actor,
                                recipient: manager,
                                action: 'Accept',
                                comment: comments
                            });
                        }
                    }
                } catch (err) {
                    console.error('Error notifying reportee:', err);
                }
            }
        } else if (action === 'AcceptWithComments') {

            let fileUrl = null;
            if (req.body.file) {
                try {
                    const uploadResult = await uploadDocumentToS3(req.body.file, 'asset-negotiation');
                    fileUrl = uploadResult.publicId; // Store Key/PublicId
                } catch (err) {
                    console.error('File upload failed during negotiation:', err);
                }
            }

            // Negotiation Loop
            item.negotiationHistory.push({
                sender: currentUser,
                message: comments,
                action: 'AcceptWithComments',
                file: fileUrl,
                date: new Date()
            });

            // Pass the ball
            item.actionRequiredBy = isAssignee ? item.assignedBy._id : item.assignedTo._id;

            if (notifyRecipient) {
                await sendAssetResponseEmail({
                    asset: item,
                    actor,
                    recipient: notifyRecipient,
                    action: 'AcceptWithComments',
                    comment: comments
                });
            }

            // Log negotiation
            await AssetHistory.create({
                assetId: item._id,
                action: 'Comment',
                assignedTo: item.assignedTo, // Current assignee
                performedBy: req.user.employeeObjectId,
                comments: comments,
                file: fileUrl
            });
        }

        await item.save();

        // Log final actions
        if (action === 'Reject') {
            await AssetHistory.create({
                assetId: item._id,
                action: 'Rejected',
                assignedTo: null, // Since we cleared it, but maybe capture it before? 
                // Wait, item.assignedTo is already cleared above.
                // We should capture 'assignedTo' before clearing if we want to log who it was.
                // But performedBy is captured.
                performedBy: req.user.employeeObjectId,
                comments: comments
            });
            await updateAssetTypeCounts(item.typeId);
        } else if (action === 'Accept') {
            await AssetHistory.create({
                assetId: item._id,
                action: 'Accepted',
                assignedTo: item.assignedTo,
                performedBy: req.user.employeeObjectId,
                comments: comments
            });
        }

        res.status(200).json(item);
    } catch (error) {
        console.error('Error responding to assignment:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Return an asset item (unassign)
// @route   PUT /api/AssetItem/:id/return
// @access  Private
export const returnAssetItem = async (req, res) => {
    try {
        const { id } = req.params;
        const item = await AssetItem.findById(id);

        if (!item) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Store current details for history
        const prevAssignedTo = item.assignedTo;
        const originalAssigner = item.assignedBy;

        const { reassignTo, assignmentType, assignedDays } = req.body;

        if (reassignTo) {
            // Explicit reassignment requested
            const newAssignee = await EmployeeBasic.findById(reassignTo);
            if (!newAssignee) {
                return res.status(404).json({ message: "Target employee for reassignment not found" });
            }

            item.assignedTo = newAssignee._id;
            item.assignedBy = req.user.employeeObjectId;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;

            // Set assignment details if provided
            item.assignmentType = assignmentType || 'Permanent';
            item.assignedDays = assignedDays || null;
            item.negotiationHistory = [];
        } else if (originalAssigner) {
            // Assign back to the original assigner as 'Returned'
            item.assignedTo = originalAssigner;
            item.assignedBy = req.user.employeeObjectId;
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;

            // Reset other fields
            item.assignmentType = null;
            item.assignedDays = null;
            item.negotiationHistory = [];
        } else {
            // Default return - mark as returned
            item.assignedTo = null;
            // We keep assignedBy as record of who originally assigned it? 
            // Or clear it? User said "goes to the assigner status is returned"
            // Let's keep assignedBy but set assignedTo to null.
            item.status = 'Unassigned';
            item.acceptanceStatus = 'Accepted';
            item.actionRequiredBy = null;

            // Reset other fields
            item.assignmentType = null;
            item.assignedDays = null;
            item.negotiationHistory = [];
        }

        await item.save();

        // Log History
        await AssetHistory.create({
            assetId: item._id,
            action: 'Returned',
            assignedTo: prevAssignedTo,
            performedBy: req.user.employeeObjectId || req.user._id // Fallback to user ID if employee link missing
        });

        await updateAssetTypeCounts(item.typeId);

        res.status(200).json(item);

    } catch (error) {
        console.error('Error returning asset item:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get asset history
// @route   GET /api/AssetItem/:id/history
// @access  Private
export const getAssetHistory = async (req, res) => {
    try {
        const { id } = req.params;
        const history = await AssetHistory.find({ assetId: id })
            .populate('performedBy', 'firstName lastName employeeId')
            .populate('assignedTo', 'firstName lastName employeeId')
            .sort({ date: -1 });

        res.status(200).json(history);
    } catch (error) {
        console.error('Error fetching asset history:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add a document to an asset item
// @route   POST /api/AssetItem/:id/document
// @access  Private
export const addAssetDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const { type, issueAuthority, issueDate, expiryDate, description, document } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        let documentUrl = null;
        if (document && document.data) {
            try {
                // Upload to S3 under asset-documents folder
                const uploadResult = await uploadDocumentToS3(document.data, 'asset-documents', document.name);
                documentUrl = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading document to S3:', error);
                return res.status(500).json({ message: 'Failed to upload document' });
            }
        }

        asset.documents.push({
            type,
            issueAuthority: issueAuthority || null,
            issueDate: issueDate || null,
            expiryDate: expiryDate || null,
            description: description || null,
            attachment: documentUrl
        });

        await asset.save();

        // Return signed URL for immediate UI update if needed
        const newDoc = asset.documents[asset.documents.length - 1].toObject();
        if (newDoc.attachment) {
            newDoc.attachment = await getSignedFileUrl(newDoc.attachment);
        }

        res.status(200).json({ message: 'Document added successfully', document: newDoc });
    } catch (error) {
        console.error('Error adding asset document:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Update an existing document on an asset item
// @route   PUT /api/AssetItem/:id/document/:docId
// @access  Private
export const updateAssetDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;
        const { type, issueAuthority, issueDate, expiryDate, description, document } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        // Find the document subdocument by _id
        const doc = asset.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        // Update fields
        if (type) doc.type = type;
        if (issueAuthority !== undefined) doc.issueAuthority = issueAuthority;
        if (issueDate !== undefined) doc.issueDate = issueDate;
        if (expiryDate !== undefined) doc.expiryDate = expiryDate;
        if (description !== undefined) doc.description = description;

        // Upload new file only if provided
        if (document && document.data) {
            try {
                const uploadResult = await uploadDocumentToS3(document.data, 'asset-documents', document.name);
                doc.attachment = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading document to S3:', error);
                return res.status(500).json({ message: 'Failed to upload document' });
            }
        }

        await asset.save();

        const updatedDoc = doc.toObject();
        if (updatedDoc.attachment) {
            updatedDoc.attachment = await getSignedFileUrl(updatedDoc.attachment);
        }

        res.status(200).json({ message: 'Document updated successfully', document: updatedDoc });
    } catch (error) {
        console.error('Error updating asset document:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Delete a document from an asset item
// @route   DELETE /api/AssetItem/:id/document/:docId
// @access  Private
export const deleteAssetDocument = async (req, res) => {
    try {
        const { id, docId } = req.params;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        const doc = asset.documents.id(docId);
        if (!doc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        asset.documents.pull({ _id: docId });
        await asset.save();

        res.status(200).json({ message: 'Document deleted successfully' });
    } catch (error) {
        console.error('Error deleting asset document:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// @desc    Add a service record to an asset item
// @route   POST /api/AssetItem/:id/service
// @access  Private
export const addAssetService = async (req, res) => {
    try {
        const { id } = req.params;
        const { serviceType, date, expiryDate, currentKm, description, paidBy, value, remark, invoice } = req.body;

        const asset = await AssetItem.findById(id);
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }

        let invoiceUrl = null;
        if (invoice && invoice.data) {
            try {
                const uploadResult = await uploadDocumentToS3(invoice.data, 'asset-service-invoices', invoice.name);
                invoiceUrl = uploadResult.publicId;
            } catch (error) {
                console.error('Error uploading invoice to S3:', error);
                return res.status(500).json({ message: 'Failed to upload invoice' });
            }
        }

        // Create the service record
        const newService = {
            serviceType,
            date: date || new Date(),
            expiryDate: expiryDate || null,
            currentKm: currentKm || null,
            description,
            paidBy,
            value: value || 0,
            remark,
            invoice: invoiceUrl
        };

        asset.services.push(newService);

        // Update asset's current kilometer if provided in service record
        if (currentKm && Number(currentKm) > (asset.currentKilometer || 0)) {
            asset.currentKilometer = Number(currentKm);
        }

        // Update specialized dates if it's an Oil Service
        if (serviceType === 'Oil Service') {
            asset.oilChangeDate = date || new Date();
            asset.lastServiceDate = date || new Date();
        } else {
            // General last service date update
            asset.lastServiceDate = date || new Date();
        }

        await asset.save();

        // Return signed URL for the new invoice
        const addedService = asset.services[asset.services.length - 1].toObject();
        if (addedService.invoice) {
            addedService.invoice = await getSignedFileUrl(addedService.invoice);
        }

        res.status(200).json({ message: 'Service record added successfully', service: addedService });
    } catch (error) {
        console.error('Error adding asset service:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Helper: Update counts
const updateAssetTypeCounts = async (typeId) => {
    const total = await AssetItem.countDocuments({ typeId: typeId });
    const assigned = await AssetItem.countDocuments({ typeId: typeId, status: 'Assigned' });
    const pending = await AssetItem.countDocuments({ typeId: typeId, status: 'Pending' });
    const unassigned = total - assigned - pending;

    await AssetType.findByIdAndUpdate(typeId, {
        total,
        assigned,
        unassigned
    });
};

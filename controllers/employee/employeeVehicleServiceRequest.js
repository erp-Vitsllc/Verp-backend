import mongoose from 'mongoose';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import AssetItem from '../../models/AssetItem.js';
import VehicleOilServiceType from '../../models/VehicleOilServiceType.js';
import AssetHistory from '../../models/AssetHistory.js';
import { uploadDocumentToS3 } from '../../utils/s3Upload.js';
import { allocateNextServiceReqNo } from '../../utils/assetServiceReqNo.js';
import {
    appendOilServiceActivity,
    getRequesterName,
    supersedePreviousOilNextDueForNewRequest,
} from '../../utils/oilServiceWorkflow.js';
import { appendTireChangeActivity } from '../../utils/tireChangeWorkflow.js';
import { appendMechanicalWorkActivity } from '../../utils/mechanicalWorkWorkflow.js';
import {
    findExistingCarWashForMonth,
    getLatestOccupiedCarWashMonth,
} from '../../utils/carWashWorkflow.js';
import { notifyAdminOfficerOnVehicleServiceCreated } from '../../utils/vehicleServiceAdminOfficerNotification.js';
import { userIsFlowchartAdminOfficerEmployeeOnly } from '../../utils/assetApprovalHelpers.js';
import {
    FLEET_VEHICLE_ASSET_ID_PREFIX,
    TOOLS_ASSET_ID_PREFIX,
} from '../../utils/fleetVehicleAssetId.js';

const CAR_WASH_TYPES = ['Full Wash', 'Body Wash'];
const MAX_PHOTOS = 8;
const MAX_FILE_CHARS = 8_000_000;

const SELECT_PERSON = '_id employeeId firstName lastName';

const KIND_TO_SERVICE = {
    oil: 'Oil Service',
    tyre: 'Tire Change',
    mechanical: 'Mechanical Work',
    carwash: 'Car Wash',
};

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function nextOpenCarWashMonth(asset) {
    const now = new Date();
    let key = monthKey(now);
    const latest = getLatestOccupiedCarWashMonth(asset);
    if (latest && key <= latest) {
        const [year, month] = latest.split('-').map(Number);
        key = monthKey(new Date(year, month, 1));
    }
    if (findExistingCarWashForMonth(asset, key)) {
        const [year, month] = key.split('-').map(Number);
        key = monthKey(new Date(year, month, 1));
    }
    return key;
}

function isVehicleAsset(item) {
    const plate = String(item?.plateNumber || '').trim();
    const id = String(item?.assetId || '').trim().toUpperCase();
    if (plate) return true;
    if (id.startsWith(FLEET_VEHICLE_ASSET_ID_PREFIX.toUpperCase())) return true;
    if (id.startsWith(TOOLS_ASSET_ID_PREFIX.toUpperCase())) return false;
    return Boolean(
        String(item?.vehicleBrand || '').trim() ||
            String(item?.vehicleCode || '').trim() ||
            String(item?.plateEmirate || '').trim(),
    );
}

async function resolveSelf(req) {
    if (req.user?.employeeObjectId && mongoose.Types.ObjectId.isValid(req.user.employeeObjectId)) {
        const byOid = await EmployeeBasic.findById(req.user.employeeObjectId).select(SELECT_PERSON).lean();
        if (byOid) return byOid;
    }
    if (req.user?.employeeId) {
        return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select(SELECT_PERSON).lean();
    }
    return null;
}

function filePayload(file) {
    if (!file || typeof file !== 'object') return null;
    const data = String(file.data || '').trim();
    if (!data) return null;
    if (data.length > MAX_FILE_CHARS) {
        throw new Error('Each photo must be smaller than 6 MB.');
    }
    return {
        data,
        name: String(file.name || '').trim() || `photo-${Date.now()}.jpg`,
    };
}

async function storeFiles(files, folder) {
    const stored = [];
    for (const file of files) {
        const upload = await uploadDocumentToS3(file.data, folder, file.name);
        stored.push({
            url: upload.publicId,
            name: file.name,
        });
    }
    return stored;
}

/**
 * POST /api/Employee/dashboard/vehicle-service-request
 * Employee mobile request. Creates the same vehicle service row the ERP Service tab uses,
 * then emails and notifies the Admin Officer (oil, tyre, mechanical, and car wash).
 */
export async function createEmployeeVehicleServiceRequest(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const self = await resolveSelf(req);
        if (!self) {
            return res.status(404).json({ message: 'No linked employee profile found for this user.' });
        }

        const kind = String(req.body?.kind || '').trim().toLowerCase();
        const serviceType = KIND_TO_SERVICE[kind];
        if (!serviceType) {
            return res.status(400).json({ message: 'Choose oil service, tyre change, mechanical work, or car wash.' });
        }

        const vehicleId = String(req.body?.vehicleId || '').trim();
        const assigned = await AssetItem.find({
            assignedTo: self._id,
            assignedToType: { $ne: 'Company' },
        });
        const vehicles = assigned.filter(isVehicleAsset);
        let asset = null;
        if (vehicleId) {
            if (!mongoose.Types.ObjectId.isValid(vehicleId)) {
                return res.status(400).json({ message: 'Choose a vehicle.' });
            }
            asset = vehicles.find((row) => String(row._id) === vehicleId) || null;
            if (!asset) {
                return res.status(403).json({ message: 'That vehicle is not assigned to you.' });
            }
        } else if (vehicles.length === 1) {
            asset = vehicles[0];
        } else if (!vehicles.length) {
            return res.status(400).json({ message: 'No vehicle is assigned to you, so a service request cannot be sent.' });
        } else {
            return res.status(400).json({ message: 'Choose which assigned vehicle this request is for.' });
        }

        const currentKm = Number(asset.currentKilometer || 0);
        const descriptionInput = String(req.body?.description || '').trim();
        const remark = {
            serviceSubtype: serviceType,
            amountMode: 'amount',
            requestStatus: 'pending',
            currentKm,
            source: 'mobile_app',
        };
        let description = descriptionInput;
        let photos = [];
        let invoiceUrl = '';
        let invoiceName = '';

        if (kind === 'oil') {
            const oilType = String(req.body?.oilType || '').trim();
            if (!oilType) return res.status(400).json({ message: 'Oil type is required.' });
            if (!description) return res.status(400).json({ message: 'Description is required.' });
            const types = await VehicleOilServiceType.find({ active: true }).select('name').lean();
            const match = types.find((row) => String(row.name || '').toLowerCase() === oilType.toLowerCase());
            if (types.length && !match) {
                return res.status(400).json({ message: 'Choose an oil type from the list.' });
            }
            remark.oilServiceTypeText = match?.name || oilType;
            remark.nextChangeKm = '';
            remark.serviceEndDate = '';
            remark.nextChangeMonth = '';
        } else if (kind === 'tyre') {
            const tyreCount = Math.floor(Number(req.body?.tyreCount));
            if (!Number.isFinite(tyreCount) || tyreCount < 1) {
                return res.status(400).json({ message: 'Enter how many tyres need to be changed.' });
            }
            description = `Tyres to change: ${tyreCount}`;
            remark.tireNumber = tyreCount;
            const incoming = Array.isArray(req.body?.photos) ? req.body.photos : [];
            if (!incoming.length) {
                return res.status(400).json({ message: 'Add a photo of the current tyre.' });
            }
            if (incoming.length > MAX_PHOTOS) {
                return res.status(400).json({ message: `You can add up to ${MAX_PHOTOS} photos.` });
            }
            photos = await storeFiles(incoming.map(filePayload).filter(Boolean), 'asset-service-attachments');
            if (!photos.length) {
                return res.status(400).json({ message: 'Add a photo of the current tyre.' });
            }
        } else if (kind === 'mechanical') {
            if (!description) return res.status(400).json({ message: 'Describe the mechanical work.' });
            const incoming = Array.isArray(req.body?.photos) ? req.body.photos : [];
            if (incoming.length > MAX_PHOTOS) {
                return res.status(400).json({ message: `You can add up to ${MAX_PHOTOS} photos.` });
            }
            const files = incoming.map(filePayload).filter(Boolean);
            if (files.length) {
                photos = await storeFiles(files, 'asset-service-attachments');
            }
        } else {
            const carWashType = String(req.body?.carWashType || '').trim();
            const typeMatch = CAR_WASH_TYPES.find((name) => name.toLowerCase() === carWashType.toLowerCase());
            if (!typeMatch) {
                return res.status(400).json({ message: 'Choose Full Wash or Body Wash.' });
            }
            const washMonth = nextOpenCarWashMonth(asset);
            remark.carWashType = typeMatch;
            remark.carWashMonth = washMonth;
            remark.carWashServiceDate = todayKey();
            remark.carWashPaymentStatus = 'pending';
            description = description || `Car wash request — ${typeMatch}`;
            const invoice = req.body?.invoice ? filePayload(req.body.invoice) : null;
            if (invoice) {
                const upload = await uploadDocumentToS3(invoice.data, 'asset-service-invoices', invoice.name);
                invoiceUrl = upload.publicId;
                invoiceName = invoice.name;
                remark.invoicePublicId = invoiceUrl;
                remark.invoiceName = invoiceName;
                remark.attachmentName = invoiceName;
            }
        }

        if (photos.length) {
            remark.photos = photos;
        }

        const creatorName = await getRequesterName(req.user);
        remark.requestedByName = creatorName;
        remark.createdByName = creatorName;

        const newService = {
            _id: new mongoose.Types.ObjectId(),
            serviceReqNo: await allocateNextServiceReqNo(asset),
            serviceType,
            date: new Date(),
            currentKm,
            description,
            paidBy: 'Company',
            value: 0,
            remark: JSON.stringify(remark),
            invoice: invoiceUrl || null,
            attachment: invoiceUrl || null,
            photos,
            requestedBy: self._id,
        };

        asset.services.push(newService);
        const saved = asset.services[asset.services.length - 1];

        if (kind === 'oil') {
            appendOilServiceActivity(saved, {
                type: 'service_created',
                byName: creatorName,
                note: 'Oil service request created from the mobile app',
            });
            asset.oilChangeDate = new Date();
            asset.lastServiceDate = new Date();
            supersedePreviousOilNextDueForNewRequest(asset, saved._id);
        } else if (kind === 'tyre') {
            appendTireChangeActivity(saved, {
                type: 'service_created',
                byName: creatorName,
                note: 'Tire change request created from the mobile app',
            });
            asset.lastServiceDate = new Date();
        } else if (kind === 'mechanical') {
            appendMechanicalWorkActivity(saved, {
                type: 'service_created',
                byName: creatorName,
                note: 'Mechanical work request created from the mobile app',
            });
            asset.lastServiceDate = new Date();
        } else {
            asset.lastServiceDate = new Date();
        }

        asset.markModified('services');
        await asset.save();

        try {
            const creatorIsAdminOfficer = await userIsFlowchartAdminOfficerEmployeeOnly(req).catch(() => false);
            await notifyAdminOfficerOnVehicleServiceCreated({
                asset,
                serviceRecordId: saved._id,
                serviceType,
                requestedByName: creatorName,
                sendEmail: !creatorIsAdminOfficer,
                notifyAssignee: false,
                event: 'created',
                serviceReqNo: saved.serviceReqNo || '',
            });
        } catch (notifyErr) {
            console.error('[vehicle-service-request] Admin notify failed:', notifyErr);
        }

        try {
            await AssetHistory.create({
                assetId: asset._id,
                action: 'Service',
                performedBy: self._id,
                comments: `Service request from mobile: ${serviceType}. ${description || ''}`,
                details: { type: 'ServiceAdd', serviceType, description, isDraft: true, source: 'mobile_app' },
            });
        } catch (historyErr) {
            console.error('[vehicle-service-request] History log failed:', historyErr);
        }

        const plate = [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
        return res.status(201).json({
            message: `${serviceType} request sent. Admin has been notified.`,
            serviceType,
            serviceReqNo: saved.serviceReqNo || '',
            serviceId: String(saved._id),
            vehicleId: String(asset._id),
            vehicle: plate || asset.assetId || '',
        });
    } catch (error) {
        console.error('[createEmployeeVehicleServiceRequest]', error);
        const message = error instanceof Error ? error.message : 'Could not create this service request.';
        const status = /smaller than|required|Choose|photo|vehicle/i.test(message) ? 400 : 500;
        return res.status(status).json({ message });
    }
}

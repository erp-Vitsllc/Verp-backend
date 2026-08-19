import Fine from "../../models/Fine.js";
import AssetItem from "../../models/AssetItem.js";
import mongoose from "mongoose";
import { isUserAdministrator } from "../../services/permissionService.js";

/** List views don't need attachments, workflow, or approval PDFs. */
const FINE_LIST_SELECT = [
    'fineId',
    'category',
    'subCategory',
    'fineType',
    'assignedEmployees',
    'responsibleFor',
    'employeeAmount',
    'companyAmount',
    'company',
    'companyName',
    'payableDuration',
    'monthStart',
    'originalMonthStart',
    'originalPayableDuration',
    'fineStatus',
    'fineAmount',
    'totalFineAmount',
    'serviceCharge',
    'sourceOfIncome',
    'paidAmount',
    'awardedDate',
    'zohoBillId',
    'vendorBillStatus',
    'zohoVendorPaymentId',
    'zohoOrganizationId',
    'createdAt',
    'updatedAt',
    'createdBy',
    'vehicleId',
    'assetId',
    'assetObjectId',
    'assetName',
    'projectId',
    'projectName',
].join(' ');

function fillCompanyNameFromPopulate(fine) {
    if (!fine) return;
    const populatedName = fine.company?.name;
    if (populatedName && (!fine.companyName || fine.companyName === 'N/A')) {
        fine.companyName = populatedName;
    }
}

function formatVehiclePlate(asset) {
    if (!asset) return '';
    return [asset.plateEmirate, asset.plateNumber].filter(Boolean).join(' ').trim();
}

async function attachVehiclePlateToFines(fines) {
    if (!Array.isArray(fines) || !fines.length) return;

    const objectIds = new Set();
    const assetCodes = new Set();

    for (const fine of fines) {
        for (const rawId of [fine.assetObjectId, fine.vehicleId]) {
            const id = String(rawId || '').trim();
            if (id && mongoose.Types.ObjectId.isValid(id)) {
                objectIds.add(id);
            }
        }
        const assetCode = String(fine.assetId || '').trim();
        if (assetCode) assetCodes.add(assetCode);
    }

    const assets = [];
    if (objectIds.size) {
        assets.push(
            ...(await AssetItem.find({ _id: { $in: [...objectIds] } })
                .select('_id assetId plateEmirate plateNumber')
                .lean()
                .maxTimeMS(8000)),
        );
    }
    if (assetCodes.size) {
        assets.push(
            ...(await AssetItem.find({ assetId: { $in: [...assetCodes] } })
                .select('_id assetId plateEmirate plateNumber')
                .lean()
                .maxTimeMS(8000)),
        );
    }

    const byObjectId = new Map(assets.map((asset) => [String(asset._id), asset]));
    const byAssetCode = new Map(assets.map((asset) => [String(asset.assetId || ''), asset]));

    for (const fine of fines) {
        const linkedAsset =
            byObjectId.get(String(fine.assetObjectId || '')) ||
            byObjectId.get(String(fine.vehicleId || '')) ||
            byAssetCode.get(String(fine.assetId || '')) ||
            null;

        const plateEmirate = linkedAsset?.plateEmirate || '';
        const plateNumber = linkedAsset?.plateNumber || '';
        fine.plateEmirate = plateEmirate;
        fine.plateNumber = plateNumber;
        fine.vehiclePlateNo = formatVehiclePlate(linkedAsset);
        if (linkedAsset?._id) {
            fine.vehicleObjectId = linkedAsset._id;
            if (!fine.assetObjectId) fine.assetObjectId = linkedAsset._id;
        }
    }
}

export const getFines = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 1000,
            search = '',
            status,
            type,
            startDate,
            endDate,
            employeeId,
            vehicleId,
            assetId,
            companyId,
            vehicleLinked,
        } = req.query;

        const query = {};

        const searchConditions = [];
        if (search) {
            searchConditions.push(
                { fineId: { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeName': { $regex: search, $options: 'i' } },
                { 'assignedEmployees.employeeId': { $regex: search, $options: 'i' } }
            );
        }

        // Company profile Fine tab: fines where this company has liability
        const companyConditions = [];
        if (companyId) {
            const companyOid = mongoose.Types.ObjectId.isValid(companyId)
                ? new mongoose.Types.ObjectId(companyId)
                : companyId;

            companyConditions.push(
                {
                    company: companyOid,
                    'assignedEmployees.employeeId': 'VEGA-HR-0000',
                },
                {
                    company: companyOid,
                    responsibleFor: 'Company',
                },
                {
                    company: companyOid,
                    responsibleFor: 'Employee & Company',
                    companyAmount: { $gt: 0 },
                    'assignedEmployees.employeeId': { $ne: 'VEGA-HR-0000' },
                    fineId: { $not: /VEGA-FINE-\d+-[A-Z]$/i },
                }
            );
        }

        if (searchConditions.length > 0 && companyConditions.length > 0) {
            query.$and = [
                { $or: searchConditions },
                { $or: companyConditions }
            ];
        } else if (searchConditions.length > 0) {
            query.$or = searchConditions;
        } else if (companyConditions.length > 0) {
            query.$or = companyConditions;
        }

        if (status) query.fineStatus = status;
        if (type) query.fineType = type;

        if (employeeId) {
            query['assignedEmployees.employeeId'] = employeeId;
        }
        if (vehicleId) query.vehicleId = vehicleId;
        if (assetId) query.assetId = assetId;
        if (String(vehicleLinked || '') === '1' || String(vehicleLinked || '').toLowerCase() === 'true') {
            const vehicleLinkedOr = [
                { vehicleId: { $exists: true, $nin: [null, ''] } },
                { assetId: { $exists: true, $nin: [null, ''] } },
                { assetObjectId: { $exists: true, $ne: null } },
                { fineType: { $in: ['Vehicle Fine', 'Vehicle Damage'] } },
            ];
            query.$and = query.$and || [];
            query.$and.push({ $or: vehicleLinkedOr });
        }

        if (startDate || endDate) {
            query.awardedDate = {};
            if (startDate) query.awardedDate.$gte = new Date(startDate);
            if (endDate) query.awardedDate.$lte = new Date(endDate);
        }

        const isAdmin = await isUserAdministrator(req.user?.id);
        if (!isAdmin && req.user?.id) {
            query.$and = query.$and || [];
            query.$and.push({
                $or: [
                    { fineStatus: { $ne: 'Draft' } },
                    { createdBy: new mongoose.Types.ObjectId(req.user.id) }
                ]
            });
        }

        const pageNum = parseInt(page, 10) || 1;
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 1000);
        const skip = (pageNum - 1) * limitNum;

        const [fines, total] = await Promise.all([
            Fine.find(query)
                .select(FINE_LIST_SELECT)
                .populate('company', 'companyId _id name')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limitNum)
                .lean()
                .maxTimeMS(15000),
            Fine.countDocuments(query).maxTimeMS(15000),
        ]);

        fines.forEach(fillCompanyNameFromPopulate);

        const isVehicleLinked =
            String(vehicleLinked || '') === '1' ||
            String(vehicleLinked || '').toLowerCase() === 'true';
        if (isVehicleLinked) {
            try {
                await attachVehiclePlateToFines(fines);
            } catch (plateErr) {
                console.warn(
                    '[getFines] Vehicle plate backfill skipped:',
                    plateErr?.message || plateErr,
                );
            }
        }

        const missingCompany = fines.filter(
            (fine) =>
                (!fine.companyName || fine.companyName === 'N/A') &&
                fine.assignedEmployees?.[0]?.employeeId &&
                fine.assignedEmployees[0].employeeId !== 'VEGA-HR-0000',
        );
        if (missingCompany.length > 0) {
            try {
                const EmployeeBasic = (await import('../../models/EmployeeBasic.js')).default;
                const empIds = [...new Set(
                    missingCompany.map((fine) => fine.assignedEmployees[0].employeeId).filter(Boolean),
                )];
                const employees = await EmployeeBasic.find({ employeeId: { $in: empIds } })
                    .select('employeeId company')
                    .populate('company', 'name')
                    .lean()
                    .maxTimeMS(8000);
                const companyByEmpId = new Map(
                    employees.map((emp) => [emp.employeeId, emp.company]),
                );
                for (const fine of missingCompany) {
                    const company = companyByEmpId.get(fine.assignedEmployees[0].employeeId);
                    if (company?.name) {
                        fine.companyName = company.name;
                        if (!fine.company) fine.company = company._id;
                    }
                }
            } catch (companyFillErr) {
                console.warn(
                    '[getFines] Company name backfill skipped:',
                    companyFillErr?.message || companyFillErr,
                );
            }
        }

        // Use ZohoBill cache only — live Zoho on every list load made Fine list lag.
        try {
            const { syncFineListVendorBillStatusFromZoho } = await import(
                '../../utils/markFineVendorBillsPaidFromZoho.js'
            );
            await syncFineListVendorBillStatusFromZoho(fines, {
                fetchLive: false,
            });
        } catch (vendorListSyncErr) {
            console.warn(
                '[getFines] Vendor bill Paid/Not Paid sync skipped:',
                vendorListSyncErr?.message || vendorListSyncErr,
            );
        }

        return res.status(200).json({
            fines,
            pagination: {
                total,
                page: pageNum,
                limit: limitNum,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching fines:', error);
        return res.status(500).json({
            message: "Failed to fetch fines",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
};

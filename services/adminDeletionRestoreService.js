import mongoose from 'mongoose';
import Fine from '../models/Fine.js';
import Reward from '../models/Reward.js';
import Loan from '../models/Loan.js';
import Payment from '../models/Payment.js';
import Company from '../models/Company.js';
import AssetItem from '../models/AssetItem.js';
import AssetType from '../models/AssetType.js';
import AssetCategory from '../models/AssetCategory.js';
import AssetAccessoryCatalog from '../models/AssetAccessoryCatalog.js';
import User from '../models/User.js';
import Group from '../models/Group.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import EmployeePassport from '../models/EmployeePassport.js';
import EmployeeVisa from '../models/EmployeeVisa.js';
import EmployeeEmiratesId from '../models/EmployeeEmiratesId.js';
import EmployeeLabourCard from '../models/EmployeeLabourCard.js';
import EmployeeMedicalInsurance from '../models/EmployeeMedicalInsurance.js';
import EmployeeDrivingLicense from '../models/EmployeeDrivingLicense.js';
import EmployeeEducation from '../models/EmployeeEducation.js';
import EmployeeExperience from '../models/EmployeeExperience.js';
import EmployeeTraining from '../models/EmployeeTraining.js';
import EmployeeEmergencyContact from '../models/EmployeeEmergencyContact.js';
import EmployeeSalary from '../models/EmployeeSalary.js';
import EmployeeContact from '../models/EmployeeContact.js';
import EmployeePersonal from '../models/EmployeePersonal.js';
import EmployeeBank from '../models/EmployeeBank.js';

function stripMongoDoc(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const { _id, __v, createdAt, updatedAt, ...rest } = doc;
    return rest;
}

async function restoreMongoByUnique(Model, snapshot, uniqueField) {
    const data = stripMongoDoc(snapshot);
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid snapshot for restore.');
    }
    if (uniqueField && data[uniqueField]) {
        const exists = await Model.findOne({ [uniqueField]: data[uniqueField] }).lean();
        if (exists) {
            throw new Error(`A record with this ${uniqueField} already exists. Cannot restore.`);
        }
    }
    return Model.create(data);
}

const COMPANY_CARD_FIELDS = {
    tradeLicense: [
        'tradeLicenseNumber',
        'tradeLicenseIssueDate',
        'tradeLicenseExpiry',
        'tradeLicenseOwnerName',
        'tradeLicenseAttachment',
    ],
    establishmentCard: [
        'establishmentCardNumber',
        'establishmentCardIssueDate',
        'establishmentCardExpiry',
        'establishmentCardAttachment',
    ],
};

export async function restoreArchivedRecord(archive) {
    const type = archive.restoreDescriptor?.type || archive.entityType;
    const snapshot = archive.snapshot;

    switch (type) {
        case 'fine':
            return restoreMongoByUnique(Fine, snapshot, 'fineId');
        case 'reward':
            return restoreMongoByUnique(Reward, snapshot, 'rewardId');
        case 'loan':
            return restoreMongoByUnique(Loan, snapshot, 'loanId');
        case 'payment':
            return restoreMongoByUnique(Payment, snapshot, 'paymentId');

        case 'company_whole': {
            const data = stripMongoDoc(snapshot);
            if (data.companyId) {
                const exists = await Company.findOne({ companyId: data.companyId }).lean();
                if (exists) throw new Error('Company with this ID already exists.');
            }
            return Company.create(data);
        }

        case 'company_document': {
            const { companyId, document } = snapshot || {};
            if (!companyId || !document) throw new Error('Missing company document snapshot.');
            const company = await Company.findOne({ companyId });
            if (!company) throw new Error('Company not found. Restore the company first if needed.');
            company.documents = company.documents || [];
            company.documents.push(document);
            await company.save();
            return company;
        }

        case 'company_old_document': {
            const { companyId, document } = snapshot || {};
            if (!companyId || !document) throw new Error('Missing company old document snapshot.');
            const company = await Company.findOne({ companyId });
            if (!company) throw new Error('Company not found.');
            company.oldDocuments = company.oldDocuments || [];
            company.oldDocuments.push(document);
            await company.save();
            return company;
        }

        case 'company_owner': {
            const { companyId, owner, ownerTarget } = snapshot || {};
            if (!companyId || !owner) throw new Error('Missing owner snapshot.');
            const company = await Company.findOne({ companyId });
            if (!company) throw new Error('Company not found.');
            const field = ownerTarget === 'owners' ? 'owners' : 'oldOwners';
            company[field] = company[field] || [];
            company[field].push(owner);
            await company.save();
            return company;
        }

        case 'company_card': {
            const { companyId, card, fields } = snapshot || {};
            if (!companyId || !card || !fields) throw new Error('Missing company card snapshot.');
            const company = await Company.findOne({ companyId });
            if (!company) throw new Error('Company not found.');
            const allowed = COMPANY_CARD_FIELDS[card];
            if (!allowed) throw new Error('Unknown company card type.');
            for (const key of allowed) {
                if (fields[key] !== undefined) company[key] = fields[key];
            }
            await company.save();
            return company;
        }

        case 'asset_item':
            return restoreMongoByUnique(AssetItem, snapshot, 'assetId');

        case 'asset_document': {
            const { assetId, document, mongoAssetId } = snapshot || {};
            const filter = mongoAssetId
                ? { _id: mongoAssetId }
                : assetId
                  ? { assetId }
                  : null;
            if (!filter || !document) throw new Error('Missing asset document snapshot.');
            const asset = await AssetItem.findOne(filter);
            if (!asset) throw new Error('Asset not found.');
            asset.documents = asset.documents || [];
            asset.documents.push(document);
            await asset.save();
            return asset;
        }

        case 'asset_service': {
            const { assetId, service, mongoAssetId } = snapshot || {};
            const filter = mongoAssetId
                ? { _id: mongoAssetId }
                : assetId
                  ? { assetId }
                  : null;
            if (!filter || !service) throw new Error('Missing asset service snapshot.');
            const asset = await AssetItem.findOne(filter);
            if (!asset) throw new Error('Asset not found.');
            asset.services = asset.services || [];
            asset.services.push(service);
            await asset.save();
            return asset;
        }

        case 'asset_accessories': {
            const { assetId, removedAccessories, mongoAssetId } = snapshot || {};
            const filter = mongoAssetId
                ? { _id: mongoAssetId }
                : assetId
                  ? { assetId }
                  : null;
            if (!filter || !Array.isArray(removedAccessories) || removedAccessories.length === 0) {
                throw new Error('Missing asset accessories snapshot.');
            }
            const asset = await AssetItem.findOne(filter);
            if (!asset) throw new Error('Asset not found.');
            asset.accessories = asset.accessories || [];
            asset.accessories.push(...removedAccessories);
            await asset.save();
            return asset;
        }

        case 'accessory_catalog': {
            const data = stripMongoDoc(snapshot);
            const catalogId = data.accessoryCatalogId;
            if (!catalogId) throw new Error('Missing accessory catalog ID.');
            const existing = await AssetAccessoryCatalog.findOne({ accessoryCatalogId: catalogId });
            if (existing) {
                Object.assign(existing, { ...data, isActive: true });
                await existing.save();
                return existing;
            }
            return AssetAccessoryCatalog.create({ ...data, isActive: true });
        }

        case 'asset_type':
            return restoreMongoByUnique(AssetType, snapshot, 'name');

        case 'asset_category':
            return restoreMongoByUnique(AssetCategory, snapshot, 'name');

        case 'user': {
            const data = stripMongoDoc(snapshot);
            if (data.username) {
                const exists = await User.findOne({ username: data.username }).lean();
                if (exists) throw new Error('A user with this username already exists.');
            }
            if (data.email) {
                const exists = await User.findOne({ email: data.email }).lean();
                if (exists) throw new Error('A user with this email already exists.');
            }
            return User.create(data);
        }

        case 'group': {
            const data = stripMongoDoc(snapshot);
            if (data.name) {
                const exists = await Group.findOne({ name: data.name }).lean();
                if (exists) throw new Error('A group with this name already exists.');
            }
            const userIds = data.users || [];
            const group = await Group.create({ ...data, users: [] });
            if (userIds.length > 0) {
                await User.updateMany(
                    { _id: { $in: userIds } },
                    { $set: { group: group._id, groupName: group.name } }
                );
                group.users = userIds;
                await group.save();
            }
            return group;
        }

        case 'employee_passport': {
            const { employeeId, passport } = snapshot || {};
            if (!employeeId || !passport) throw new Error('Missing passport snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found. Restore the employee profile first.');
            const existing = await EmployeePassport.findOne({ employeeId }).lean();
            if (existing) throw new Error('Passport record already exists for this employee.');
            return EmployeePassport.create({ ...stripMongoDoc(passport), employeeId });
        }

        case 'employee_visa': {
            const { employeeId, visaType, visa } = snapshot || {};
            if (!employeeId || !visaType || !visa) throw new Error('Missing visa snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            let doc = await EmployeeVisa.findOne({ employeeId });
            if (!doc) doc = await EmployeeVisa.create({ employeeId });
            if (doc[visaType]) throw new Error(`${visaType} visa already exists.`);
            doc[visaType] = visa;
            await doc.save();
            return doc;
        }

        case 'employee_emirates_id': {
            const { employeeId, emiratesId } = snapshot || {};
            if (!employeeId) throw new Error('Missing emirates ID snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const payload = emiratesId || snapshot.emiratesIdDetails;
            const existing = await EmployeeEmiratesId.findOne({ employeeId }).lean();
            if (existing?.emiratesId) throw new Error('Emirates ID already exists.');
            return EmployeeEmiratesId.findOneAndUpdate(
                { employeeId },
                { $set: { emiratesId: payload?.emiratesId || payload } },
                { upsert: true, new: true }
            );
        }

        case 'employee_labour_card': {
            const { employeeId, labourCard } = snapshot || {};
            if (!employeeId) throw new Error('Missing labour card snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const payload = labourCard || snapshot.labourCardDetails;
            const existing = await EmployeeLabourCard.findOne({ employeeId }).lean();
            if (existing?.labourCard) throw new Error('Labour card already exists.');
            return EmployeeLabourCard.findOneAndUpdate(
                { employeeId },
                { $set: { labourCard: payload?.labourCard || payload } },
                { upsert: true, new: true }
            );
        }

        case 'employee_medical_insurance': {
            const { employeeId, medicalInsurance } = snapshot || {};
            if (!employeeId) throw new Error('Missing medical insurance snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const payload = medicalInsurance || snapshot.medicalInsuranceDetails;
            const existing = await EmployeeMedicalInsurance.findOne({ employeeId }).lean();
            if (existing?.medicalInsurance) throw new Error('Medical insurance already exists.');
            return EmployeeMedicalInsurance.findOneAndUpdate(
                { employeeId },
                { $set: { medicalInsurance: payload?.medicalInsurance || payload } },
                { upsert: true, new: true }
            );
        }

        case 'employee_driving_license': {
            const { employeeId, drivingLicense } = snapshot || {};
            if (!employeeId) throw new Error('Missing driving license snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const payload = drivingLicense || snapshot.drivingLicenceDetails;
            const existing = await EmployeeDrivingLicense.findOne({ employeeId }).lean();
            if (existing?.drivingLicenceDetails) throw new Error('Driving license already exists.');
            return EmployeeDrivingLicense.findOneAndUpdate(
                { employeeId },
                { $set: { drivingLicenceDetails: payload?.drivingLicenceDetails || payload } },
                { upsert: true, new: true }
            );
        }

        case 'employee_document': {
            const { employeeId, document } = snapshot || {};
            if (!employeeId || !document) throw new Error('Missing document snapshot.');
            const employee = await EmployeeBasic.findOne({ employeeId });
            if (!employee) throw new Error('Employee not found.');
            employee.documents = employee.documents || [];
            employee.documents.push(document);
            await employee.save();
            return employee;
        }

        case 'employee_old_document': {
            const { employeeId, document } = snapshot || {};
            if (!employeeId || !document) throw new Error('Missing archived document snapshot.');
            const employee = await EmployeeBasic.findOne({ employeeId });
            if (!employee) throw new Error('Employee not found.');
            employee.oldDocuments = employee.oldDocuments || [];
            employee.oldDocuments.push(document);
            await employee.save();
            return employee;
        }

        case 'employee_education': {
            const { employeeId, education } = snapshot || {};
            if (!employeeId) throw new Error('Missing education snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const data = education || snapshot;
            const doc = await EmployeeEducation.findOne({ employeeId });
            if (!doc) return EmployeeEducation.create({ employeeId, ...stripMongoDoc(data) });
            Object.assign(doc, stripMongoDoc(data));
            await doc.save();
            return doc;
        }

        case 'employee_experience': {
            const { employeeId, experience } = snapshot || {};
            if (!employeeId) throw new Error('Missing experience snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const data = experience || snapshot;
            const doc = await EmployeeExperience.findOne({ employeeId });
            if (!doc) return EmployeeExperience.create({ employeeId, ...stripMongoDoc(data) });
            Object.assign(doc, stripMongoDoc(data));
            await doc.save();
            return doc;
        }

        case 'employee_training': {
            const { employeeId, training } = snapshot || {};
            if (!employeeId) throw new Error('Missing training snapshot.');
            const employee = await EmployeeBasic.findOne({ employeeId });
            if (!employee) throw new Error('Employee not found.');
            const entry = training || snapshot.trainingEntry || snapshot;
            employee.trainingDetails = employee.trainingDetails || [];
            employee.trainingDetails.push(entry);
            await employee.save();
            return employee;
        }

        case 'employee_emergency_contact': {
            const { employeeId, emergencyContact } = snapshot || {};
            if (!employeeId) throw new Error('Missing emergency contact snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const data = emergencyContact || snapshot;
            const doc = await EmployeeEmergencyContact.findOne({ employeeId });
            if (!doc) return EmployeeEmergencyContact.create({ employeeId, ...stripMongoDoc(data) });
            Object.assign(doc, stripMongoDoc(data));
            await doc.save();
            return doc;
        }

        case 'employee_signature': {
            const { employeeId, signature } = snapshot || {};
            if (!employeeId || !signature) throw new Error('Missing signature snapshot.');
            const employee = await EmployeeBasic.findOne({ employeeId });
            if (!employee) throw new Error('Employee not found.');
            if (employee.signature?.url) throw new Error('Signature already exists.');
            employee.signature = signature;
            await employee.save();
            return employee;
        }

        case 'employee_work_details': {
            const { employeeId, fields } = snapshot || {};
            if (!employeeId || !fields) throw new Error('Missing work details snapshot.');
            const employee = await EmployeeBasic.findOne({ employeeId });
            if (!employee) throw new Error('Employee not found.');
            for (const [key, value] of Object.entries(fields)) {
                if (value !== undefined) employee[key] = value;
            }
            await employee.save();
            return employee;
        }

        case 'employee_salary_history': {
            const { employeeId, entry } = snapshot || {};
            if (!employeeId || !entry) throw new Error('Missing salary history snapshot.');
            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (!exists) throw new Error('Employee not found.');
            const salary = await EmployeeSalary.findOne({ employeeId });
            if (!salary) throw new Error('Salary record not found for employee.');
            salary.salaryHistory = salary.salaryHistory || [];
            salary.salaryHistory.push(entry);
            await salary.save();
            return salary;
        }

        case 'employee_whole': {
            const collections = snapshot?.collections;
            const flat = snapshot?.complete || snapshot;
            const employeeId = flat?.employeeId || collections?.basic?.employeeId;
            if (!employeeId) throw new Error('Missing employee ID in snapshot.');

            const exists = await EmployeeBasic.findOne({ employeeId }).lean();
            if (exists) throw new Error('Employee already exists. Cannot restore duplicate profile.');

            if (collections) {
                if (collections.basic) await EmployeeBasic.create(stripMongoDoc(collections.basic));
                if (collections.contact) await EmployeeContact.create(stripMongoDoc(collections.contact));
                if (collections.personal) await EmployeePersonal.create(stripMongoDoc(collections.personal));
                if (collections.passport) await EmployeePassport.create(stripMongoDoc(collections.passport));
                if (collections.visa) await EmployeeVisa.create(stripMongoDoc(collections.visa));
                if (collections.emiratesId) await EmployeeEmiratesId.create(stripMongoDoc(collections.emiratesId));
                if (collections.labourCard) await EmployeeLabourCard.create(stripMongoDoc(collections.labourCard));
                if (collections.medicalInsurance) await EmployeeMedicalInsurance.create(stripMongoDoc(collections.medicalInsurance));
                if (collections.drivingLicense) await EmployeeDrivingLicense.create(stripMongoDoc(collections.drivingLicense));
                if (collections.salary) await EmployeeSalary.create(stripMongoDoc(collections.salary));
                if (collections.bank) await EmployeeBank.create(stripMongoDoc(collections.bank));
                if (collections.education) await EmployeeEducation.create(stripMongoDoc(collections.education));
                if (collections.experience) await EmployeeExperience.create(stripMongoDoc(collections.experience));
                if (collections.emergencyContact) await EmployeeEmergencyContact.create(stripMongoDoc(collections.emergencyContact));
                if (collections.training) await EmployeeTraining.create(stripMongoDoc(collections.training));
                return { employeeId };
            }

            const basicFields = [
                'employeeId', 'firstName', 'lastName', 'email', 'workEmail', 'companyEmail', 'personalEmail',
                'department', 'designation', 'status', 'joiningDate', 'company', 'reportingAuthority',
                'primaryReportee', 'secondaryReportee', 'documents', 'oldDocuments', 'trainingDetails',
                'signature', 'profileImage', 'enablePortalAccess',
            ];
            const basicData = {};
            for (const key of basicFields) {
                if (flat[key] !== undefined) basicData[key] = flat[key];
            }
            await EmployeeBasic.create(stripMongoDoc(basicData));
            return { employeeId, partial: true };
        }

        default:
            throw new Error(`Restore is not supported for this record type (${type}).`);
    }
}

import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import Fine from '../models/Fine.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { syncDashboardAction } from './syncDashboard.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { applyPostServiceOperationalState } from './assetOperationalFlags.js';
import { actorMayManageTireChangeRequest, getRequesterName } from './oilServiceWorkflow.js';
import { generateFineIdInternal } from '../controllers/fine/addFine.js';

export const ACCIDENT_REPAIR_STAGE = {
    HR: 'pending_hr',
    ADMIN_OFFICER: 'pending_admin_officer',
    ACCOUNTS: 'pending_accounts',
    ADMIN_RETURN: 'pending_admin_return',
    COMPLETE: 'complete',
    REJECTED: 'rejected',
};

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

export function isAccidentRepairServiceType(serviceType) {
    return String(serviceType || '').trim() === 'Accident Repair';
}

export function isAccidentRepairWorkflow(wf, serviceSub) {
    return isAccidentRepairServiceType(wf?.serviceTypeLabel || serviceSub?.serviceType);
}

export function accidentRepairDetailsPath(vehicleId, serviceRecordId) {
    if (!vehicleId || !serviceRecordId) return null;
    return `/HRM/Asset/Vehicle/details/${vehicleId}/accident-repair/${serviceRecordId}`;
}

export function accidentRepairDashboardMeta(asset, serviceRecordId) {
    const path = accidentRepairDetailsPath(asset?._id, serviceRecordId);
    return JSON.stringify({
        vehicleId: asset?._id ? String(asset._id) : '',
        serviceRecordId: serviceRecordId ? String(serviceRecordId) : '',
        serviceType: 'Accident Repair',
        detailsPath: path || '',
    });
}

function parseRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

/** Persist accident-repair timeline rows on the service remark (draft steps before workflow history). */
export function appendAccidentRepairActivity(service, { type, byName, note = '' }) {
    const remark = parseRemark(service);
    if (!Array.isArray(remark.tireActivityLog)) remark.tireActivityLog = [];
    remark.tireActivityLog.push({
        type,
        byName: byName || '',
        note: note || '',
        at: new Date().toISOString(),
    });
    if (byName && !remark.requestedByName) remark.requestedByName = byName;
    service.remark = JSON.stringify(remark);
}

async function mergeService(asset, serviceId, updates) {
    const { mergeWorkflowServiceRecord } = await import('../controllers/vehicleServiceWorkflowController.js');
    return mergeWorkflowServiceRecord(asset, serviceId, updates);
}

async function sendTireEmail({ recipient, asset, stageLabel, actionLabel, detailLine, linkPath }) {
    if (!recipient) return;
    await sendVehicleServiceWorkflowEmail({
        recipient,
        asset,
        stageLabel,
        actionLabel,
        detailLine,
        linkPath,
    });
}

export async function notifyAccidentRepairStakeholder({
    asset,
    serviceRecordId,
    recipient,
    extra2,
    detailLine,
    requestedByName = 'System',
    actionLabel = 'Accident repair workflow',
    stageLabel = 'Action required',
}) {
    if (!recipient?._id) return;
    const linkPath = accidentRepairDetailsPath(asset._id, serviceRecordId);
    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Service Request',
        status: 'Pending',
        assignedTo: recipient._id,
        subjectEmployee: asset.assignedTo,
        requestedByName,
        extra1: `${asset.assetId} â€” Accident Repair`,
        extra2,
        extra3: accidentRepairDashboardMeta(asset, serviceRecordId),
    });
    await sendTireEmail({
        recipient,
        asset,
        stageLabel,
        actionLabel,
        detailLine,
        linkPath,
    });
}

export async function resolveAccidentRepairAssigneeForStage(stage) {
    const s = String(stage || '').toLowerCase();
    if (s === ACCIDENT_REPAIR_STAGE.HR) return getDepartmentHOD('hr');
    if (s === ACCIDENT_REPAIR_STAGE.ACCOUNTS) return getDepartmentHOD('accounts');
    if (s === ACCIDENT_REPAIR_STAGE.ADMIN_OFFICER || s === ACCIDENT_REPAIR_STAGE.ADMIN_RETURN) {
        return getDepartmentHOD('admincontroller');
    }
    return null;
}

export async function advanceAccidentRepairAfterHrApprove(asset, wf, actorName) {
    const serviceRecordId = wf.serviceRecordId;
    wf.stage = ACCIDENT_REPAIR_STAGE.ADMIN_OFFICER;
    asset.activeServiceWorkflow = wf;
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    const adminOfficer = await getDepartmentHOD('admincontroller');
    await notifyAccidentRepairStakeholder({
        asset,
        serviceRecordId,
        recipient: adminOfficer,
        requestedByName: actorName,
        extra2: 'Update garage and service dates',
        stageLabel: 'Garage details required',
        actionLabel: 'Accident repair — garage update',
        detailLine: `${actorName} submitted accident repair details for HR approval. Please open the Accident Repair page, complete Garage / Service Details, and click Done.`,
    });
}

export async function advanceAccidentRepairAfterAccountsApprove(asset, wf, actorName) {
    const { advanceShopServiceToScheduledAfterAccountsApprove } = await import('./vehicleShopServiceScheduled.js');
    return advanceShopServiceToScheduledAfterAccountsApprove(asset, wf, actorName, {
        serviceTypeLabel: 'Accident Repair',
        linkPath: accidentRepairDetailsPath(asset._id, wf.serviceRecordId),
        dashboardMeta: accidentRepairDashboardMeta(asset, wf.serviceRecordId),
        appendActivity: appendAccidentRepairActivity,
    });
}

async function actorMayEditAccidentRepairQuoteEmployeeRows(reqUser, asset) {
    if (await actorMayManageTireChangeRequest(reqUser, asset)) return true;
    const hrHod = await getDepartmentHOD('hr');
    if (!hrHod?._id || !reqUser) return false;
    const actorEmpId = reqUser.employeeObjectId || reqUser._id || reqUser.id;
    return actorEmpId && String(hrHod._id) === String(actorEmpId);
}

export async function updateAccidentRepairQuoteEmployeeRows(asset, serviceId, employeeRows, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    if (!isAccidentRepairServiceType(service.serviceType)) {
        throw new Error('Not a accident repair service record.');
    }

    const wf = asset.activeServiceWorkflow || {};
    if (!isAccidentRepairWorkflow(wf, service)) {
        throw new Error('No active accident repair workflow for this service.');
    }
    if (String(wf.serviceRecordId) !== String(serviceId)) {
        throw new Error('Service record does not match active workflow.');
    }
    const stage = String(wf.stage || '').toLowerCase();
    if ([ACCIDENT_REPAIR_STAGE.COMPLETE, ACCIDENT_REPAIR_STAGE.REJECTED].includes(stage)) {
        throw new Error('Employee rows cannot be edited after the workflow is finished.');
    }

    const allowed = await actorMayEditAccidentRepairQuoteEmployeeRows(req.user, asset);
    if (!allowed) throw new Error('Access denied.');

    const rows = Array.isArray(employeeRows) ? employeeRows : [];
    const payload = rows.map((row) => ({
        employeeId: String(row.employeeId || '').trim(),
        paidAmount: Math.max(0, Number(row.paidAmount) || 0),
    }));

    if (!payload.length) throw new Error('At least one employee row is required.');
    if (payload.some((row) => !row.employeeId)) {
        throw new Error('Each row must have an employee selected.');
    }

    const remark = parseRemark(service);
    remark.hrReviewEmployeeRows = payload;
    remark.employeeLiabilityRows = payload;
    remark.employeeLiabilityTotal = payload.reduce((sum, row) => sum + row.paidAmount, 0);
    service.remark = JSON.stringify(remark);
    asset.markModified('services');
    await asset.save();

    return asset;
}

export async function submitAccidentRepairGarage(asset, serviceId, serviceUpdates, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const wf = asset.activeServiceWorkflow || {};
    if (!isAccidentRepairWorkflow(wf, service)) throw new Error('Not an accident repair workflow.');
    if (String(wf.serviceRecordId) !== String(serviceId)) {
        throw new Error('Service record does not match active workflow.');
    }
    const stage = String(wf.stage || '').toLowerCase();
    const remarkBefore = parseRemark(service);
    const garageAlreadySubmitted = Boolean(wf.garageSubmittedAt || remarkBefore.garageSubmittedByName);
    const mayUpdateGarage =
        stage === ACCIDENT_REPAIR_STAGE.ADMIN_OFFICER ||
        (stage === ACCIDENT_REPAIR_STAGE.ACCOUNTS && !garageAlreadySubmitted);
    if (!mayUpdateGarage) {
        throw new Error('Garage can only be updated while waiting for Admin Officer.');
    }

    const allowed = await actorMayManageTireChangeRequest(req.user, asset);
    if (!allowed) throw new Error('Access denied.');

    await mergeService(asset, serviceId, serviceUpdates);

    const remark = parseRemark(asset.services.id(serviceId));
    const startRaw = remark.serviceStartDate || remark.scheduledServiceDate;
    const endRaw = remark.serviceEndDate || remark.serviceWindowEndDate;
    if (startRaw) {
        wf.scheduledServiceDate = new Date(startRaw);
    }
    if (endRaw) {
        wf.serviceWindowEndDate = new Date(endRaw);
    }
    const actorName = await getRequesterName(req.user);
    wf.garageSubmittedAt = new Date().toISOString();
    remark.garageSubmittedByName = actorName;
    asset.services.id(serviceId).remark = JSON.stringify(remark);
    appendAccidentRepairActivity(asset.services.id(serviceId), {
        type: 'garage_updated',
        byName: actorName,
        note: 'Garage details submitted',
    });
    wf.stage = ACCIDENT_REPAIR_STAGE.ACCOUNTS;
    wf.accountsPendingSince = new Date();
    wf.accountsReminderAt = new Date(Date.now() + TWO_DAYS_MS);
    asset.activeServiceWorkflow = wf;
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    const accounts = await getDepartmentHOD('accounts');
    await notifyAccidentRepairStakeholder({
        asset,
        serviceRecordId: serviceId,
        recipient: accounts,
        requestedByName: actorName,
        extra2: 'Approve garage and service dates',
        stageLabel: 'Accounts approval required',
        actionLabel: 'Accident repair — garage approval',
        detailLine: `${actorName} updated garage details for accident repair. Please review and approve on the Accident Repair page.`,
    });

    return asset;
}

async function resolveFineWorkflowTarget(_employeeDoc, hrHOD) {
    const hrUser = hrHOD ? await User.findOne({ employeeId: hrHOD.employeeId }).select('_id') : null;
    if (hrUser?._id) {
        return {
            submittedTo: hrUser._id,
            workflow: [
                {
                    role: 'HR',
                    assignedTo: hrUser._id,
                    status: 'Pending',
                    assignedAt: new Date(),
                },
            ],
            fineStatus: 'Pending HR',
        };
    }
    return { fineStatus: 'Pending HR', workflow: [], submittedTo: null };
}

export async function createAccidentRepairEmployeeFines(asset, service, reqUser) {
    const remark = parseRemark(service);
    const paymentByMode = String(remark.paymentByMode || remark.liableOn || 'company').toLowerCase();
    if (paymentByMode === 'company') return [];

    const hrHOD = await getDepartmentHOD('hr');
    const rows = Array.isArray(remark.employeeLiabilityRows) ? remark.employeeLiabilityRows : [];
    const estimated = Number(remark.estimatedCost || service.value || 0);
    const employeePct = Number(remark.employeePayPercent || 0);
    const companyPct = Number(remark.companyPayPercent || 0);

    const fineParties = [];

    if (paymentByMode === 'person' || paymentByMode === 'split') {
        for (const row of rows) {
            const empId = String(row?.employeeId || '').trim();
            const paid = Number(row?.paidAmount || 0);
            if (!empId || !Number.isFinite(paid) || paid <= 0) continue;
            fineParties.push({ employeeId: empId, amount: paid, isCompany: false });
        }
    }

    if (paymentByMode === 'split' && companyPct > 0 && estimated > 0) {
        const companyAmount = Math.round((estimated * companyPct) / 100);
        if (companyAmount > 0) {
            fineParties.push({ employeeId: 'VEGA-HR-0000', amount: companyAmount, isCompany: true });
        }
    }

    if (!fineParties.length) return [];

    const baseFineId = await generateFineIdInternal();
    const created = [];
    const suffix = (i) => (fineParties.length > 1 ? `-${String.fromCharCode(65 + i)}` : '');

    for (let i = 0; i < fineParties.length; i++) {
        const party = fineParties[i];
        const emp = party.isCompany
            ? null
            : await EmployeeBasic.findById(party.employeeId)
                  .populate('primaryReportee', 'firstName lastName employeeId companyEmail workEmail personalEmail email')
                  .populate('company', 'name')
                  .lean();

        const empName = party.isCompany
            ? 'Company'
            : `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() || party.employeeId;

        const wfTarget = party.isCompany
            ? await resolveFineWorkflowTarget(null, hrHOD)
            : await resolveFineWorkflowTarget(emp, hrHOD);

        const finePayload = {
            fineId: `${baseFineId}${suffix(i)}`,
            assignedEmployees: [
                {
                    employeeId: emp?.employeeId || party.employeeId,
                    employeeName: empName,
                    daysWorked: 0,
                    individualAmount: party.amount,
                },
            ],
            fineType: 'Vehicle Fine',
            fineStatus: wfTarget.fineStatus,
            fineAmount: party.amount,
            totalFineAmount: party.amount,
            employeeAmount: party.isCompany ? 0 : party.amount,
            companyAmount: party.isCompany ? party.amount : 0,
            serviceCharge: 0,
            description: `Accident repair service liability — ${asset.assetId || asset.name || 'Vehicle'} (${service._id})`,
            awardedDate: new Date(),
            remarks: remark.serviceIssue || 'Accident repair employee liability',
            category: 'Violation',
            subCategory: 'Vehicle Fine',
            vehicleId: asset.assetId || '',
            assetId: asset._id,
            assetName: asset.name || '',
            company: emp?.company?._id || null,
            companyName: emp?.company?.name || '',
            sourceOfIncome: 'Salary',
            createdBy: reqUser?._id || reqUser?.id,
            submittedTo: wfTarget.submittedTo || undefined,
            workflow: wfTarget.workflow?.length ? wfTarget.workflow : undefined,
        };

        const saved = await new Fine(finePayload).save();
        created.push(saved);
    }

    if (created.length > 0) {
        const first = created[0];
        const pendingStep = first.workflow?.find((w) => w.status === 'Pending');
        if (pendingStep?.assignedTo) {
            await syncDashboardAction({
                requestId: first._id,
                requestType: 'Group Fine Request',
                assignedTo: pendingStep.assignedTo,
                status: 'Pending',
                subjectName: `Group Fine - ${created.length} ${created.length === 1 ? 'party' : 'parties'}`,
                requestedByName: reqUser?.name || 'System',
                extra1: 'Vehicle Fine',
                extra2: `Accident repair liability — AED ${created.reduce((s, f) => s + Number(f.fineAmount || 0), 0)}`,
            });
        }
    }

    remark.accidentRepairFinesCreatedAt = new Date().toISOString();
    service.remark = JSON.stringify(remark);
    asset.markModified('services');

    return created;
}

export async function completeAccidentRepairService(asset, serviceId, serviceUpdates, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const wf = asset.activeServiceWorkflow || {};
    if (!isAccidentRepairWorkflow(wf, service)) throw new Error('Not an accident repair workflow.');
    if (String(wf.serviceRecordId) !== String(serviceId)) {
        throw new Error('Service record does not match active workflow.');
    }
    const stage = String(wf.stage || '').toLowerCase();
    const { SHOP_SERVICE_SCHEDULED_STAGE, isShopServiceLive } = await import('./vehicleShopServiceScheduled.js');
    const mayComplete =
        stage === ACCIDENT_REPAIR_STAGE.ADMIN_RETURN ||
        stage === 'pending_admin' ||
        (stage === SHOP_SERVICE_SCHEDULED_STAGE && isShopServiceLive(asset, service));
    if (!mayComplete) {
        throw new Error('Return details can only be completed at the final admin step.');
    }
    if (stage === 'pending_admin') {
        wf.stage = ACCIDENT_REPAIR_STAGE.ADMIN_RETURN;
    }

    const allowed = await actorMayManageTireChangeRequest(req.user, asset);
    if (!allowed) throw new Error('Access denied.');

    if (serviceUpdates) {
        await mergeService(asset, serviceId, serviceUpdates);
    }

    const remark = parseRemark(asset.services.id(serviceId));
    const actorName = await getRequesterName(req.user);
    remark.vehicleServiceCompleted = 'live';
    remark.vehicleServiceCompletedAt = new Date().toISOString();
    remark.workflowStage = ACCIDENT_REPAIR_STAGE.COMPLETE;
    remark.serviceCompletedByName = actorName;
    asset.services.id(serviceId).remark = JSON.stringify(remark);
    appendAccidentRepairActivity(asset.services.id(serviceId), {
        type: 'service_completed',
        byName: actorName,
        note: 'Accident repair service completed',
    });

    wf.stage = ACCIDENT_REPAIR_STAGE.COMPLETE;
    wf.completedAt = new Date();
    asset.activeServiceWorkflow = wf;
    applyPostServiceOperationalState(asset, { statusBeforeService: wf.previousStatus || null });

    await createAccidentRepairEmployeeFines(asset, asset.services.id(serviceId), req.user);

    asset.markModified('services');
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Service Request',
        status: 'Approved',
        assignedTo: (await getDepartmentHOD('admincontroller'))?._id,
        actionedBy: req.user?.employeeObjectId || req.user?._id,
        comment: 'Accident repair completed',
        subjectEmployee: asset.assignedTo,
        requestedByName: actorName,
        extra1: `${asset.assetId} â€” Accident Repair`,
        extra2: 'Completed',
        extra3: accidentRepairDashboardMeta(asset, serviceId),
    });

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail',
            populate: {
                path: 'primaryReportee',
                select: 'firstName lastName employeeId companyEmail workEmail',
            },
        })
        .lean();
    const assignee = populated?.assignedTo;
    if (assignee) {
        const plate = [populated.plateEmirate, populated.plateNumber].filter(Boolean).join(' ').trim();
        await sendVehicleServiceWorkflowEmail({
            recipient: assignee,
            asset: populated,
            stageLabel: 'Service completed',
            actionLabel: 'Accident repair completed',
            detailLine: `${actorName} marked accident repair as complete for ${populated.assetId || ''}${plate ? ` (${plate})` : ''}. Open the Accident Repair page to review completion details.`,
            linkPath: accidentRepairDetailsPath(asset._id, serviceId),
        });
    }

    return asset;
}

export async function notifyAccidentRepairAccountsHoldToAdmin(asset, wf, holdReason, actorName) {
    const adminOfficer = await getDepartmentHOD('admincontroller');
    const holdUntil = wf.accountsHold?.holdUntilDate;
    await notifyAccidentRepairStakeholder({
        asset,
        serviceRecordId: wf.serviceRecordId,
        recipient: adminOfficer,
        requestedByName: actorName,
        extra2: `Accounts hold: ${holdReason || 'No reason'}`,
        stageLabel: 'Accounts placed request on hold',
        actionLabel: 'Accident repair — accounts hold',
        detailLine: `Accounts placed this accident repair on hold${holdUntil ? ` until ${new Date(holdUntil).toLocaleDateString()}` : ''}. Reason: ${holdReason || 'No reason provided'}. You will receive a reminder every 2 days until Accounts acts.`,
    });

    wf.accountsHold = wf.accountsHold || {};
    wf.accountsHold.remindAt = new Date(Date.now() + TWO_DAYS_MS);
    wf.accountsHold.reminderSentAt = null;
    asset.activeServiceWorkflow = wf;
    asset.markModified('activeServiceWorkflow');
    await asset.save();
}

import AssetItem from '../models/AssetItem.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import Fine from '../models/Fine.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { syncDashboardAction } from './syncDashboard.js';
import { sendVehicleServiceWorkflowEmail } from './sendVehicleServiceWorkflowEmail.js';
import { applyPostServiceOperationalState } from './assetOperationalFlags.js';
import { actorMayManageTireChangeRequest, getRequesterName, actorMayAdminScheduleShopService } from './oilServiceWorkflow.js';
import { generateFineIdInternal } from '../controllers/fine/addFine.js';
import {
    commitWorkflowContext,
    getWorkflowContextForService,
} from './vehicleServiceWorkflowResolve.js';

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

export function isAccidentOtherParty(remarkOrType) {
    const raw =
        typeof remarkOrType === 'string'
            ? remarkOrType
            : remarkOrType?.accidentOwnerType;
    return String(raw || '').trim().toLowerCase() === 'thirdparty';
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
        extra1: `${asset.assetId} — Accident Repair`,
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
    // Oil-style parallel: HR opens Accounts even if Schedule/garage is incomplete.
    const serviceRecordId = wf.serviceRecordId;
    const service = asset.services?.id?.(serviceRecordId);
    const remark = parseRemark(service);

    if (service) {
        remark.hrOnServiceApprovedAt = new Date().toISOString();
        remark.hrOnServiceApprovedByName = actorName || '';
        remark.hrApprovedAt = remark.hrOnServiceApprovedAt;
        service.remark = JSON.stringify(remark);
        appendAccidentRepairActivity(service, {
            type: 'hr_approved',
            byName: actorName,
            note: 'HR approved — Accounts Approve opened (Schedule may still be open)',
        });
        asset.markModified('services');
    }

    const { snapshotActiveServiceWorkflow } = await import('./vehicleServiceWorkflowResolve.js');
    snapshotActiveServiceWorkflow(asset);
    asset.activeServiceWorkflow = {
        ...(typeof wf.toObject === 'function' ? wf.toObject() : wf),
        stage: ACCIDENT_REPAIR_STAGE.ACCOUNTS,
        serviceRecordId: wf.serviceRecordId || serviceRecordId,
        serviceTypeLabel: wf.serviceTypeLabel || 'Accident Repair',
        history: Array.isArray(wf.history) ? [...wf.history] : [],
        garageSubmittedAt: wf.garageSubmittedAt,
        scheduledServiceDate: wf.scheduledServiceDate || null,
        serviceWindowEndDate: wf.serviceWindowEndDate || null,
    };
    asset.markModified('activeServiceWorkflow');
    await asset.save();

    const { routeShopServiceToAccountsApproveAfterGarage } = await import(
        './vehicleShopServiceScheduled.js'
    );
    return routeShopServiceToAccountsApproveAfterGarage(asset, serviceRecordId, {
        serviceTypeLabel: 'Accident Repair',
        actorName,
        linkPath: accidentRepairDetailsPath(asset._id, serviceRecordId),
        dashboardMeta: accidentRepairDashboardMeta(asset, serviceRecordId),
        appendActivity: null,
        openedBy: 'hr',
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

    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || !isAccidentRepairWorkflow(wf, service)) {
        throw new Error('No active accident repair workflow for this service.');
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

async function advanceAccidentRepairOtherPartyAfterSchedule(asset, serviceId, actorName) {
    const service = asset.services?.id?.(serviceId);
    const remark = parseRemark(service);
    remark.hrApprovalNotRequired = true;
    remark.accountsApprovalNotRequired = true;
    if (service) {
        service.remark = JSON.stringify(remark);
        asset.markModified('services');
        await asset.save();
    }

    const hr = await getDepartmentHOD('hr');
    if (hr?._id) {
        await syncDashboardAction({
            requestId: asset._id,
            requestType: 'Vehicle Service Request',
            status: 'Approved',
            assignedTo: hr._id,
            actionedBy: null,
            comment: 'Other party damage — HR approval not required',
            subjectEmployee: asset.assignedTo,
            requestedByName: actorName || '',
            extra1: `${asset.assetId || ''} — Accident Repair`,
            extra2: 'HR approval not required',
            extra3: accidentRepairDashboardMeta(asset, serviceId),
        });
    }

    const { advanceShopServiceToScheduledAfterAccountsApprove } = await import(
        './vehicleShopServiceScheduled.js'
    );
    const { wf } = getWorkflowContextForService(asset, serviceId);
    if (!wf) return asset;
    return advanceShopServiceToScheduledAfterAccountsApprove(asset, wf, actorName, {
        serviceTypeLabel: 'Accident Repair',
        linkPath: accidentRepairDetailsPath(asset._id, serviceId),
        dashboardMeta: accidentRepairDashboardMeta(asset, serviceId),
        appendActivity: appendAccidentRepairActivity,
        skipAccountsStamp: true,
        scheduleActivityType: 'schedule_submitted',
        scheduleActivityNote:
            'Other party damage — Ready / On Service after Schedule (HR and Accounts approval not required)',
    });
}

export async function submitAccidentRepairGarage(asset, serviceId, serviceUpdates, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || !isAccidentRepairWorkflow(wf, service)) throw new Error('Not an accident repair workflow.');
    const stage = String(wf.stage || '').toLowerCase();
    const remarkBefore = parseRemark(service);
    const garageAlreadySubmitted = Boolean(wf.garageSubmittedAt || remarkBefore.garageSubmittedByName);
    // Admin may schedule / reschedule anytime after initiate unlock until Complete Service.
    const remarkLive = String(remarkBefore.vehicleServiceCompleted || '').toLowerCase() === 'live';
    const blocked =
        !stage ||
        stage === 'pending' ||
        stage === 'draft' ||
        stage === ACCIDENT_REPAIR_STAGE.COMPLETE ||
        stage === ACCIDENT_REPAIR_STAGE.REJECTED ||
        stage === 'pending_billing' ||
        stage === 'billed' ||
        remarkLive;
    if (blocked) {
        throw new Error('Garage can only be updated while Schedule is open (before Complete Service).');
    }

    const allowed = await actorMayAdminScheduleShopService(req.user);
    if (!allowed) throw new Error('Only Admin / Admin Officer (or Asset Controller) can update Schedule / Reschedule.');

    await mergeService(asset, serviceId, serviceUpdates);

    const remark = parseRemark(asset.services.id(serviceId));
    const startRaw = remark.serviceStartDate || remark.scheduledServiceDate;
    const endRaw = remark.serviceEndDate || remark.serviceWindowEndDate;
    const { assertServiceScheduleDates } = await import('./vehicleServiceScheduleDates.js');
    assertServiceScheduleDates(startRaw, endRaw);
    if (startRaw) {
        wf.scheduledServiceDate = new Date(startRaw);
    }
    if (endRaw) {
        wf.serviceWindowEndDate = new Date(endRaw);
    }
    if (!startRaw || !endRaw) {
        throw new Error('Service start and end dates are required before submitting garage details.');
    }
    const actorName = await getRequesterName(req.user);
    wf.garageSubmittedAt = new Date().toISOString();
    remark.garageSubmittedByName = actorName;
    const { applyScheduleSubmitStatus } = await import('./vehicleServiceScheduleSubmitStatus.js');
    const submitMeta = applyScheduleSubmitStatus(remark, {
        alreadySubmitted: garageAlreadySubmitted,
        actorName,
    });
    asset.services.id(serviceId).remark = JSON.stringify(remark);
    appendAccidentRepairActivity(asset.services.id(serviceId), {
        type: submitMeta.isResubmit ? 'schedule_resubmitted' : 'schedule_submitted',
        byName: actorName,
        note: submitMeta.isResubmit
            ? `Schedule resubmitted · Service window: ${String(startRaw).slice(0, 10)} – ${String(endRaw).slice(0, 10)}`
            : `Schedule submitted · Service start: ${
                  startRaw ? String(startRaw).slice(0, 10) : '—'
              }`,
    });

    // Formal scheduled letter when Admin completes / reschedules Schedule card (not Accounts).
    asset.markModified('services');
    await asset.save();
    {
        const { sendFormalVehicleServiceScheduledAfterAdminSchedule } = await import(
            './vehicleShopServiceScheduled.js'
        );
        await sendFormalVehicleServiceScheduledAfterAdminSchedule({
            asset,
            serviceRecordId: serviceId,
            serviceTypeLabel: 'Accident Repair',
        });
    }

    // Reschedule after first Done: update dates; advance to Ready/On Service if Accounts already done.
    if (garageAlreadySubmitted) {
        const { snapshotActiveServiceWorkflow } = await import('./vehicleServiceWorkflowResolve.js');
        if (!bindActive) {
            snapshotActiveServiceWorkflow(asset);
        }
        asset.activeServiceWorkflow = {
            ...(typeof wf.toObject === 'function' ? wf.toObject() : wf),
            stage,
            serviceRecordId: wf.serviceRecordId || serviceId,
            serviceTypeLabel: wf.serviceTypeLabel || 'Accident Repair',
            history: Array.isArray(wf.history) ? [...wf.history] : [],
            garageSubmittedAt: wf.garageSubmittedAt,
            scheduledServiceDate: wf.scheduledServiceDate || null,
            serviceWindowEndDate: wf.serviceWindowEndDate || null,
        };
        asset.markModified('activeServiceWorkflow');
        asset.markModified('services');
        await asset.save();

        if (isAccidentOtherParty(remark)) {
            await advanceAccidentRepairOtherPartyAfterSchedule(asset, serviceId, actorName);
            return asset;
        }

        if (String(remark.accountsApprovedAt || '').trim()) {
            const { maybeAdvanceShopToScheduledAfterGarageIfAccountsDone } = await import(
                './vehicleShopServiceScheduled.js'
            );
            await maybeAdvanceShopToScheduledAfterGarageIfAccountsDone(asset, serviceId, {
                serviceTypeLabel: 'Accident Repair',
                actorName,
                linkPath: accidentRepairDetailsPath(asset._id, serviceId),
                dashboardMeta: accidentRepairDashboardMeta(asset, serviceId),
                appendActivity: appendAccidentRepairActivity,
            });
        }
        return asset;
    }

    if (isAccidentOtherParty(remark)) {
        const { snapshotActiveServiceWorkflow } = await import('./vehicleServiceWorkflowResolve.js');
        if (!bindActive) {
            snapshotActiveServiceWorkflow(asset);
        }
        asset.activeServiceWorkflow = {
            ...(typeof wf.toObject === 'function' ? wf.toObject() : wf),
            stage,
            serviceRecordId: wf.serviceRecordId || serviceId,
            serviceTypeLabel: wf.serviceTypeLabel || 'Accident Repair',
            history: Array.isArray(wf.history) ? [...wf.history] : [],
            garageSubmittedAt: wf.garageSubmittedAt,
            scheduledServiceDate: wf.scheduledServiceDate || null,
            serviceWindowEndDate: wf.serviceWindowEndDate || null,
        };
        asset.markModified('activeServiceWorkflow');
        asset.markModified('services');
        await asset.save();
        await advanceAccidentRepairOtherPartyAfterSchedule(asset, serviceId, actorName);
        return asset;
    }

    // During pending_hr: save garage only — do not skip HR by advancing to Accounts.
    if (stage === ACCIDENT_REPAIR_STAGE.HR) {
        const { snapshotActiveServiceWorkflow } = await import('./vehicleServiceWorkflowResolve.js');
        if (!bindActive) {
            snapshotActiveServiceWorkflow(asset);
        }
        asset.activeServiceWorkflow = {
            ...(typeof wf.toObject === 'function' ? wf.toObject() : wf),
            stage: ACCIDENT_REPAIR_STAGE.HR,
            serviceRecordId: wf.serviceRecordId || serviceId,
            serviceTypeLabel: wf.serviceTypeLabel || 'Accident Repair',
            history: Array.isArray(wf.history) ? [...wf.history] : [],
            garageSubmittedAt: wf.garageSubmittedAt,
            scheduledServiceDate: wf.scheduledServiceDate || null,
            serviceWindowEndDate: wf.serviceWindowEndDate || null,
        };
        asset.markModified('activeServiceWorkflow');
        asset.markModified('services');
        await asset.save();
        return asset;
    }

    const {
        routeShopServiceToAccountsApproveAfterGarage,
        maybeAdvanceShopToScheduledAfterGarageIfAccountsDone,
    } = await import('./vehicleShopServiceScheduled.js');

    const accountsAlreadyDone = Boolean(String(remark.accountsApprovedAt || '').trim());
    if (accountsAlreadyDone || stage === ACCIDENT_REPAIR_STAGE.ACCOUNTS) {
        const { snapshotActiveServiceWorkflow } = await import('./vehicleServiceWorkflowResolve.js');
        if (!bindActive) {
            snapshotActiveServiceWorkflow(asset);
        }
        asset.activeServiceWorkflow = {
            ...(typeof wf.toObject === 'function' ? wf.toObject() : wf),
            stage: accountsAlreadyDone ? stage : ACCIDENT_REPAIR_STAGE.ACCOUNTS,
            serviceRecordId: wf.serviceRecordId || serviceId,
            serviceTypeLabel: wf.serviceTypeLabel || 'Accident Repair',
            history: Array.isArray(wf.history) ? [...wf.history] : [],
            garageSubmittedAt: wf.garageSubmittedAt,
            scheduledServiceDate: wf.scheduledServiceDate || null,
            serviceWindowEndDate: wf.serviceWindowEndDate || null,
        };
        asset.markModified('activeServiceWorkflow');
        asset.markModified('services');
        await asset.save();

        if (accountsAlreadyDone) {
            await maybeAdvanceShopToScheduledAfterGarageIfAccountsDone(asset, serviceId, {
                serviceTypeLabel: 'Accident Repair',
                actorName,
                linkPath: accidentRepairDetailsPath(asset._id, serviceId),
                dashboardMeta: accidentRepairDashboardMeta(asset, serviceId),
                appendActivity: appendAccidentRepairActivity,
            });
        } else {
            const accounts = await getDepartmentHOD('accounts');
            if (accounts?._id) {
                await notifyAccidentRepairStakeholder({
                    asset,
                    serviceRecordId: serviceId,
                    recipient: accounts,
                    requestedByName: actorName,
                    extra2: 'Awaiting Accounts Approve',
                    stageLabel: 'Accounts Approve',
                    actionLabel: 'Accident repair — Schedule updated',
                    detailLine: `${actorName} completed Schedule/garage for accident repair. Review and approve so Ready / On Service can start.`,
                });
            }
        }
        return asset;
    }

    const { snapshotActiveServiceWorkflow } = await import('./vehicleServiceWorkflowResolve.js');
    if (!bindActive) {
        snapshotActiveServiceWorkflow(asset);
    }
    asset.activeServiceWorkflow = {
        ...(typeof wf.toObject === 'function' ? wf.toObject() : wf),
        stage: ACCIDENT_REPAIR_STAGE.ACCOUNTS,
        serviceRecordId: wf.serviceRecordId || serviceId,
        serviceTypeLabel: wf.serviceTypeLabel || 'Accident Repair',
        history: Array.isArray(wf.history) ? [...wf.history] : [],
        garageSubmittedAt: wf.garageSubmittedAt,
        scheduledServiceDate: wf.scheduledServiceDate || null,
        serviceWindowEndDate: wf.serviceWindowEndDate || null,
    };
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    await routeShopServiceToAccountsApproveAfterGarage(asset, serviceId, {
        serviceTypeLabel: 'Accident Repair',
        actorName,
        linkPath: accidentRepairDetailsPath(asset._id, serviceId),
        dashboardMeta: accidentRepairDashboardMeta(asset, serviceId),
        appendActivity: null,
        openedBy: 'garage',
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

async function completeAccidentRepairWithoutZohoBilling(asset, serviceId, { actorName, wf, bindActive }) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const remark = parseRemark(service);
    remark.vehicleServiceCompleted = 'live';
    remark.vehicleServiceCompletedAt = new Date().toISOString();
    remark.serviceWorkStatus = 'complete';
    remark.workflowStage = ACCIDENT_REPAIR_STAGE.COMPLETE;
    remark.billingStatus = 'not_required';
    remark.serviceCompletedByName = actorName || remark.serviceCompletedByName || '';
    service.remark = JSON.stringify(remark);
    appendAccidentRepairActivity(service, {
        type: 'service_completed',
        byName: actorName,
        note: 'Accident repair complete — other party damage (no Zoho bill)',
    });

    wf.stage = ACCIDENT_REPAIR_STAGE.COMPLETE;
    wf.serviceWorkCompleted = true;
    asset.activeServiceWorkflow = wf;
    if (bindActive) {
        applyPostServiceOperationalState(asset, { statusBeforeService: wf.previousStatus || null });
        asset.onServiceActive = false;
    }
    asset.markModified('activeServiceWorkflow');
    asset.markModified('services');
    await asset.save();

    const populated = await AssetItem.findById(asset._id)
        .populate({
            path: 'assignedTo',
            select: 'firstName lastName employeeId companyEmail workEmail personalEmail email company',
            populate: { path: 'company', select: 'name' },
        })
        .lean();

    const { sendVehicleServiceCompletedNotificationEmail } = await import(
        './sendVehicleServiceCompletedNotificationEmail.js'
    );
    await sendVehicleServiceCompletedNotificationEmail({
        asset: populated || asset,
        remark,
        service,
    }).catch((err) => {
        console.error('[AccidentRepair] completed email failed:', err?.message || err);
    });

    try {
        const { closeAdminOfficerServiceTrackNotification } = await import(
            './vehicleServiceAdminOfficerNotification.js'
        );
        await closeAdminOfficerServiceTrackNotification({
            assetId: asset._id,
            serviceRecordId: serviceId,
            comment: 'Accident repair complete — other party (no Zoho bill)',
            requestedByName: actorName || '',
        });
    } catch (closeErr) {
        console.error(
            '[AccidentRepair] Close Admin Officer on complete failed:',
            closeErr?.message || closeErr,
        );
    }

    return asset;
}

async function notifyHrAccidentAssignmentPhotoReview({
    asset,
    serviceId,
    historyId,
    actorName,
    photoCount = 0,
}) {
    const hr = await getDepartmentHOD('hr');
    if (!hr?._id || !historyId) return;

    const populated = await AssetItem.findById(asset._id)
        .populate('assignedTo', 'firstName lastName employeeId companyEmail workEmail')
        .lean();
    const assigned = populated?.assignedTo;
    const assignedName = assigned
        ? `${assigned.firstName || ''} ${assigned.lastName || ''}`.trim() || assigned.employeeId || 'Assigned user'
        : 'Unassigned';
    const assignedId = assigned?.employeeId ? ` (${assigned.employeeId})` : '';
    const plate = [populated?.plateEmirate, populated?.plateNumber].filter(Boolean).join(' ').trim();
    const vehicleLabel = `${populated?.assetId || asset.assetId || ''}${plate ? ` (${plate})` : ''}`.trim();
    const assignPath = `/HRM/Asset/Vehicle/details/${asset._id}/assign/${historyId}`;
    const detailLine = `Current vehicle assignment photos changed after Accident Repair complete. Vehicle: ${vehicleLabel}. Assigned user: ${assignedName}${assignedId}. Please review and Approve to replace images or Reject to keep the previous photos.`;

    const photoNote =
        photoCount > 0 ? ` ${photoCount} assignment photo(s) pending review.` : '';
    const reviewDetail = `${detailLine}${photoNote}`;

    await syncDashboardAction({
        requestId: asset._id,
        requestType: 'Vehicle Assignment Photo Review',
        status: 'Pending',
        assignedTo: hr._id,
        subjectEmployee: assigned || null,
        requestedByName: actorName || '',
        extra1: `${vehicleLabel} — Assignment photo review`,
        extra2: 'Accident repair — photos changed, please review',
        extra3: JSON.stringify({
            vehicleId: String(asset._id),
            vehicleMongoId: String(asset._id),
            historyId: String(historyId),
            serviceRecordId: String(serviceId || ''),
            photoReview: true,
            isFleetVehicle: true,
            detailsPath: assignPath,
        }),
        comment: reviewDetail,
    });

    await sendTireEmail({
        recipient: hr,
        asset: populated || asset,
        stageLabel: 'Assignment photo review',
        actionLabel: 'Vehicle assignment photos changed — please review',
        detailLine: reviewDetail,
        linkPath: assignPath,
    });
}

export async function completeAccidentRepairService(asset, serviceId, serviceUpdates, req) {
    const service = asset.services?.id?.(serviceId);
    if (!service) throw new Error('Service record not found');
    const { wf, bindActive } = getWorkflowContextForService(asset, serviceId);
    if (!wf || !isAccidentRepairWorkflow(wf, service)) throw new Error('Not an accident repair workflow.');
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

    const completedService = asset.services.id(serviceId);
    const remarkForDates = parseRemark(completedService);
    const returnKey = String(remarkForDates.returnDate || '').trim().slice(0, 10);
    const handOverKey = String(remarkForDates.handOverDate || '').trim().slice(0, 10);
    if (!returnKey || !handOverKey) {
        throw new Error('Return date and hand over date are required before completing the service.');
    }
    const serviceEndRaw =
        remarkForDates.serviceEndDate ||
        remarkForDates.serviceWindowEndDate ||
        wf.serviceWindowEndDate ||
        '';
    const endKey = (() => {
        const raw = String(serviceEndRaw || '').trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
        const d = raw ? new Date(raw) : null;
        if (!d || Number.isNaN(d.getTime())) return '';
        return d.toISOString().slice(0, 10);
    })();
    if (endKey && returnKey < endKey) {
        throw new Error('Return date must be on or after the service end date.');
    }
    if (endKey && handOverKey < endKey) {
        throw new Error('Hand over date must be on or after the service end date.');
    }

    const {
        resolveMappedNewConditionImages,
        queuePendingServicePhotoReview,
    } = await import('./applyServiceBodyConditionReplacements.js');
    const mappedImages = resolveMappedNewConditionImages({
        requestImages: serviceUpdates?.newConditionImages,
        service: completedService,
    });
    let photoReview = null;
    if (mappedImages.length) {
        photoReview = await queuePendingServicePhotoReview(asset, {
            images: mappedImages,
            serviceTypeLabel: 'Accident Repair',
            serviceId,
        });
    }

    const remark = parseRemark(completedService);
    const actorName = await getRequesterName(req.user);
    const otherParty = isAccidentOtherParty(remark);

    if (otherParty) {
        await completeAccidentRepairWithoutZohoBilling(asset, serviceId, {
            actorName,
            wf,
            bindActive,
        });
    } else {
        const { routeShopServiceToBillingAfterComplete } = await import('./vehicleShopServiceScheduled.js');
        await routeShopServiceToBillingAfterComplete(asset, serviceId, {
            serviceTypeLabel: 'Accident Repair',
            actorName,
            linkPath: `/HRM/Asset/Vehicle/details/${asset._id}/accident-repair/${serviceId}`,
            dashboardMeta: accidentRepairDashboardMeta(asset, serviceId),
            appendActivity: appendAccidentRepairActivity,
        });
    }

    if (photoReview?.historyId) {
        await notifyHrAccidentAssignmentPhotoReview({
            asset,
            serviceId,
            historyId: photoReview.historyId,
            actorName,
            photoCount: photoReview.queued || 0,
        });
    }

    // Vehicle Damage fines are created after Zoho bill success (Make Payment), not on Complete.
    // Other-party damage skips Zoho — no bill, no post-bill fines.

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

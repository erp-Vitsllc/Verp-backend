/**
 * After garage Zoho bill(s) succeed (Tire / Mechanical / Body / Accident),
 * create Vehicle Damage fine(s) from each bill's billingPayables.
 *
 * - 1 payable party → individual fine
 * - 2+ payable parties → group fine (shared base id with -A/-B…)
 * - Accident multi-bill → one fine (group or individual) per successful Zoho bill
 * - Defaults: payableDuration = 1, monthStart = current YYYY-MM
 * - Workflow: HR/Accounts/Management auto-approved (tracker fully checked)
 * - Company party → fineStatus Paid (settled with Zoho bill)
 * - Employee party → fineStatus Approved, paidAmount 0 (still owes on profile)
 */

import EmployeeBasic from '../models/EmployeeBasic.js';
import User from '../models/User.js';
import Fine from '../models/Fine.js';
import Company from '../models/Company.js';
import { getDepartmentHOD } from './getDepartmentHOD.js';
import { generateFineIdInternal } from '../controllers/fine/addFine.js';
import { dispatchFineApprovedNotification } from './dispatchFineApprovedNotification.js';
import { isCompanyFineParty } from './fineGroupClassification.js';

const COMPANY_PARTY_ID = 'VEGA-HR-0000';
const SUPPORTED_LABELS = new Set([
    'Tire Change',
    'Mechanical Work',
    'Body Work',
    'Accident Repair',
]);

function parseRemark(service) {
    try {
        return service?.remark ? JSON.parse(service.remark) : {};
    } catch {
        return {};
    }
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function currentMonthStart() {
    return new Date().toISOString().slice(0, 7);
}

function currentMonthLabel(monthStart = currentMonthStart()) {
    const [y, m] = String(monthStart || '').split('-').map((x) => Number(x));
    if (!y || !m) return monthStart || '';
    try {
        return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', {
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
        });
    } catch {
        return monthStart;
    }
}

function partySuffix(index, count) {
    return count > 1 ? `-${String.fromCharCode(65 + index)}` : '';
}

async function resolveAutoApprovedWorkflow(hrHOD) {
    const now = new Date();
    const hrUser = hrHOD
        ? await User.findOne({ employeeId: hrHOD.employeeId }).select('_id').lean()
        : null;
    const accountsHOD = await getDepartmentHOD('accounts').catch(() => null);
    const accountsUser = accountsHOD
        ? await User.findOne({ employeeId: accountsHOD.employeeId }).select('_id').lean()
        : null;

    const step = (role, assignedTo, comment) => ({
        role,
        assignedTo: assignedTo || undefined,
        status: 'Approved',
        assignedAt: now,
        actionedAt: now,
        comment,
    });

    return {
        submittedTo: hrUser?._id || null,
        workflow: [
            step('HR', hrUser?._id, 'Auto-approved after Zoho bill billed'),
            step('Accounts', accountsUser?._id, 'Auto-approved after Zoho bill billed'),
            step('Management', hrUser?._id || accountsUser?._id, 'Auto-approved after Zoho bill billed'),
        ],
    };
}

function isCompanyPayableLine(row) {
    const partyType = String(row?.partyType || '').trim().toLowerCase();
    if (partyType === 'company') return true;
    if (partyType === 'employee') return false;
    if (String(row?.employeeId || '').trim() === COMPANY_PARTY_ID) return true;
    if (!String(row?.employeeId || '').trim() && partyType !== 'employee') return true;
    return false;
}

/**
 * Map billingPayables → fine parties (amount > 0).
 */
export function resolveFinePartiesFromBillingPayables(lines = []) {
    const parties = [];
    for (const row of Array.isArray(lines) ? lines : []) {
        const amount = money(row?.amount);
        if (!(amount > 0)) continue;
        const company = isCompanyPayableLine(row);
        const employeeId = company
            ? COMPANY_PARTY_ID
            : String(row?.employeeId || '').trim();
        const partyName = String(row?.partyName || row?.description || '').trim();
        if (!company && !employeeId && !partyName) continue;
        parties.push({
            employeeId: employeeId || (company ? COMPANY_PARTY_ID : ''),
            partyName: partyName || (company ? 'Company' : 'Employee'),
            amount,
            isCompany: company,
        });
    }
    return parties;
}

/**
 * Bill units that need Vehicle Damage fines after Zoho success.
 * Accident: one unit per zohoBills[] row with zohoBillId.
 * Others: single unit from top-level / first bill.
 */
export function resolveZohoBillFineUnits(remark = {}, serviceTypeLabel = '') {
    const label = String(serviceTypeLabel || '').trim();
    const multi = Array.isArray(remark.zohoBills) ? remark.zohoBills.filter(Boolean) : [];
    const already = Array.isArray(remark.zohoBillVehicleDamageFines)
        ? remark.zohoBillVehicleDamageFines
        : [];
    const alreadyIds = new Set(
        already.map((row) => String(row?.zohoBillId || '').trim()).filter(Boolean),
    );

    if (label === 'Accident Repair' && multi.length) {
        return multi
            .map((bill, index) => {
                const zohoBillId = String(bill?.zohoBillId || '').trim();
                if (!zohoBillId || alreadyIds.has(zohoBillId)) return null;
                return {
                    key: String(bill?.id || bill?.costKey || `bill-${index + 1}`),
                    zohoBillId,
                    zohoBillNumber: String(bill?.zohoBillNumber || '').trim(),
                    costLabel: String(bill?.costLabel || '').trim(),
                    garageName: String(bill?.garageName || bill?.vendorName || remark.garageName || '').trim(),
                    billingPayables: Array.isArray(bill?.billingPayables)
                        ? bill.billingPayables
                        : [],
                };
            })
            .filter(Boolean);
    }

    const singleId =
        String(remark.zohoBillId || '').trim() ||
        String(multi[0]?.zohoBillId || '').trim();
    if (!singleId || alreadyIds.has(singleId)) return [];

    const payables =
        (Array.isArray(remark.billingPayables) && remark.billingPayables.length
            ? remark.billingPayables
            : null) ||
        (Array.isArray(multi[0]?.billingPayables) ? multi[0].billingPayables : []) ||
        [];

    return [
        {
            key: 'primary',
            zohoBillId: singleId,
            zohoBillNumber: String(
                remark.zohoBillNumber || multi[0]?.zohoBillNumber || '',
            ).trim(),
            costLabel: '',
            garageName: String(
                remark.garageName || remark.vendorName || multi[0]?.garageName || '',
            ).trim(),
            billingPayables: payables,
        },
    ];
}

async function createFineGroupForBillUnit({
    asset,
    service,
    remark,
    unit,
    serviceTypeLabel,
    reqUser,
    hrHOD,
    monthStart,
}) {
    const parties = resolveFinePartiesFromBillingPayables(unit.billingPayables);
    if (!parties.length) {
        return { created: [], skipped: true, reason: 'no_payable_parties' };
    }

    const isGroup = parties.length > 1;
    const baseFineId = await generateFineIdInternal();
    const wfTarget = await resolveAutoApprovedWorkflow(hrHOD);
    const monthLabel = currentMonthLabel(monthStart);
    const now = new Date();
    const costBit = unit.costLabel ? ` — ${unit.costLabel}` : '';
    const billBit = unit.zohoBillNumber
        ? ` (Zoho ${unit.zohoBillNumber})`
        : unit.zohoBillId
          ? ` (Zoho ${unit.zohoBillId})`
          : '';
    const description = `${serviceTypeLabel} Vehicle Damage${costBit}${billBit} — ${
        asset.assetId || asset.name || 'Vehicle'
    } — ${monthLabel}`;

    const created = [];
    let companyObjectId = null;
    let companyName = '';

    const partyCompanyId = String(remark.companyPayPartyId || '').trim();
    const partyCompanyName = String(
        remark.companyPayPartyName || remark.companyName || '',
    ).trim();
    if (partyCompanyId && /^[a-fA-F0-9]{24}$/.test(partyCompanyId)) {
        const companyDoc = await Company.findById(partyCompanyId)
            .select('name nickName companyName companyShortName tradeName')
            .lean()
            .catch(() => null);
        if (companyDoc?._id) {
            companyObjectId = companyDoc._id;
            companyName =
                companyDoc.nickName ||
                companyDoc.companyShortName ||
                companyDoc.companyName ||
                companyDoc.tradeName ||
                companyDoc.name ||
                partyCompanyName ||
                '';
        }
    }
    if (!companyName && partyCompanyName && !/^Company$/i.test(partyCompanyName)) {
        companyName = partyCompanyName;
    }

    for (let i = 0; i < parties.length; i += 1) {
        const party = parties[i];
        let emp = null;
        if (!party.isCompany && party.employeeId) {
            const id = String(party.employeeId).trim();
            const isObjectId = /^[a-fA-F0-9]{24}$/.test(id);
            if (isObjectId) {
                emp = await EmployeeBasic.findById(id)
                    .populate(
                        'primaryReportee',
                        'firstName lastName employeeId companyEmail workEmail personalEmail email',
                    )
                    .populate('company', 'name nickName companyName')
                    .lean()
                    .catch(() => null);
            }
            if (!emp) {
                emp = await EmployeeBasic.findOne({ employeeId: id })
                    .populate(
                        'primaryReportee',
                        'firstName lastName employeeId companyEmail workEmail personalEmail email',
                    )
                    .populate('company', 'name nickName companyName')
                    .lean()
                    .catch(() => null);
            }
        }

        const empName = party.isCompany
            ? party.partyName || companyName || 'Company'
            : `${emp?.firstName || ''} ${emp?.lastName || ''}`.trim() ||
              party.partyName ||
              party.employeeId;

        if (!companyObjectId && emp?.company?._id) {
            companyObjectId = emp.company._id;
            if (!companyName) {
                companyName =
                    emp.company.nickName || emp.company.companyName || emp.company.name || '';
            }
        }

        // Company share settled by Zoho bill → Paid.
        // Employee share stays unpaid (Approved) so it shows as owed on their profile.
        const isCompanyParty = Boolean(party.isCompany);
        const fineStatus = isCompanyParty ? 'Paid' : 'Approved';
        const paidAmount = isCompanyParty ? party.amount : 0;

        const finePayload = {
            fineId: `${baseFineId}${partySuffix(i, parties.length)}`,
            assignedEmployees: [
                {
                    employeeId: isCompanyParty
                        ? COMPANY_PARTY_ID
                        : emp?.employeeId || party.employeeId,
                    employeeName: empName,
                    daysWorked: 0,
                    individualAmount: party.amount,
                    approvalStatus: 'Approved',
                    approvedAt: now,
                    approvedBy: reqUser?._id || reqUser?.id || undefined,
                },
            ],
            fineType: 'Vehicle Damage',
            fineStatus,
            fineAmount: party.amount,
            totalFineAmount: party.amount,
            paidAmount,
            employeeAmount: isCompanyParty ? 0 : party.amount,
            companyAmount: isCompanyParty ? party.amount : 0,
            serviceCharge: 0,
            payableDuration: 1,
            monthStart,
            originalMonthStart: monthStart,
            originalPayableDuration: 1,
            description,
            awardedDate: now,
            approvedDate: now,
            remarks: isCompanyParty
                ? `${serviceTypeLabel} company liability settled with Zoho bill${
                      unit.zohoBillId ? ` ${unit.zohoBillId}` : ''
                  } — auto-marked Paid`
                : `${serviceTypeLabel} employee liability from Zoho bill${
                      unit.zohoBillId ? ` ${unit.zohoBillId}` : ''
                  } — approved, awaiting employee payment`,
            category: 'Damage',
            subCategory: 'Vehicle Damage',
            vehicleId: asset.assetId || '',
            assetId: asset._id,
            assetName: asset.name || '',
            company: companyObjectId,
            companyName,
            fineSource: unit.garageName || remark.garageName || serviceTypeLabel,
            sourceOfIncome: 'Salary',
            responsibleFor: isCompanyParty ? 'Company' : 'Employee',
            createdBy: reqUser?._id || reqUser?.id,
            submittedTo: wfTarget.submittedTo || undefined,
            workflow: wfTarget.workflow?.length ? wfTarget.workflow : undefined,
        };

        const saved = await new Fine(finePayload).save();
        created.push(saved);
    }

    // No pending dashboard action — workflow already fully approved.

    return { created, skipped: false, isGroup };
}

/**
 * Create Vehicle Damage fines for successful Zoho garage bills.
 * Idempotent per zohoBillId (tracked on service remark.zohoBillVehicleDamageFines).
 */
export async function createGarageZohoBillVehicleDamageFines({
    asset,
    service,
    reqUser = null,
    serviceTypeLabel = '',
} = {}) {
    const label = String(serviceTypeLabel || service?.serviceType || '').trim();
    if (!SUPPORTED_LABELS.has(label)) {
        return { ok: true, skipped: true, created: [], message: 'Service type not eligible.' };
    }
    if (!asset || !service) {
        return { ok: false, created: [], message: 'Asset and service are required.' };
    }

    const remark = parseRemark(service);
    const units = resolveZohoBillFineUnits(remark, label);
    if (!units.length) {
        return {
            ok: true,
            skipped: true,
            created: [],
            message: 'No new Zoho bills need Vehicle Damage fines.',
        };
    }

    const hrHOD = await getDepartmentHOD('hr');
    const monthStart = currentMonthStart();
    const allCreated = [];
    const stamp = Array.isArray(remark.zohoBillVehicleDamageFines)
        ? [...remark.zohoBillVehicleDamageFines]
        : [];

    for (const unit of units) {
        try {
            const result = await createFineGroupForBillUnit({
                asset,
                service,
                remark,
                unit,
                serviceTypeLabel: label,
                reqUser,
                hrHOD,
                monthStart,
            });
            if (result.created?.length) {
                allCreated.push(...result.created);
                stamp.push({
                    zohoBillId: unit.zohoBillId,
                    zohoBillNumber: unit.zohoBillNumber || '',
                    costLabel: unit.costLabel || '',
                    fineIds: result.created.map((f) => f.fineId),
                    fineMongoIds: result.created.map((f) => String(f._id)),
                    isGroup: Boolean(result.isGroup),
                    monthStart,
                    createdAt: new Date().toISOString(),
                });
            } else {
                // Mark bill so we don't retry empty company-only forever without stamp?
                // Only stamp when we actually created, so payables fixed later can still create.
            }
        } catch (err) {
            console.error(
                '[GarageZohoFine] Vehicle Damage fine failed for bill',
                unit.zohoBillId,
                err?.message || err,
            );
        }
    }

    if (stamp.length !== (remark.zohoBillVehicleDamageFines || []).length || allCreated.length) {
        remark.zohoBillVehicleDamageFines = stamp;
        remark.vehicleDamageFinesCreatedAt = new Date().toISOString();
        service.remark = JSON.stringify(remark);
        asset.markModified('services');
    }

    // Notify each fined employee; CC all co-assigned employees + HR + Admin.
    const reqLike = reqUser ? { user: reqUser } : null;
    const groupEmployeeParties = [];
    for (const fine of allCreated) {
        const parties = Array.isArray(fine.assignedEmployees) ? fine.assignedEmployees : [];
        for (const party of parties) {
            if (!isCompanyFineParty(party)) groupEmployeeParties.push(party);
        }
    }
    for (const fine of allCreated) {
        const parties = Array.isArray(fine.assignedEmployees) ? fine.assignedEmployees : [];
        const employeeParties = parties.filter((p) => !isCompanyFineParty(p));
        if (!employeeParties.length) continue;
        try {
            await dispatchFineApprovedNotification(fine, employeeParties, reqLike, {
                ccAssignedEmployees: groupEmployeeParties,
            });
        } catch (err) {
            console.error(
                '[GarageZohoFine] Fine approved email failed for',
                fine.fineId,
                err?.message || err,
            );
        }
    }

    return {
        ok: true,
        created: allCreated,
        count: allCreated.length,
        message: allCreated.length
            ? `Created ${allCreated.length} Vehicle Damage fine(s) for ${units.length} Zoho bill(s).`
            : 'No Vehicle Damage fines created from bill payables.',
    };
}

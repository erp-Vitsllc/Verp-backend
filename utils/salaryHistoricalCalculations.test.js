import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DEFAULT_ENTITLEMENT_DAYS,
    MESSAGES,
    addDays,
    allCyclesVerified,
    buildReadinessItems,
    calculateHistoricalEligibility,
    canEditProfile,
    canReopenProfile,
    findDuplicateConsumingCycles,
    findOverlappingLeave,
    historicalPeriod,
    leaveDeductionDays,
    leaveMultiplier,
    policyLeaveMultipliers,
    resolveEntitlementDays,
    summarizeAttendanceEligibility,
    validateLeaveDates,
    validateVerpStart,
    workflowIsLocked,
} from './salaryHistoricalCalculations.js';

describe('salary historical calculations', () => {
    it('uses the configured entitlement threshold rather than a caller hard-code', () => {
        assert.equal(resolveEntitlementDays(300), 300);
        assert.equal(resolveEntitlementDays(240), 240);
        assert.equal(resolveEntitlementDays(null), DEFAULT_ENTITLEMENT_DAYS);
    });

    it('counts live attendance working days and policy leave types', () => {
        const live = summarizeAttendanceEligibility([
            { date: '2026-08-01', statusKey: 'on_office' },
            { date: '2026-08-02', statusKey: 'work_from_home' },
            { date: '2026-08-03', statusKey: 'weekly_off' },
            { date: '2026-08-04', statusKey: 'authorized_leave' },
            { date: '2026-08-05', statusKey: 'unauthorized_leave' },
            { date: '2026-08-05', statusKey: 'unauthorized_leave' },
            { date: '2026-08-06', statusKey: 'sick_leave' },
            { date: '2026-08-07', statusKey: 'holiday' },
            { date: '2026-08-08', statusKey: 'not_marked' },
            { date: '2026-08-09', statusKey: 'on_leave' },
        ]);
        assert.equal(live.workingDays, 2);
        assert.equal(live.leaveRecords.length, 4);
        assert.deepEqual(
            live.leaveRecords.map((row) => row.leaveType).sort(),
            ['annual', 'authorized', 'sick', 'unauthorized'],
        );
        const result = calculateHistoricalEligibility({
            workingDays: 40 + live.workingDays,
            leaveRecords: [
                { leaveType: 'authorized', eligibleWorkingDays: 5 },
                ...live.leaveRecords,
            ],
            leaveMultipliers: policyLeaveMultipliers({
                authorizedLeaveDeductionDays: 1,
                unauthorizedLeaveDeductionDays: 2,
                sickLeaveDeductionDays: 1,
            }),
        });
        assert.equal(result.workingDays, 42);
        assert.equal(result.authorizedDeduction, 6);
        assert.equal(result.unauthorizedDeduction, 2);
        assert.equal(result.sickDeduction, 1);
        assert.equal(result.annualDeduction, 1);
        assert.equal(result.eligibleBalance, 32);
    });

    it('counts unauthorized leave at twice eligible working days', () => {
        assert.equal(leaveMultiplier('unauthorized'), 2);
        assert.equal(
            leaveDeductionDays({ leaveType: 'unauthorized', eligibleWorkingDays: 3 }),
            6,
        );
        assert.equal(leaveDeductionDays({ leaveType: 'authorized', eligibleWorkingDays: 5 }), 5);
        assert.equal(leaveDeductionDays({ leaveType: 'annual', eligibleWorkingDays: 42 }), 42);
        assert.equal(leaveDeductionDays({ leaveType: 'sick', eligibleWorkingDays: 8, status: 'cancelled' }), 0);
    });

    it('uses work-location / group salary policy leave deduction days', () => {
        const policy = policyLeaveMultipliers({
            authorizedLeaveDeductionDays: 1,
            unauthorizedLeaveDeductionDays: 1,
        });
        assert.equal(leaveMultiplier('unauthorized', null, policy), 1);
        assert.equal(leaveMultiplier('authorized', null, policy), 1);
        assert.equal(
            leaveDeductionDays({ leaveType: 'unauthorized', eligibleWorkingDays: 3 }, policy),
            3,
        );
        const halfDay = policyLeaveMultipliers({ authorizedLeaveDeductionDays: 0.5 });
        assert.equal(leaveDeductionDays({ leaveType: 'authorized', eligibleWorkingDays: 4 }, halfDay), 2);
        const none = policyLeaveMultipliers({ unauthorizedLeaveDeductionDays: 0 });
        assert.equal(leaveMultiplier('unauthorized', null, none), 0);
        assert.equal(leaveDeductionDays({ leaveType: 'unauthorized', eligibleWorkingDays: 4 }, none), 0);
        assert.equal(
            leaveDeductionDays({ leaveType: 'unauthorized', eligibleWorkingDays: 3, multiplier: 2 }, none),
            6,
        );
    });

    it('matches the 928 working-day acceptance case', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 928,
            calendarDays: 1295,
            cycleDays: 300,
            leaveRecords: [
                { leaveType: 'sick', eligibleWorkingDays: 8 },
                { leaveType: 'authorized', eligibleWorkingDays: 5 },
                { leaveType: 'unauthorized', eligibleWorkingDays: 3 },
            ],
            annualLeaveRecords: [{ leaveType: 'annual', eligibleWorkingDays: 42 }],
            paymentCycles: [
                { paymentStatus: 'paid', verificationStatus: 'verified', entitlementDays: 300 },
                { paymentStatus: 'paid', verificationStatus: 'verified', entitlementDays: 300 },
            ],
        });
        assert.equal(result.sickDeduction, 8);
        assert.equal(result.authorizedDeduction, 5);
        assert.equal(result.unauthorizedDeduction, 6);
        assert.equal(result.annualDeduction, 42);
        assert.equal(result.totalLeaveDeduction, 61);
        assert.equal(result.netQualifyingDays, 867);
        assert.equal(result.paidVerifiedCycles, 2);
        assert.equal(result.consumedEntitlementDays, 600);
        assert.equal(result.remainingAfterCycles, 267);
        assert.equal(result.eligibleBalance, 267);
        assert.equal(result.daysRequired, 33);
        assert.equal(result.eligibleForBenefit, false);
        assert.equal(result.availableCycles, 0);
    });

    it('keeps a signed eligible balance when leave exceeds joining-to-VERP working days', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 0,
            calendarDays: 0,
            cycleDays: 300,
            leaveRecords: [
                { leaveType: 'unauthorized', eligibleWorkingDays: 5, deductionDays: 25 },
                { leaveType: 'unauthorized', eligibleWorkingDays: 5, deductionDays: 25 },
                { leaveType: 'sick', eligibleWorkingDays: 13 },
            ],
        });
        assert.equal(result.totalLeaveDeduction, 63);
        assert.equal(result.netQualifyingDays, -63);
        assert.equal(result.eligibleBalance, -63);
        assert.equal(result.daysRequired, 363);
        assert.equal(result.availableCycles, 0);
        assert.equal(result.progressFill, 0);
        assert.equal(result.eligibleForBenefit, false);
    });

    it('subtracts 300 entitlement days from eligible balance for each paid cycle', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 42,
            cycleDays: 300,
            leaveRecords: [
                { leaveType: 'sick', eligibleWorkingDays: 1 },
                { leaveType: 'unauthorized', eligibleWorkingDays: 1, deductionDays: 5 },
                { leaveType: 'unauthorized', eligibleWorkingDays: 1, deductionDays: 5 },
                { leaveType: 'unauthorized', eligibleWorkingDays: 5, deductionDays: 25 },
                { leaveType: 'unauthorized', eligibleWorkingDays: 1, deductionDays: 5 },
            ],
            annualLeaveRecords: [{ leaveType: 'annual', eligibleWorkingDays: 22 }],
            paymentCycles: [
                { paymentStatus: 'paid', verificationStatus: 'verified', entitlementDays: 300 },
            ],
        });
        assert.equal(result.totalLeaveDeduction, 63);
        assert.equal(result.netQualifyingDays, -21);
        assert.equal(result.consumedEntitlementDays, 300);
        assert.equal(result.eligibleBalance, -321);
        assert.equal(result.remainingAfterCycles, -321);
        assert.equal(result.daysRequired, 621);
        assert.equal(result.eligibleForBenefit, false);
    });

    it('does not deduct draft, cancelled, or rejected payment cycles', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 928,
            cycleDays: 300,
            leaveRecords: [],
            paymentCycles: [
                { paymentStatus: 'draft', verificationStatus: 'pending' },
                { paymentStatus: 'cancelled', verificationStatus: 'verified' },
                { paymentStatus: 'paid', verificationStatus: 'rejected' },
            ],
        });
        assert.equal(result.paidVerifiedCycles, 0);
        assert.equal(result.consumedEntitlementDays, 0);
        assert.equal(result.eligibleBalance, 928);
        assert.equal(result.availableCycles, 3);
        assert.equal(result.eligibleForBenefit, true);
        assert.equal(result.daysRequired, 0);
    });

    it('deducts entitlement days only once per paid and verified cycle', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 600,
            cycleDays: 300,
            paymentCycles: [
                {
                    paymentStatus: 'paid',
                    verificationStatus: 'verified',
                    leaveSalaryAmount: 8500,
                    ticketAmount: 1800,
                    entitlementDays: 300,
                },
            ],
        });
        assert.equal(result.consumedEntitlementDays, 300);
        assert.equal(result.paidVerifiedCycles, 1);
        assert.equal(result.eligibleBalance, 300);
        assert.equal(result.availableCycles, 1);
    });

    it('validates VERP start after joining and historical period end = start − 1', () => {
        assert.equal(validateVerpStart('2023-01-15', '2023-01-15'), MESSAGES.verpAfterJoining);
        assert.equal(validateVerpStart('2023-01-15', '2023-01-14'), MESSAGES.verpAfterJoining);
        assert.equal(validateVerpStart('2023-01-15', '2026-08-01'), '');
        const period = historicalPeriod('2023-01-15', '2026-08-01');
        assert.equal(period.end, '2026-07-31');
        assert.equal(addDays('2026-08-01', -1), '2026-07-31');
    });

    it('rejects overlapping leave and dates outside the historical period', () => {
        const overlap = findOverlappingLeave([
            { fromDate: '2024-03-04', toDate: '2024-03-11', status: 'verified' },
            { fromDate: '2024-03-10', toDate: '2024-03-12', status: 'verified' },
        ]);
        assert.ok(overlap);
        assert.equal(
            validateLeaveDates(
                { fromDate: '2022-01-01', toDate: '2022-01-05' },
                '2023-01-15',
                '2026-07-31',
            ),
            MESSAGES.leaveOutsidePeriod,
        );
        assert.equal(
            validateLeaveDates(
                { leaveType: 'annual', fromDate: '2026-07-26', toDate: '2026-08-31' },
                '2023-01-15',
                '2026-07-31',
            ),
            '',
        );
        assert.equal(
            findOverlappingLeave([
                { fromDate: '2024-03-04', toDate: '2024-03-11', status: 'cancelled' },
                { fromDate: '2024-03-10', toDate: '2024-03-12', status: 'verified' },
            ]),
            null,
        );
        assert.equal(
            findOverlappingLeave([
                { leaveType: 'annual', fromDate: '2026-07-26', toDate: '2026-08-31' },
                { leaveType: 'unauthorized', fromDate: '2026-08-01', toDate: '2026-08-01' },
            ]),
            null,
        );
        assert.equal(
            validateLeaveDates({ leaveType: 'sick', eligibleWorkingDays: 4 }, '2023-01-15', '2026-07-31'),
            '',
        );
        assert.equal(
            validateLeaveDates({ leaveType: 'annual', eligibleWorkingDays: 4 }, '2023-01-15', '2026-07-31'),
            MESSAGES.annualLeaveDatesRequired,
        );
        assert.equal(
            validateLeaveDates({}, '2023-01-15', '2026-07-31'),
            MESSAGES.leaveCountRequired,
        );
    });

    it('treats locked profiles as read-only until an authorized reopen', () => {
        assert.equal(workflowIsLocked('locked'), true);
        assert.equal(workflowIsLocked('created'), true);
        assert.equal(workflowIsLocked('draft'), false);
        assert.equal(canEditProfile({ workflowStatus: 'locked', canEdit: true }), false);
        assert.equal(canEditProfile({ workflowStatus: 'reopened', canEdit: true }), true);
        assert.equal(canEditProfile({ workflowStatus: 'draft', canEdit: false }), false);
        assert.equal(canReopenProfile({ workflowStatus: 'locked', canEdit: true }), true);
        assert.equal(canReopenProfile({ workflowStatus: 'draft', canEdit: true }), false);
    });

    it('rejects a second paid and verified cycle with the same cycle number', () => {
        const dup = findDuplicateConsumingCycles(
            [
                { cycleNumber: 1, paymentStatus: 'paid', verificationStatus: 'verified' },
                { cycleNumber: 1, paymentStatus: 'paid', verificationStatus: 'verified' },
            ],
            300,
        );
        assert.ok(dup);
        assert.equal(
            findDuplicateConsumingCycles(
                [
                    { cycleNumber: 1, paymentStatus: 'paid', verificationStatus: 'verified' },
                    { cycleNumber: 1, paymentStatus: 'draft', verificationStatus: 'pending' },
                ],
                300,
            ),
            null,
        );
    });

    it('blocks create until every readiness item is complete and verified', () => {
        const incomplete = buildReadinessItems({
            joiningDate: '2023-01-15',
            verpStartDate: '2026-08-01',
            periodEnd: '2026-07-31',
            workingDaysCalculated: true,
            leaveComplete: true,
            annualComplete: true,
            benefitsComplete: true,
            cyclesVerified: true,
            noOverlap: true,
            noErrors: true,
            verified: false,
        });
        assert.equal(incomplete.canCreate, false);
        const ready = buildReadinessItems({
            joiningDate: '2023-01-15',
            verpStartDate: '2026-08-01',
            periodEnd: '2026-07-31',
            workingDaysCalculated: true,
            companyMolCode: 'MOL-CO-100',
            employeeMolId: 'MOL-EMP-200',
            leaveComplete: true,
            annualComplete: true,
            benefitsComplete: true,
            cyclesVerified: true,
            noOverlap: true,
            noErrors: true,
            verified: true,
        });
        assert.equal(ready.canCreate, true);
        assert.equal(ready.percent, 100);
        assert.equal(
            buildReadinessItems({
                joiningDate: '2023-01-15',
                verpStartDate: '2026-08-01',
                periodEnd: '2026-07-31',
                workingDaysCalculated: true,
                leaveComplete: true,
                annualComplete: true,
                benefitsComplete: true,
                cyclesVerified: true,
                noOverlap: true,
                noErrors: true,
                verified: true,
            }).canCreate,
            true,
        );
        assert.equal(allCyclesVerified([{ paymentStatus: 'paid', verificationStatus: 'verified' }]), true);
        assert.equal(allCyclesVerified([{ paymentStatus: 'paid', verificationStatus: 'pending' }]), false);
    });
});

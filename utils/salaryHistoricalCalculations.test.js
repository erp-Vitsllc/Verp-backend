import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    consolidateCountOnlyLeaveRecords,
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
    leaveTicketEligibility,
    countPolicyEntitlements,
    leaveRecordPeriodRange,
    partitionEnrollmentRows,
    paymentCyclePeriodRange,
    annualLeavePeriodRange,
    policyLeaveMultipliers,
    policyLeaveWorkingDays,
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

    it('reads salary policy Number of working days eligible for Leave first', () => {
        assert.equal(policyLeaveWorkingDays({ leaveSalaryWorkingDays: 240, workingDaysRequiredToEligible: 300 }, 300), 240);
        assert.equal(policyLeaveWorkingDays({ leaveSalaryWorkingDays: null, workingDaysRequiredToEligible: 220 }, 300), 220);
        assert.equal(policyLeaveWorkingDays({}, 180), 180);
        assert.equal(policyLeaveWorkingDays({}), DEFAULT_ENTITLEMENT_DAYS);
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
            { date: '2026-08-10', statusKey: 'compoff_leave' },
            {
                date: '2026-08-11',
                statusKey: 'not_marked',
                leaveRequestStatus: 'approved',
                requestedStatusKey: 'sick_leave',
            },
            {
                date: '2026-08-12',
                statusKey: 'on_office',
                leaveRequestStatus: 'pending',
                requestedStatusKey: 'authorized_leave',
            },
        ]);
        assert.equal(live.workingDays, 2);
        assert.equal(live.leaveRecords.length, 7);
        assert.deepEqual(
            live.leaveRecords.map((row) => row.leaveType).sort(),
            ['annual', 'annual', 'authorized', 'authorized', 'sick', 'sick', 'unauthorized'],
        );
        const pending = live.leaveRecords.find((row) => row.fromDate === '2026-08-12');
        assert.equal(pending.status, 'pending');
        assert.equal(leaveDeductionDays(pending), 0);
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
        assert.equal(result.sickDeduction, 2);
        assert.equal(result.annualDeduction, 2);
        assert.equal(result.eligibleBalance, 30);
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

    it('counts leave and ticket eligibility by subtracting policy working days', () => {
        const { count, remainder } = countPolicyEntitlements(720, 300);
        assert.equal(count, 2);
        assert.equal(remainder, 120);
        const { count: none } = countPolicyEntitlements(299, 300);
        assert.equal(none, 0);
        const eligibility = leaveTicketEligibility({
            days: 720,
            leaveWorkingDays: 300,
            airTicketWorkingDays: 365,
            basicSalary: 2500,
        });
        assert.equal(eligibility.count, 2);
        assert.equal(eligibility.eligibleLeaveSalary, 5000);
        assert.equal(eligibility.eligibleTicketDays, 730);
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

    it('does not consume entitlement when reduceHistoricalWorkingDays is false', () => {
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
                    reduceHistoricalWorkingDays: false,
                },
            ],
        });
        assert.equal(result.consumedEntitlementDays, 0);
        assert.equal(result.paidVerifiedCycles, 0);
        assert.equal(result.eligibleBalance, 600);
    });

    it('subtracts the salary-policy leave working days once for reducing annual leave', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 500,
            cycleDays: 240,
            annualLeaveRecords: [
                {
                    startDate: '2026-06-01',
                    endDate: '2026-06-20',
                    eligibleWorkingDays: 14,
                    reduceHistoricalWorkingDays: true,
                },
            ],
        });
        assert.equal(result.cycleDays, 240);
        assert.equal(result.annualDeduction, 14);
        assert.equal(result.consumedAnnualLeaveCycles, 1);
        assert.equal(result.consumedEntitlementDays, 240);
        assert.equal(result.eligibleBalance, 246);
    });

    it('does not subtract policy leave days twice for the same annual leave and paid cycle', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 500,
            cycleDays: 240,
            annualLeaveRecords: [
                {
                    startDate: '2026-06-01',
                    endDate: '2026-06-20',
                    eligibleWorkingDays: 14,
                    reduceHistoricalWorkingDays: true,
                },
            ],
            paymentCycles: [
                {
                    eligibilityStartDate: '2026-06-01',
                    eligibilityEndDate: '2026-06-20',
                    paymentStatus: 'paid',
                    verificationStatus: 'verified',
                    entitlementDays: 240,
                },
            ],
        });
        assert.equal(result.consumedEntitlementDays, 240);
        assert.equal(result.consumedAnnualLeaveCycles, 1);
        assert.equal(result.paidVerifiedCycles, 0);
        assert.equal(result.eligibleBalance, 246);
    });

    it('reduces 300 working days only once per annual leave even if leave and ticket are paid separately', () => {
        const result = calculateHistoricalEligibility({
            workingDays: 600,
            cycleDays: 300,
            paymentCycles: [
                {
                    annualLeaveKey: '2025-01-01|2025-01-20',
                    paymentStatus: 'paid',
                    verificationStatus: 'verified',
                    includeLeave: true,
                    leaveSalaryAmount: 8000,
                    entitlementDays: 300,
                    reduceHistoricalWorkingDays: true,
                },
                {
                    annualLeaveKey: '2025-01-01|2025-01-20',
                    paymentStatus: 'paid',
                    verificationStatus: 'verified',
                    includeTicket: true,
                    ticketAmount: 1500,
                    entitlementDays: 300,
                    reduceHistoricalWorkingDays: true,
                },
            ],
        });
        assert.equal(result.consumedEntitlementDays, 300);
        assert.equal(result.paidVerifiedCycles, 1);
        assert.equal(result.eligibleBalance, 300);
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
            validateLeaveDates(
                { leaveType: 'sick', fromDate: '2024-02-01', eligibleWorkingDays: 3 },
                '2023-01-15',
                '2026-07-31',
            ),
            'Enter both a start date and an end date, or leave both blank.',
        );
        assert.equal(
            validateLeaveDates(
                { leaveType: 'sick', fromDate: '2024-02-01', toDate: '2024-02-03', eligibleWorkingDays: 3 },
                '2023-01-15',
                '2026-07-31',
            ),
            '',
        );
        assert.equal(
            validateLeaveDates({ leaveType: 'authorized', eligibleWorkingDays: 4 }, '2023-01-15', '2026-07-31'),
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

    it('keeps only one authorized and unauthorized row per source', () => {
        const rows = consolidateCountOnlyLeaveRecords(
            [
                { leaveType: 'authorized', eligibleWorkingDays: 2, source: 'manual' },
                { leaveType: 'authorized', eligibleWorkingDays: 3, source: 'manual' },
                { leaveType: 'unauthorized', eligibleWorkingDays: 1, source: 'system' },
                { leaveType: 'unauthorized', eligibleWorkingDays: 4, source: 'system' },
                { leaveType: 'sick', fromDate: '2026-08-01', toDate: '2026-08-02', eligibleWorkingDays: 2 },
            ],
            policyLeaveMultipliers({ unauthorizedLeaveDeductionDays: 2 }),
        );
        const authorized = rows.filter((row) => row.leaveType === 'authorized');
        const unauthorized = rows.filter((row) => row.leaveType === 'unauthorized');
        const sick = rows.filter((row) => row.leaveType === 'sick');
        assert.equal(authorized.length, 1);
        assert.equal(authorized[0].eligibleWorkingDays, 5);
        assert.equal(authorized[0].source, 'manual');
        assert.equal(unauthorized.length, 1);
        assert.equal(unauthorized[0].eligibleWorkingDays, 5);
        assert.equal(unauthorized[0].deductionDays, 10);
        assert.equal(sick.length, 1);
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

    it('partitions only enrolment rows that overlap joining → day before VERP start', () => {
        const period = historicalPeriod('2023-01-15', '2026-08-01');
        const leave = partitionEnrollmentRows(
            [
                { fromDate: '2024-03-01', toDate: '2024-03-05' },
                { fromDate: '2026-08-02', toDate: '2026-08-04' },
                { fromDate: '2022-12-01', toDate: '2022-12-10' },
            ],
            period,
            leaveRecordPeriodRange,
        );
        assert.equal(leave.archived.length, 1);
        assert.equal(leave.archived[0].fromDate, '2024-03-01');
        assert.equal(leave.kept.length, 2);

        const annual = partitionEnrollmentRows(
            [{ startDate: '2026-07-20', endDate: '2026-07-28' }],
            period,
            annualLeavePeriodRange,
        );
        assert.equal(annual.archived.length, 1);

        const cycles = partitionEnrollmentRows(
            [
                { eligibilityStartDate: '2025-01-01', eligibilityEndDate: '2025-10-28' },
                { eligibilityStartDate: '2026-08-01', eligibilityEndDate: '2027-05-28' },
            ],
            period,
            paymentCyclePeriodRange,
        );
        assert.equal(cycles.archived.length, 1);
        assert.equal(cycles.kept.length, 1);
        assert.equal(cycles.kept[0].eligibilityStartDate, '2026-08-01');
    });
});

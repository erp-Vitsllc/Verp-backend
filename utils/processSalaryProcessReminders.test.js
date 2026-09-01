import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zonedWallTimeToUtc } from './scheduleDailyAtMidnight.js';
import {
    matchingReminderStages,
    monthKeyIsOnOrAfterStart,
    nextSalaryProcessingTarget,
    processingDayFromPolicy,
    salaryProcessCompanyEmail,
} from './processSalaryProcessReminders.js';

const TZ = 'Asia/Dubai';

function dubaiDay(year, month, day) {
    return zonedWallTimeToUtc({ year, month, day, hour: 8, minute: 0, second: 0 }, TZ);
}

describe('salary process reminder schedule', () => {
    it('defaults processing day to the 1st', () => {
        assert.equal(processingDayFromPolicy(''), 1);
        assert.equal(processingDayFromPolicy(null), 1);
        assert.equal(processingDayFromPolicy('15'), 15);
        assert.equal(processingDayFromPolicy('31'), 28);
    });

    it('counts days before the 1st into the previous month', () => {
        const target = nextSalaryProcessingTarget(dubaiDay(2026, 8, 20), 1, TZ);
        assert.equal(target.monthKey, '2026-09');
        assert.equal(target.daysUntil, 12);
    });

    it('fires the processing-day stage on the 1st', () => {
        const target = nextSalaryProcessingTarget(dubaiDay(2026, 9, 1), 1, TZ);
        assert.equal(target.monthKey, '2026-09');
        assert.equal(target.daysUntil, 0);
    });

    it('rolls to next month after the processing day has passed', () => {
        const target = nextSalaryProcessingTarget(dubaiDay(2026, 9, 2), 1, TZ);
        assert.equal(target.monthKey, '2026-10');
        assert.equal(target.daysUntil, 29);
    });

    it('matches 1st / 2nd / 3rd / processing-day stages when audiences are checked', () => {
        const reminders = [
            { daysBefore: 12, forWhom: ['wfAccounts'] },
            { daysBefore: 5, forWhom: ['wfHr'] },
            { daysBefore: 2, forWhom: ['wfAdmin', 'wfManagement'] },
            { daysBefore: 0, forWhom: ['pendingTaskUser'] },
        ];
        assert.equal(matchingReminderStages(reminders, 12)[0]?.stageLabel, '1st reminder');
        assert.equal(matchingReminderStages(reminders, 5)[0]?.stageLabel, '2nd reminder');
        assert.equal(matchingReminderStages(reminders, 2)[0]?.stageLabel, '3rd reminder');
        assert.equal(matchingReminderStages(reminders, 0)[0]?.stageLabel, 'Salary processing');
        assert.deepEqual(matchingReminderStages(reminders, 7), []);
        assert.deepEqual(
            matchingReminderStages([{ daysBefore: 12, forWhom: [] }], 12),
            [],
        );
        assert.deepEqual(
            matchingReminderStages(
                [
                    { daysBefore: null, forWhom: ['wfAccounts'] },
                    { daysBefore: '', forWhom: ['wfHr'] },
                    { daysBefore: null, forWhom: [] },
                    { daysBefore: 0, forWhom: ['pendingTaskUser'] },
                ],
                0,
            ).map((row) => row.stageLabel),
            ['Salary processing'],
        );
    });

    it('does not remind for months before salary process start', () => {
        assert.equal(monthKeyIsOnOrAfterStart('2026-09', '2026-09'), true);
        assert.equal(monthKeyIsOnOrAfterStart('2026-08', '2026-09'), false);
        assert.equal(monthKeyIsOnOrAfterStart('2026-09', ''), true);
    });

    it('uses company email only', () => {
        assert.equal(
            salaryProcessCompanyEmail({ companyEmail: 'hr@company.com', email: 'personal@mail.com' }),
            'hr@company.com',
        );
        assert.equal(salaryProcessCompanyEmail({ email: 'personal@mail.com' }), '');
        assert.equal(
            salaryProcessCompanyEmail({ isFlowchartOnly: true, email: 'accounts@company.com' }),
            'accounts@company.com',
        );
    });
});

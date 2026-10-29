import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildOffDayWorkInboxItems,
    hasFinishedOffDayShift,
    offDayWorkKind,
    offDayWorkNoticeCopy,
    offDayWorkSettled,
} from './offDayWorkNotice.js';

const WEEK = {
    monday: { isOffDay: false },
    tuesday: { isOffDay: false },
    wednesday: { isOffDay: false },
    thursday: { isOffDay: false },
    friday: { isOffDay: true },
    saturday: { isOffDay: false },
    sunday: { isOffDay: false },
};

const WORKING_TIME = { office: WEEK, site: WEEK, extra: {} };

function punch(date, extra = {}) {
    return {
        _id: `row-${date}-${extra.employeeMongoId || 'e1'}`,
        date,
        employeeMongoId: 'e1',
        employeeName: 'Sara Ali',
        statusKey: 'on_office',
        timeIn: '08:00:00',
        timeOut: '17:00:00',
        flexibleOtStatus: '',
        flexibleOtApprovedHours: 0,
        flexibleOtNextDayDate: '',
        ...extra,
    };
}

describe('offDayWorkKind', () => {
    it('names a scheduled working Sunday as Sunday', () => {
        const kind = offDayWorkKind({
            date: '2026-10-25',
            week: WEEK,
            holiday: null,
            staffType: 'office',
        });
        assert.deepEqual(kind, { kind: 'sunday', dayLabel: 'Sunday' });
    });

    it('names Sunday as Sunday when that weekday is the weekly off', () => {
        const kind = offDayWorkKind({
            date: '2026-10-25',
            week: { ...WEEK, sunday: { isOffDay: true } },
            holiday: null,
            staffType: 'office',
        });
        assert.deepEqual(kind, { kind: 'sunday', dayLabel: 'Sunday' });
    });

    it('names a weekly off that is not Sunday', () => {
        const kind = offDayWorkKind({
            date: '2026-10-23',
            week: WEEK,
            holiday: null,
            staffType: 'office',
        });
        assert.deepEqual(kind, { kind: 'weekly_off', dayLabel: 'Weekly Off' });
    });

    it('lets a holiday win over Sunday', () => {
        const kind = offDayWorkKind({
            date: '2026-10-25',
            week: WEEK,
            holiday: { date: '2026-10-25', name: 'National Day', appliesTo: ['office'] },
            staffType: 'office',
        });
        assert.equal(kind.dayLabel, 'Holiday');
    });

    it('ignores a normal working day', () => {
        const kind = offDayWorkKind({
            date: '2026-10-26',
            week: WEEK,
            holiday: null,
            staffType: 'office',
        });
        assert.equal(kind, null);
    });

    it('ignores a holiday that does not apply to this group', () => {
        const kind = offDayWorkKind({
            date: '2026-10-26',
            week: WEEK,
            holiday: { date: '2026-10-26', name: 'Site Day', appliesTo: ['site'] },
            staffType: 'office',
        });
        assert.equal(kind, null);
    });
});

describe('off day work settlement', () => {
    it('stays open until OT or a comp-off next day is given', () => {
        assert.equal(offDayWorkSettled({ flexibleOtStatus: 'pending', flexibleOtApprovedHours: 8 }), false);
        assert.equal(offDayWorkSettled({ flexibleOtStatus: 'rejected', flexibleOtApprovedHours: 0 }), false);
        assert.equal(offDayWorkSettled({ flexibleOtStatus: 'approved', flexibleOtApprovedHours: 8 }), true);
        assert.equal(
            offDayWorkSettled({
                flexibleOtStatus: 'approved',
                flexibleOtApprovedHours: 0,
                flexibleOtNextDayDate: '2026-10-26',
            }),
            true,
        );
    });

    it('requires a real check-in and check-out', () => {
        assert.equal(hasFinishedOffDayShift({ timeIn: '08:00:00', timeOut: '' }), false);
        assert.equal(hasFinishedOffDayShift({ timeIn: 'OT', timeOut: 'OT' }), false);
        assert.equal(
            hasFinishedOffDayShift({ timeIn: '08:00:00', timeOut: '17:00:00', flexibleFromOtDate: '2026-10-24' }),
            false,
        );
        assert.equal(hasFinishedOffDayShift({ timeIn: '08:00:00', timeOut: '17:00:00' }), true);
    });
});

describe('buildOffDayWorkInboxItems', () => {
    const employees = [{ _id: 'e1', employeeId: 'E-1', firstName: 'Sara', lastName: 'Ali', staffType: 'office' }];
    const holidays = [{ date: '2026-10-26', name: 'National Day', appliesTo: ['office', 'site'] }];

    it('lists unfinished Sunday, weekly off, and holiday work for the reportee', () => {
        const items = buildOffDayWorkInboxItems({
            rows: [
                punch('2026-10-25'),
                punch('2026-10-23'),
                punch('2026-10-26'),
                punch('2026-10-24'),
                punch('2026-10-22', { flexibleOtStatus: 'approved', flexibleOtApprovedHours: 9 }),
                punch('2026-10-25', { employeeMongoId: 'e1', statusKey: 'sick_leave', _id: 'sick' }),
            ],
            employees,
            holidays,
            workingTime: WORKING_TIME,
        });
        const labels = items.map((item) => item.message);
        assert.deepEqual(labels, [
            'Sara Ali worked on 26 Oct 2026 (Holiday)',
            'Sara Ali worked on 25 Oct 2026 (Sunday)',
            'Sara Ali worked on 23 Oct 2026 (Weekly Off)',
        ]);
        assert.equal(items[0].requestType, 'Attendance Off Day Work');
        assert.equal(items[0].leaveRequestKind, 'off_day_work');
        assert.equal(items[0].staffType, 'office');
        assert.equal(items[0].extra1, 'Give OT or Comp Off');
        assert.equal(items[0].employeeMongoId, 'e1');
    });

    it('writes the bell sentence with the day in parentheses', () => {
        assert.equal(
            offDayWorkNoticeCopy({ name: 'Adarsh Sundarsan', date: '2026-10-25', dayLabel: 'Sunday' }),
            'Adarsh Sundarsan worked on 25 Oct 2026 (Sunday)',
        );
    });
});

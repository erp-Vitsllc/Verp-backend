import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calendarCellTag, calendarDaysForEmployee, calendarStatusKey, calendarTagsForEmployee } from './leaveGroupCalendarDays.js';

describe('calendarStatusKey', () => {
    it('keeps a closed punch that was stored unmarked as present', () => {
        assert.equal(
            calendarStatusKey(
                { date: '2026-10-01', statusKey: 'not_marked', timeIn: '08:00', timeOut: '17:00' },
                '2026-10-12',
            ),
            'on_office',
        );
    });

    it('keeps an open punch on today as present', () => {
        assert.equal(
            calendarStatusKey(
                { date: '2026-10-12', statusKey: 'not_marked', timeIn: '09:12', timeOut: '' },
                '2026-10-12',
            ),
            'on_office',
        );
    });

    it('leaves an old open punch unmarked', () => {
        assert.equal(
            calendarStatusKey(
                { date: '2026-10-01', statusKey: 'not_marked', timeIn: '09:12', timeOut: '' },
                '2026-10-12',
            ),
            'not_marked',
        );
    });

    it('keeps leave and late marks', () => {
        assert.equal(
            calendarStatusKey({ date: '2026-10-02', statusKey: 'sick_leave', timeIn: '', timeOut: '' }, '2026-10-12'),
            'sick_leave',
        );
        assert.equal(
            calendarStatusKey(
                { date: '2026-10-03', statusKey: 'late_arrived', timeIn: '09:40', timeOut: '18:00' },
                '2026-10-12',
            ),
            'late_arrived',
        );
    });
});

describe('calendarDaysForEmployee', () => {
    it('drops days before the employee is visible and keeps the rest', () => {
        const days = calendarDaysForEmployee(
            [
                { date: '2026-10-01', statusKey: 'on_office', timeIn: '08:00', timeOut: '17:00' },
                { date: '2026-10-05', statusKey: 'sick_leave' },
            ],
            { todayKey: '2026-10-12', visibleFrom: '2026-10-04' },
        );
        assert.deepEqual(days, { '2026-10-05': 'sick_leave' });
    });
});

describe('calendarCellTag', () => {
    it('shows OT when overtime is approved and was not moved to the next day', () => {
        assert.equal(calendarCellTag({
            statusKey: 'on_office',
            timeIn: '08:00',
            timeOut: '19:00',
            flexibleOtStatus: 'approved',
            flexibleOtApprovedHours: 2,
        }), 'OT');
    });

    it('shows COMPOFF when approved overtime was marked on the next day', () => {
        assert.equal(calendarCellTag({
            statusKey: 'on_office',
            timeIn: '08:00',
            timeOut: '19:00',
            flexibleOtStatus: 'approved',
            flexibleOtApprovedHours: 2,
            flexibleOtNextDayDate: '2026-10-10',
        }), 'COMPOFF');
    });

    it('shows COMPOFF on the next day marked from overtime', () => {
        assert.equal(calendarCellTag({
            statusKey: 'on_office',
            timeIn: 'OT',
            timeOut: 'OT',
            flexibleFromOtDate: '2026-10-09',
        }), 'COMPOFF');
        assert.equal(calendarCellTag({ statusKey: 'compoff_leave', timeIn: '', timeOut: '' }), 'COMPOFF');
    });

    it('leaves an ordinary present day blank', () => {
        assert.equal(calendarCellTag({
            statusKey: 'on_office',
            timeIn: '08:00',
            timeOut: '17:00',
        }), '');
    });
});

describe('calendarTagsForEmployee', () => {
    it('keeps OT and COMPOFF and drops days before the employee is visible', () => {
        const tags = calendarTagsForEmployee([
            {
                date: '2026-10-01',
                statusKey: 'on_office',
                flexibleOtStatus: 'approved',
                flexibleOtApprovedHours: 3,
                timeIn: '08:00',
                timeOut: '18:00',
            },
            {
                date: '2026-10-09',
                statusKey: 'on_office',
                flexibleOtStatus: 'approved',
                flexibleOtApprovedHours: 2,
                timeIn: '08:00',
                timeOut: '19:00',
            },
            {
                date: '2026-10-10',
                statusKey: 'on_office',
                timeIn: 'OT',
                timeOut: 'OT',
                flexibleFromOtDate: '2026-10-09',
            },
        ], { visibleFrom: '2026-10-04' });
        assert.deepEqual(tags, {
            '2026-10-09': 'OT',
            '2026-10-10': 'COMPOFF',
        });
    });
});

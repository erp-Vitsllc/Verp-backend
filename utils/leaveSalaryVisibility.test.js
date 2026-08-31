import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isDateKey,
    isEmployeeLeaveDateVisible,
    isEmployeeLeaveRangeVisible,
    isLeaveDateVisible,
    isLeaveEntryVisible,
    leaveRangeTouchesVisiblePeriod,
    formatProcessingMonthLabel,
    isSalaryMonthOpen,
    processingMonthFromStart,
    processingStartFromEnrollment,
    resolveSalaryProcessingStartDate,
    salaryOpensFromMessage,
} from './leaveSalaryVisibility.js';

describe('leave salary visibility', () => {
    it('builds processing start from enrollment month and salary day', () => {
        assert.equal(
            processingStartFromEnrollment({ fromMonth: '2026-08', salaryDate: '15' }),
            '2026-08-15',
        );
        assert.equal(
            processingStartFromEnrollment({ fromMonth: '2026-08', processDate: '28' }),
            '2026-08-28',
        );
        assert.equal(processingStartFromEnrollment({ fromMonth: '2026-08' }), '2026-08-01');
        assert.equal(
            processingStartFromEnrollment({ fromMonth: '2026-08', salaryDate: '2026-08-10' }),
            '2026-08-10',
        );
        assert.equal(processingStartFromEnrollment(null), '');
        assert.equal(isDateKey('2026-08-01'), true);
        assert.equal(isDateKey('08-01'), false);
    });

    it('prefers VERP salary processing start over enrollment day', () => {
        assert.equal(
            resolveSalaryProcessingStartDate({
                verpStartDate: '2026-08-20',
                enrollment: { fromMonth: '2026-08', salaryDate: '01' },
            }),
            '2026-08-20',
        );
        assert.equal(
            resolveSalaryProcessingStartDate({
                enrollment: { fromMonth: '2026-07', salaryDate: '5' },
            }),
            '2026-07-05',
        );
    });

    it('describes when live attendance opens after enrollment', () => {
        assert.equal(processingMonthFromStart('2026-09-01'), '2026-09');
        assert.equal(processingMonthFromStart({ fromMonth: '2026-09' }), '2026-09');
        assert.equal(formatProcessingMonthLabel('2026-09'), 'September 2026');
        assert.equal(salaryOpensFromMessage('2026-09'), 'You can open the September 2026 onwards');
        assert.equal(isSalaryMonthOpen('2026-08', '2026-09'), false);
        assert.equal(isSalaryMonthOpen('2026-09', '2026-09'), true);
        assert.equal(isSalaryMonthOpen('2026-10', '2026-09'), true);
    });

    it('hides leave days before the salary processing start date', () => {
        assert.equal(isLeaveDateVisible('2026-08-14', '2026-08-15'), false);
        assert.equal(isLeaveDateVisible('2026-08-15', '2026-08-15'), true);
        assert.equal(isLeaveDateVisible('2026-08-16', '2026-08-15'), true);
        assert.equal(isLeaveDateVisible('2026-08-16', ''), false);
        assert.equal(leaveRangeTouchesVisiblePeriod('2026-08-01', '2026-08-10', '2026-08-15'), false);
        assert.equal(leaveRangeTouchesVisiblePeriod('2026-08-01', '2026-08-20', '2026-08-15'), true);
        assert.equal(leaveRangeTouchesVisiblePeriod('2026-08-20', '2026-08-22', '2026-08-15'), true);
        assert.equal(
            isLeaveEntryVisible(
                { employeeMongoId: 'emp-1', date: '2026-08-14' },
                new Map([['emp-1', '2026-08-15']]),
                new Map(),
            ),
            false,
        );
        assert.equal(
            isLeaveEntryVisible(
                { employeeMongoId: 'emp-1', date: '2026-08-15' },
                new Map([['emp-1', '2026-08-15']]),
                new Map(),
            ),
            true,
        );
    });

    it('hides unenrolled employees and their leave ranges', () => {
        const visibility = new Map([['emp-1', '2026-08-15']]);
        assert.equal(isEmployeeLeaveDateVisible('emp-1', '2026-08-14', visibility), false);
        assert.equal(isEmployeeLeaveDateVisible('emp-1', '2026-08-15', visibility), true);
        assert.equal(isEmployeeLeaveDateVisible('emp-2', '2026-08-20', visibility), false);
        assert.equal(
            isEmployeeLeaveRangeVisible('emp-1', '2026-08-01', '2026-08-10', visibility),
            false,
        );
        assert.equal(
            isEmployeeLeaveRangeVisible('emp-1', '2026-08-10', '2026-08-16', visibility),
            true,
        );
        assert.equal(
            isEmployeeLeaveRangeVisible('missing', '2026-08-20', '2026-08-22', visibility),
            false,
        );
    });

    it('matches leave parties by employee HR id when mongo id is missing', () => {
        const byMongoId = new Map([['mongo-1', '2026-08-01']]);
        const byEmployeeId = new Map([['VEGA-HR-00001', '2026-08-01']]);
        assert.equal(
            isLeaveEntryVisible(
                { employeeMongoId: '', employeeId: 'VEGA-HR-00006', date: '2026-08-14' },
                byMongoId,
                byEmployeeId,
            ),
            false,
        );
        assert.equal(
            isLeaveEntryVisible(
                { employeeMongoId: '', employeeId: 'VEGA-HR-00001', date: '2026-08-14' },
                byMongoId,
                byEmployeeId,
            ),
            true,
        );
    });
});

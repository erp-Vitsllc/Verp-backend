import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { omitEnrollmentTaskDuplicates } from './pendingEnrollmentReminder.js';

describe('omitEnrollmentTaskDuplicates', () => {
    it('hides a task close notice that repeats the same pending enrolment', () => {
        const kept = omitEnrollmentTaskDuplicates(
            [
                {
                    requestType: 'Salary Enrollment',
                    subjectName: 'Adam Muhammad',
                    extra1: 'Adam Muhammad is pending for enrollment',
                },
            ],
            [
                {
                    requestType: 'Task Manager',
                    extra1: 'Adam Muhammad is pending for enrollment',
                    extra2: 'NESMI NESMI asked to close this task. This task is already on Pending.',
                },
                {
                    requestType: 'Task Manager',
                    extra1: 'October payroll waiting for approval',
                },
            ],
        );
        assert.deepEqual(
            kept.map((row) => row.extra1),
            ['October payroll waiting for approval'],
        );
    });
});

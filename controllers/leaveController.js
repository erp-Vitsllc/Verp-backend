import mongoose from 'mongoose';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';
import {
    isCompanyShellEmployee,
    REAL_EMPLOYEE_MONGO_FILTER,
} from '../utils/attendanceEmployeeFilters.js';
import {
    getScheduledEmailTimeZone,
    getZonedParts,
} from '../utils/scheduleDailyAtMidnight.js';

const LEAVE_COUNT_KEYS = [
    'authorized_leave',
    'unauthorized_leave',
    'sick_leave',
    'on_leave',
];

function employeeDisplayName(emp) {
    return [emp?.firstName, emp?.lastName].filter(Boolean).join(' ').trim();
}

/**
 * GET /api/Leave/employees
 * Active employees with current-year leave day counts from attendance.
 */
export async function getEmployeeLeaveDirectory(req, res) {
    try {
        if (mongoose.connection.readyState !== 1) {
            return res.status(503).json({ message: 'Database not connected.' });
        }

        const dubai = getZonedParts(new Date(), getScheduledEmailTimeZone());
        const requestedYear = Number(req.query.year);
        const year =
            Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
                ? requestedYear
                : dubai.year;
        const from = `${year}-01-01`;
        const to = `${year}-12-31`;

        const rows = await EmployeeBasic.find({
            profileStatus: 'active',
            status: { $ne: 'Left User' },
            employeeId: { $ne: 'VEGA-HR-0000' },
            ...REAL_EMPLOYEE_MONGO_FILTER,
        })
            .select('_id employeeId firstName lastName staffType')
            .sort({ firstName: 1, lastName: 1 })
            .lean()
            .maxTimeMS(12000);

        const employees = (rows || []).filter((e) => !isCompanyShellEmployee(e));
        const mongoIds = employees.map((e) => String(e._id));

        const grouped =
            mongoIds.length === 0
                ? []
                : await Attendance.aggregate([
                      {
                          $match: {
                              employeeMongoId: { $in: mongoIds },
                              date: { $gte: from, $lte: to },
                              statusKey: { $in: LEAVE_COUNT_KEYS },
                          },
                      },
                      {
                          $group: {
                              _id: {
                                  employeeMongoId: '$employeeMongoId',
                                  statusKey: '$statusKey',
                              },
                              count: { $sum: 1 },
                          },
                      },
                  ]);

        const countsByEmp = {};
        for (const row of grouped) {
            const id = String(row?._id?.employeeMongoId || '');
            const key = String(row?._id?.statusKey || '').trim();
            if (!id || !LEAVE_COUNT_KEYS.includes(key)) continue;
            if (!countsByEmp[id]) countsByEmp[id] = {};
            countsByEmp[id][key] = Number(row.count) || 0;
        }

        const list = employees.map((emp) => {
            const counts = countsByEmp[String(emp._id)] || {};
            const staffType =
                String(emp.staffType || '').trim().toLowerCase() === 'site' ? 'site' : 'office';
            return {
                _id: String(emp._id),
                employeeId: emp.employeeId || '',
                employeeName: employeeDisplayName(emp),
                staffType,
                authorizedLeave: counts.authorized_leave || 0,
                unauthorizedLeave: counts.unauthorized_leave || 0,
                sickLeave: counts.sick_leave || 0,
                annualLeaveTaken: counts.on_leave || 0,
            };
        });

        return res.status(200).json({
            message: 'Employee leave directory fetched successfully',
            year,
            from,
            to,
            count: list.length,
            employees: list,
        });
    } catch (error) {
        console.error('[getEmployeeLeaveDirectory]', error);
        return res.status(500).json({
            message: error.message || 'Failed to fetch employee leave directory.',
        });
    }
}

import Holiday from '../models/Holiday.js';
import Attendance from '../models/Attendance.js';
import EmployeeBasic from '../models/EmployeeBasic.js';

function isValidDateKey(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * GET /api/Holiday?year=2026
 * List holidays (optionally filtered by year).
 */
export async function listHolidays(req, res) {
    try {
        const yearRaw = req.query.year;
        const filter = {};
        if (yearRaw != null && String(yearRaw).trim() !== '') {
            const year = Number(yearRaw);
            if (!Number.isFinite(year)) {
                return res.status(400).json({ message: 'Valid year is required.' });
            }
            filter.year = year;
        }

        const holidays = await Holiday.find(filter).sort({ date: 1 }).lean();
        return res.status(200).json({
            message: 'Holidays fetched successfully',
            holidays,
            dates: holidays.map((h) => h.date),
        });
    } catch (error) {
        console.error('[listHolidays]', error);
        return res.status(500).json({ message: error.message || 'Failed to fetch holidays.' });
    }
}

/**
 * POST /api/Holiday
 * Body: { date: yyyy-MM-dd, name: string }
 * Saves holiday and marks that date as Holiday on all active employees' attendance.
 */
export async function createHoliday(req, res) {
    try {
        const date = String(req.body?.date || '').trim();
        const name = String(req.body?.name || '').trim();

        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }
        if (!name) {
            return res.status(400).json({ message: 'Holiday name is required.' });
        }

        const year = Number(date.slice(0, 4));
        const existing = await Holiday.findOne({ date }).lean();
        if (existing) {
            return res.status(400).json({
                message: 'This holiday date is already added.',
                holiday: existing,
            });
        }

        const holiday = await Holiday.create({
            date,
            name,
            year,
            addedBy: req.user?.id || null,
            note: String(req.body?.note || '').trim(),
        });

        // Mark attendance calendar for all active employees on this date
        const activeEmployees = await EmployeeBasic.find({ profileStatus: 'active' })
            .select('_id employeeId firstName lastName')
            .lean();

        let markedCount = 0;
        for (const emp of activeEmployees) {
            const employeeMongoId = String(emp._id);
            const employeeName = [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim();
            await Attendance.findOneAndUpdate(
                { date, employeeMongoId },
                {
                    $set: {
                        date,
                        employeeMongoId,
                        employeeId: String(emp.employeeId || ''),
                        employeeName,
                        statusKey: 'holiday',
                        statusLabel: 'Holiday',
                        reason: name,
                        markedBy: req.user?.id || null,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true },
            );
            markedCount += 1;
        }

        return res.status(201).json({
            message: 'Holiday added and marked on attendance calendar.',
            holiday,
            markedCount,
        });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(400).json({ message: 'This holiday date is already added.' });
        }
        console.error('[createHoliday]', error);
        return res.status(500).json({ message: error.message || 'Failed to add holiday.' });
    }
}

/**
 * DELETE /api/Holiday/:date
 * Remove holiday definition (does not wipe historical attendance marks).
 */
export async function deleteHoliday(req, res) {
    try {
        const date = String(req.params.date || '').trim();
        if (!isValidDateKey(date)) {
            return res.status(400).json({ message: 'Valid date (yyyy-MM-dd) is required.' });
        }

        const deleted = await Holiday.findOneAndDelete({ date });
        if (!deleted) {
            return res.status(404).json({ message: 'Holiday not found.' });
        }

        return res.status(200).json({
            message: 'Holiday removed.',
            holiday: deleted,
        });
    } catch (error) {
        console.error('[deleteHoliday]', error);
        return res.status(500).json({ message: error.message || 'Failed to delete holiday.' });
    }
}

import EmployeeBasic from '../../models/EmployeeBasic.js';
import { isJwtSystemSuperUser } from '../../utils/systemSuperUser.js';

function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

export async function setAttendanceSuspension(req, res) {
    try {
        if (!isJwtSystemSuperUser(req.user)) {
            return res.status(403).json({ message: 'Only the portal super user can change attendance suspension.' });
        }
        const employee = await EmployeeBasic.findById(req.params.id);
        if (!employee) return res.status(404).json({ message: 'Employee not found.' });

        const action = String(req.body?.action || '').trim().toLowerCase();
        if (action === 'activate') {
            employee.attendanceAccountStatus = 'active';
            employee.attendanceSuspension = {
                mode: '',
                fromDate: '',
                untilDate: '',
                description: '',
                suspendedAt: null,
                suspendedByName: '',
            };
            await employee.save();
            return res.json({
                message: 'Attendance is active.',
                attendanceAccountStatus: 'active',
                attendanceSuspension: employee.attendanceSuspension,
            });
        }

        const mode = String(req.body?.mode || 'range').trim().toLowerCase() === 'permanent'
            ? 'permanent'
            : 'range';
        const fromDate = mode === 'permanent' ? '' : String(req.body?.fromDate || '').trim();
        const untilDate = mode === 'permanent' ? '' : String(req.body?.untilDate || '').trim();
        const description = String(req.body?.description || '').trim();
        if (mode === 'range' && (!isDateKey(fromDate) || !isDateKey(untilDate) || untilDate < fromDate)) {
            return res.status(400).json({ message: 'Choose a from date and an until date.' });
        }
        if (description.length < 3) {
            return res.status(400).json({ message: 'Enter a description before suspending attendance.' });
        }

        employee.attendanceAccountStatus = 'suspended';
        employee.attendanceSuspension = {
            mode,
            fromDate,
            untilDate,
            description,
            suspendedAt: new Date(),
            suspendedByName: String(req.user?.name || req.user?.username || 'Super User').trim(),
        };
        await employee.save();
        return res.json({
            message: 'Attendance suspended.',
            attendanceAccountStatus: 'suspended',
            attendanceSuspension: employee.attendanceSuspension,
        });
    } catch (error) {
        return res.status(500).json({ message: error.message || 'Failed to update attendance suspension.' });
    }
}

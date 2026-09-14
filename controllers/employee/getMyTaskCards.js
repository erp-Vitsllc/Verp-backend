import EmployeeHubRequest from '../../models/EmployeeHubRequest.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';

async function resolveSelf(req) {
  if (req.user?.employeeObjectId) {
    const byOid = await EmployeeBasic.findById(req.user.employeeObjectId).select('_id').lean();
    if (byOid) return byOid;
  }
  if (req.user?.employeeId) {
    return EmployeeBasic.findOne({ employeeId: req.user.employeeId }).select('_id').lean();
  }
  return null;
}

/**
 * Task counts from real EmployeeHubRequest rows scoped to the signed-in employee.
 * @route GET /api/Employee/dashboard/my-task-cards
 */
export async function getMyTaskCards(req, res) {
  try {
    const self = await resolveSelf(req);
    const empty = { pending: 0, newTasks: 0, overdue: 0, completed: 0 };
    if (!self?._id) {
      return res.status(200).json(empty);
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const scope = { $or: [{ requester: self._id }, { assignedTo: self._id }] };

    const [pending, newTasks, overdue, completed] = await Promise.all([
      EmployeeHubRequest.countDocuments({ ...scope, status: 'Pending' }),
      EmployeeHubRequest.countDocuments({
        ...scope,
        status: 'Pending',
        createdAt: { $gte: weekAgo },
      }),
      EmployeeHubRequest.countDocuments({
        ...scope,
        status: 'Pending',
        createdAt: { $lt: weekAgo },
      }),
      EmployeeHubRequest.countDocuments({ ...scope, status: 'Approved' }),
    ]);

    return res.status(200).json({ pending, newTasks, overdue, completed });
  } catch (error) {
    console.error('[getMyTaskCards]', error);
    return res.status(500).json({ message: 'Failed to load task summary.' });
  }
}

import DashboardAction from "../models/DashboardAction.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Synchronize a request with the DashboardAction collection.
 * This ensures the current person responsible for an action sees it in their dashboard.
 * 
 * @param {Object} data - The action data
 * @param {String} data.requestId - ID of the source request (Loan, Reward, etc)
 * @param {String} data.requestType - Type of request
 * @param {String} data.assignedTo - ObjectId of the employee who needs to action it
 * @param {String} data.status - 'Pending', 'Approved', 'Rejected'
 * @param {Object} data.subjectEmployee - The employee record the request is about
 * @param {String} data.extra1 - Dashboard metadata
 * @param {String} data.extra2 - Dashboard metadata
 */
export const syncDashboardAction = async (data) => {
    try {
        const { requestId, requestType, assignedTo, status, subjectEmployee, extra1, extra2, actionedBy, comment } = data;

        // 1. If status is NOT pending, find and update any existing pending actions for this request
        if (status !== 'Pending') {
            const query = { requestId: requestId, status: 'Pending' };
            // NEW: If assignedTo is provided for a non-pending status, only clear THAT person's action.
            // This is critical for parallel workflows (Reward) where one person acting shouldn't clear everyone.
            if (assignedTo) {
                query.assignedTo = assignedTo;
            }

            await DashboardAction.updateMany(
                query,
                {
                    status: status,
                    actionedDate: new Date(),
                    actionedBy: actionedBy,
                    comment: comment
                }
            );

            // If it's fully completed and no next step, we stop here.
            // But usually, an action's completion triggers a NEW pending action for the next person.
            // That would be a separate call to syncDashboardAction with the new 'assignedTo'.
            return;
        }

        // 2. If status IS Pending, we ensure there is a record for the assignedTo user
        if (!assignedTo) return;

        // Get the assignedTo employee's custom ID for faster fetching if needed
        const assignee = await EmployeeBasic.findById(assignedTo).select('employeeId');

        // Upsert the pending action
        // We use requestId + assignedTo as the unique key for a PENDING item
        // because one request might go through multiple people, but only one is active at a time for that user.
        await DashboardAction.findOneAndUpdate(
            { requestId: requestId, assignedTo: assignedTo, status: 'Pending' },
            {
                assignedToEmpId: assignee?.employeeId,
                requestType: requestType,
                status: 'Pending',
                subjectEmployeeId: subjectEmployee?.employeeId,
                subjectName: subjectEmployee ? `${subjectEmployee.firstName} ${subjectEmployee.lastName}` : '',
                requestedDate: new Date(),
                extra1: extra1,
                extra2: extra2
            },
            { upsert: true, new: true }
        );

    } catch (error) {
        console.error(`[syncDashboardAction] Failed to sync ${data.requestType}:`, error);
    }
};

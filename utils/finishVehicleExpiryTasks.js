import DashboardAction from '../models/DashboardAction.js';
import TaskManagerTask from '../models/TaskManagerTask.js';

export function mongoIdList(values) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = String(value || '').trim();
        if (!/^[a-fA-F0-9]{24}$/.test(text) || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

/**
 * A renewed or not-renewed document closes the expiry task and its notices.
 * The Vehicle pending bell reads those rows, so leaving the task open keeps the reminder.
 */
export async function finishTasksForRemovedExpiryActions(actionIds = []) {
    const ids = mongoIdList(actionIds);
    if (!ids.length) return;

    const tasks = await TaskManagerTask.find({
        sourceDashboardActionId: { $in: ids },
        status: { $nin: ['Completed', 'Cancelled'] },
    })
        .select('_id closeRequest.reassignmentNotices')
        .lean();

    const now = new Date();
    if (tasks.length) {
        await TaskManagerTask.updateMany(
            { _id: { $in: tasks.map((task) => task._id) } },
            {
                $set: { status: 'Completed' },
                $push: {
                    history: {
                        event: 'Completed',
                        detail: 'The document was renewed or marked not renewed, so this expiry reminder is finished.',
                        actorName: 'System',
                        createdAt: now,
                    },
                },
            },
        );
    }

    const noticeRequestIds = mongoIdList(
        tasks.flatMap((task) =>
            (task?.closeRequest?.reassignmentNotices || []).map((notice) => notice?.requestId),
        ),
    );
    if (noticeRequestIds.length) {
        await DashboardAction.updateMany(
            { requestId: { $in: noticeRequestIds }, requestType: 'Task Manager', status: 'Pending' },
            { $set: { status: 'Dismissed', actionedDate: now } },
        );
    }

    const needles = [
        ...new Set([...ids, ...tasks.map((task) => String(task._id || '')).filter(Boolean)]),
    ];
    if (!needles.length) return;
    await DashboardAction.updateMany(
        {
            requestType: 'Task Manager',
            status: 'Pending',
            $or: needles.map((id) => ({ extra3: { $regex: id } })),
        },
        { $set: { status: 'Dismissed', actionedDate: now } },
    );
}

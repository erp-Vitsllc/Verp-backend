const LEAVE_TAKEN_DEDUCTION_NAMES = new Set([
    'authorized leave',
    'unauthorized leave',
    'sick leave',
    'annual leave',
    'comp off leave',
    'comp-off leave',
    'compoff leave',
]);

const LATE_DEDUCTION_NAMES = new Set(['late arrival', 'late in', 'late out']);

function deductionNameKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
}

export function normalizeEmployeeIdList(value) {
    const items = Array.isArray(value) ? value : value ? [value] : [];
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const id = String(item || '').trim();
        if (!id) continue;
        const key = id.replace(/\s+/g, '').toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(id);
    }
    return out;
}

export function mergeEmployeeIdLists(...lists) {
    return normalizeEmployeeIdList(lists.flatMap((list) => (Array.isArray(list) ? list : [])));
}

export function employeeIdInList(employeeId, list) {
    const id = String(employeeId || '').trim();
    if (!id) return false;
    const key = id.replace(/\s+/g, '').toUpperCase();
    return normalizeEmployeeIdList(list).some(
        (item) => item.replace(/\s+/g, '').toUpperCase() === key,
    );
}

export function salarySlipPolicyExclusions(employeeId, policy) {
    return {
        attendance: employeeIdInList(employeeId, policy?.attendanceExclusionEmployeeIds),
        leave: employeeIdInList(employeeId, policy?.leaveExclusionEmployeeIds),
    };
}

export function shouldHideSalarySlipDeduction(name, exclusions = {}) {
    const key = deductionNameKey(name);
    if (!key) return false;
    const isLeaveTaken = LEAVE_TAKEN_DEDUCTION_NAMES.has(key);
    const isLate = LATE_DEDUCTION_NAMES.has(key) || key.startsWith('late ');
    if (exclusions.attendance && (isLeaveTaken || isLate)) return true;
    if (exclusions.leave && isLeaveTaken) return true;
    return false;
}

export function shouldHideSalarySlipEarning(name, exclusions = {}) {
    if (!exclusions?.attendance) return false;
    return /^overtime\b/i.test(String(name || '').trim());
}

export function applySalarySlipCountExclusions(counts = {}, exclusions = {}) {
    const next = { ...counts };
    if (exclusions.leave || exclusions.attendance) {
        next.workingDayLeaves = 0;
        next.authorizedDays = 0;
        next.unauthorizedDays = 0;
        next.sickDays = 0;
        next.unpaidSickDays = 0;
        next.annualDays = 0;
        next.compOffDays = 0;
    }
    if (exclusions.attendance) {
        next.lateEvents = 0;
        next.holidaysWorked = 0;
        next.otHours = 0;
        next.otDays = 0;
    }
    return next;
}

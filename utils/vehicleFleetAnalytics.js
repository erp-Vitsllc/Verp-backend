const REPLACEMENT_AGE_YEARS = 10;

function stNorm(s) {
    return String(s || '').toLowerCase().trim();
}

function vehicleAgeYears(modelYear, asOfYear = new Date().getFullYear()) {
    const y = parseInt(modelYear, 10);
    if (!Number.isFinite(y) || y < 1980) return null;
    return Math.max(0, asOfYear - y);
}

function classLabel(v) {
    const brand = String(v.vehicleBrand || '').trim();
    if (brand) return brand;
    const type = String(v.typeId?.name || '').trim();
    if (type) return type;
    return 'Other';
}

function departmentLabel(v) {
    const emirate = String(v.plateEmirate || '').trim();
    if (emirate) return emirate;
    if (v.assignedCompany?.name) return String(v.assignedCompany.name).trim();
    if (v.assignedCompany?.companyShortName) return String(v.assignedCompany.companyShortName).trim();
    return 'Unassigned';
}

function isDisposed(v) {
    const disp = stNorm(v.vehicleDispositionStatus);
    return disp === 'sold' || disp === 'total_loss' || disp === 'total loss';
}

function isUnderRepair(v) {
    const st = stNorm(v.status);
    return (
        v.onServiceActive === true ||
        ['service', 'on service', 'maintenance', 'online'].includes(st)
    );
}

function isWaiting(v) {
    return Boolean(String(v.pendingAction || '').trim());
}

/**
 * Fleet analytics payload for the vehicle dashboard (reference layout).
 */
export function buildVehicleFleetAnalytics(vehicles = []) {
    const list = Array.isArray(vehicles) ? vehicles.filter((v) => v && !isDisposed(v)) : [];
    const total = list.length;
    const currentYear = new Date().getFullYear();

    let available = 0;
    let availableNotNeeded = 0;
    let underRepair = 0;
    let waitingParts = 0;

    const classCounts = {};
    const departmentCounts = {};
    const departmentAges = {};

    const replacementYearMap = {};
    const replacementCostYearMap = {};
    for (let i = 0; i < 5; i++) {
        const y = String(currentYear + i);
        replacementYearMap[y] = { year: y, overdue: 0, onTime: 0 };
        replacementCostYearMap[y] = { year: y, overdue: 0, onTime: 0 };
    }

    for (const v of list) {
        const cls = classLabel(v);
        classCounts[cls] = (classCounts[cls] || 0) + 1;

        const dept = departmentLabel(v);
        departmentCounts[dept] = (departmentCounts[dept] || 0) + 1;

        const age = vehicleAgeYears(v.modelYear, currentYear);
        if (age != null) {
            if (!departmentAges[dept]) departmentAges[dept] = [];
            departmentAges[dept].push(age);
        }

        if (v.onLeaveActive === true) {
            availableNotNeeded++;
            continue;
        }
        if (isUnderRepair(v)) {
            underRepair++;
            continue;
        }
        if (isWaiting(v)) {
            waitingParts++;
            continue;
        }
        available++;
    }

    const availabilityPercent = total ? Math.round((available / total) * 100) : 0;

    const assetsByClass = Object.entries(classCounts)
        .map(([name, count]) => ({
            name,
            count,
            percent: total ? Math.round((count / total) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

    const assetsByDepartment = Object.entries(departmentCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

    for (const v of list) {
        const modelY = parseInt(v.modelYear, 10);
        if (!Number.isFinite(modelY)) continue;
        const dueYear = modelY + REPLACEMENT_AGE_YEARS;
        const value = Number(v.assetValue || 0);
        const overdue = dueYear < currentYear;
        const cappedYear = overdue
            ? String(currentYear)
            : String(Math.min(dueYear, currentYear + 4));
        if (!replacementYearMap[cappedYear]) {
            replacementYearMap[cappedYear] = { year: cappedYear, overdue: 0, onTime: 0 };
            replacementCostYearMap[cappedYear] = { year: cappedYear, overdue: 0, onTime: 0 };
        }
        if (overdue) {
            replacementYearMap[cappedYear].overdue += 1;
            replacementCostYearMap[cappedYear].overdue += value;
        } else {
            replacementYearMap[cappedYear].onTime += 1;
            replacementCostYearMap[cappedYear].onTime += value;
        }
    }

    const replacementYears = Object.keys(replacementYearMap)
        .sort()
        .map((k) => replacementYearMap[k]);
    const replacementCostYears = Object.keys(replacementCostYearMap)
        .sort()
        .map((k) => ({
            year: k,
            overdue: Math.round(replacementCostYearMap[k].overdue),
            onTime: Math.round(replacementCostYearMap[k].onTime),
        }));

    const averageAgeByDepartment = Object.entries(departmentAges)
        .map(([name, ages]) => {
            if (!ages.length) return null;
            const sorted = [...ages].sort((a, b) => a - b);
            const mean = ages.reduce((s, n) => s + n, 0) / ages.length;
            const mid = Math.floor(sorted.length / 2);
            const median =
                sorted.length % 2 === 0
                    ? (sorted[mid - 1] + sorted[mid]) / 2
                    : sorted[mid];
            return {
                name,
                meanAge: Math.round(mean * 100) / 100,
                medianAge: Math.round(median * 100) / 100,
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.meanAge - a.meanAge)
        .slice(0, 8);

    return {
        availabilityPercent,
        assetStatus: {
            available,
            availableNotNeeded,
            underRepair,
            waitingParts,
            total,
        },
        assetsByClass,
        assetsByDepartment,
        replacementByYear: replacementYears,
        replacementCostByYear: replacementCostYears,
        averageAgeByDepartment,
    };
}

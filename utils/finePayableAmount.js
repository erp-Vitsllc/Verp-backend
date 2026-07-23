function isCompanyParty(emp) {
    if (!emp) return false;
    const id = emp.employeeId;
    const name = String(emp.employeeName || '').trim();
    return id === 'VEGA-HR-0000' || id === 'VEGA_INTERNAL' || name === 'Vega Digital IT Solutions';
}

export function resolvePartyServiceShare(fine, entry, isCompanyPartyFlag = false) {
    const perRecord = parseFloat(entry?.serviceCharge ?? 0) || 0;
    if (perRecord > 0) return perRecord;

    const totalSc = parseFloat(fine?.serviceCharge || 0) || 0;
    const rf = (fine?.responsibleFor || 'Employee').trim();
    if (rf !== 'Employee & Company' || totalSc <= 0) {
        return isCompanyPartyFlag ? 0 : totalSc;
    }
    if (fine?.isGroupView || (fine?.assignedEmployees?.length || 0) > 1) {
        return totalSc / 2;
    }
    const comp = parseFloat(fine?.companyAmount || 0) || 0;
    const hasVega = fine?.assignedEmployees?.some((e) => e.employeeId === 'VEGA-HR-0000');
    if (hasVega || comp > 0) return totalSc / 2;
    return totalSc;
}

function resolveRowBaseAmount(fine, entry, isCompanyPartyFlag) {
    let base = parseFloat(
        entry?.employeeAmount ??
        (isCompanyPartyFlag ? fine?.companyAmount : fine?.employeeAmount) ??
        0,
    ) || 0;
    const totalSc = parseFloat(fine?.serviceCharge || 0) || 0;
    if (base < 0 && totalSc > 0) base += totalSc;
    return Math.max(0, base);
}

/** Employee payable = fine base + service charge (counted once). */
export function resolveEmployeeFinePayableAmount(fine, employeeId) {
    if (!fine || !employeeId) return 0;
    if ((fine.responsibleFor || '').toLowerCase() === 'company') return 0;

    const entry = (fine.assignedEmployees || []).find(
        (ae) => ae.employeeId === employeeId && ae.employeeId !== 'VEGA-HR-0000',
    );
    if (!entry) return 0;

    const rowBase = resolveRowBaseAmount(fine, entry, false);
    const sc = resolvePartyServiceShare(fine, entry, false);
    const expected = Number((rowBase + sc).toFixed(2));

    if (entry.individualAmount != null && entry.individualAmount !== '') {
        const stored = parseFloat(entry.individualAmount) || 0;
        if (stored > 0) {
            // Stored total missing service charge → top up
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) return expected;
            return stored;
        }
    }
    if (entry.fineAmount != null && entry.fineAmount !== '') {
        const stored = parseFloat(entry.fineAmount) || 0;
        if (stored > 0) {
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) return expected;
            if (sc > 0 && Math.abs(stored - rowBase) < 0.01) return expected;
            return stored;
        }
    }

    if (expected > 0) return expected;

    const companyAmount = parseFloat(fine.companyAmount || 0) || 0;
    const fineAmount = parseFloat(fine.fineAmount || fine.totalFineAmount || 0) || 0;
    const humanAssignees = (fine.assignedEmployees || []).filter(
        (ae) => ae.employeeId && ae.employeeId !== 'VEGA-HR-0000' && ae.employeeId !== 'PENDING',
    );

    if (humanAssignees.length <= 1 && companyAmount === 0 && fineAmount > 0) {
        const totalSc = parseFloat(fine.serviceCharge || 0) || 0;
        if (totalSc > 0 && fineAmount < rowBase + totalSc - 0.01 && rowBase > 0) {
            return Number((rowBase + totalSc).toFixed(2));
        }
        return fineAmount;
    }

    return 0;
}

export function resolveCompanyFinePayableAmount(fine, companyEntry = null) {
    if (!fine) return 0;

    const entry =
        companyEntry ||
        (fine.assignedEmployees || []).find(isCompanyParty) ||
        (fine.assignedEmployees || []).find((e) => e.employeeId === 'VEGA-HR-0000');

    const rowBase = resolveRowBaseAmount(fine, entry, true);
    const sc = resolvePartyServiceShare(fine, entry, true);
    const expected = Number((rowBase + sc).toFixed(2));

    if (entry?.individualAmount != null && entry.individualAmount !== '') {
        const stored = parseFloat(entry.individualAmount) || 0;
        if (stored > 0) {
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) return expected;
            return stored;
        }
    }
    if (entry?.fineAmount != null && entry.fineAmount !== '') {
        const stored = parseFloat(entry.fineAmount) || 0;
        if (stored > 0) {
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) return expected;
            if (sc > 0 && Math.abs(stored - rowBase) < 0.01) return expected;
            return stored;
        }
    }

    if (expected > 0) return expected;

    const rf = (fine.responsibleFor || '').trim();
    if (rf === 'Company') {
        const fineAmount = parseFloat(fine.fineAmount || fine.totalFineAmount || 0) || 0;
        if (fineAmount > 0) return fineAmount;
    }

    return 0;
}

/** Resolve employee id from fine when only one human assignee exists. */
export function resolvePrimaryEmployeeId(fine) {
    const human = (fine?.assignedEmployees || []).find(
        (ae) =>
            ae?.employeeId &&
            ae.employeeId !== 'VEGA-HR-0000' &&
            ae.employeeId !== 'VEGA_INTERNAL' &&
            ae.employeeId !== 'PENDING',
    );
    return human?.employeeId || null;
}

/**
 * On approval, persist per-party payable totals (base + service charge once)
 * and sync record-level fineAmount / totalFineAmount.
 */
export function syncFinePartyPayableAmounts(fine) {
    if (!fine) return fine;

    const empAmt = parseFloat(fine.employeeAmount || 0) || 0;
    const compAmt = parseFloat(fine.companyAmount || 0) || 0;
    const servCharge = parseFloat(fine.serviceCharge || 0) || 0;
    const combined = empAmt + compAmt + servCharge;

    if (combined > 0) {
        fine.totalFineAmount = combined;
        fine.fineAmount = combined;
    }

    (fine.assignedEmployees || []).forEach((entry) => {
        if (!entry?.employeeId || entry.employeeId === 'PENDING') return;

        const payable = isCompanyParty(entry)
            ? resolveCompanyFinePayableAmount(fine, entry)
            : resolveEmployeeFinePayableAmount(fine, entry.employeeId);

        if (payable > 0) {
            entry.individualAmount = payable;
        }
    });

    return fine;
}

function fineBaseId(fineId) {
    const id = String(fineId || '').trim().toUpperCase();
    const match = id.match(/^(VEGA-FINE-\d+)/i);
    return match ? match[1].toUpperCase() : id;
}

function partyDedupeScore(fine, employeeId) {
    let score = 0;
    const fid = String(fine.fineId || '').trim().toUpperCase();
    if (/VEGA-FINE-\d+-[A-Z0-9]+$/i.test(fid)) score += 100;
    const entry = fine.assignedEmployees?.find((ae) => ae.employeeId === employeeId);
    if (entry?.individualAmount != null && parseFloat(entry.individualAmount) > 0) score += 25;
    if (!/VEGA-FINE-\d+-[A-Z0-9]+$/i.test(fid)) score -= 10;
    return score;
}

export function dedupeEmployeeFinesByParty(fines, employeeId) {
    const byParty = new Map();
    fines.forEach((fine) => {
        if (!fine.assignedEmployees?.some((ae) => ae.employeeId === employeeId)) return;
        const base = fineBaseId(fine.fineId);
        if (!base) return;
        const key = `${base}:${employeeId}`;
        const existing = byParty.get(key);
        if (!existing || partyDedupeScore(fine, employeeId) > partyDedupeScore(existing, employeeId)) {
            byParty.set(key, fine);
        }
    });
    return [...byParty.values()];
}

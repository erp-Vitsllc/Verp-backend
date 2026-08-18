function isCompanyParty(emp) {
    if (!emp) return false;
    const id = emp.employeeId;
    const name = String(emp.employeeName || '').trim();
    return id === 'VEGA-HR-0000' || id === 'VEGA_INTERNAL' || name === 'Vega Digital IT Solutions';
}

/**
 * One party's share of service charge.
 * Split sibling records already store this party's share on fine.serviceCharge — do not halve again.
 */
export function resolvePartyServiceShare(fine, entry, isCompanyPartyFlag = false) {
    const perRecord = parseFloat(entry?.serviceCharge ?? 0) || 0;
    if (perRecord > 0) return perRecord;

    const totalSc = parseFloat(fine?.serviceCharge || 0) || 0;
    if (totalSc <= 0) return 0;

    const rf = (fine?.responsibleFor || 'Employee').trim();
    const assignees = (fine?.assignedEmployees || []).filter(
        (ae) => ae?.employeeId && ae.employeeId !== 'PENDING',
    );
    const partyCount = assignees.length;

    if (rf === 'Company') {
        return isCompanyPartyFlag ? totalSc : 0;
    }
    if (rf !== 'Employee & Company') {
        return isCompanyPartyFlag ? 0 : totalSc;
    }

    // Employee & Company — sibling docs: root SC is already this party's share
    if (!fine?.isGroupView && partyCount <= 1) {
        return totalSc;
    }

    // Group / multi-party document: divide full SC equally among parties
    const n = Math.max(partyCount, 2);
    return totalSc / n;
}

/** Net payable = employee + company bases + service charge − discount. */
export function resolveFineNetTotal(fine) {
    if (!fine) return 0;

    const emp = parseFloat(fine.employeeAmount || 0) || 0;
    const comp = parseFloat(fine.companyAmount || 0) || 0;
    const sc = parseFloat(fine.serviceCharge || 0) || 0;
    const discount = parseFloat(fine.discount || 0) || 0;
    const gross = emp + comp + sc;
    const computed = Math.max(0, Number((gross - discount).toFixed(2)));
    const stored = parseFloat(fine.totalFineAmount ?? fine.fineAmount ?? 0) || 0;

    if (computed <= 0 && stored > 0) return stored;
    if (stored <= 0) return computed;

    // Stored matches pre-discount gross while a discount exists → use net total
    if (discount > 0 && Math.abs(stored - gross) < 0.02) return computed;
    if (discount > 0 && stored > computed + 0.01) return computed;

    return stored;
}

function resolveRowBaseAmount(fine, entry, isCompanyPartyFlag) {
    let base = parseFloat(entry?.employeeAmount) || 0;
    if (base <= 0) {
        if (isCompanyPartyFlag) {
            base = parseFloat(fine?.companyAmount) || 0;
            // Company sibling stores company base in employeeAmount (companyAmount is 0)
            if (base <= 0 && (fine?.assignedEmployees || []).length <= 1) {
                base = parseFloat(fine?.employeeAmount) || 0;
            }
        } else {
            base = parseFloat(fine?.employeeAmount) || 0;
        }
    }
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
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) {
                return applyEmployeeDiscountShare(fine, expected);
            }
            const netTotal = resolveFineNetTotal(fine);
            if (netTotal > 0 && stored > netTotal + 0.01) {
                return applyEmployeeDiscountShare(fine, expected);
            }
            return applyEmployeeDiscountShare(fine, Math.max(stored, expected > 0 ? expected : 0));
        }
    }
    if (entry.fineAmount != null && entry.fineAmount !== '') {
        const stored = parseFloat(entry.fineAmount) || 0;
        if (stored > 0) {
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) {
                return applyEmployeeDiscountShare(fine, expected);
            }
            if (sc > 0 && Math.abs(stored - rowBase) < 0.01) {
                return applyEmployeeDiscountShare(fine, expected);
            }
            const netTotal = resolveFineNetTotal(fine);
            if (netTotal > 0 && stored > netTotal + 0.01) {
                return applyEmployeeDiscountShare(fine, expected);
            }
            return applyEmployeeDiscountShare(fine, Math.max(stored, expected > 0 ? expected : 0));
        }
    }

    if (expected > 0) {
        return applyEmployeeDiscountShare(fine, expected);
    }

    const companyAmount = parseFloat(fine.companyAmount || 0) || 0;
    const fineAmount = resolveFineNetTotal(fine);
    const humanAssignees = (fine.assignedEmployees || []).filter(
        (ae) => ae.employeeId && ae.employeeId !== 'VEGA-HR-0000' && ae.employeeId !== 'PENDING',
    );

    if (humanAssignees.length <= 1 && companyAmount === 0 && fineAmount > 0) {
        return fineAmount;
    }

    return 0;
}

function applyEmployeeDiscountShare(fine, partyGross) {
    const netTotal = resolveFineNetTotal(fine);
    const rf = String(fine?.responsibleFor || 'Employee').trim();
    const emp = parseFloat(fine?.employeeAmount || 0) || 0;
    const comp = parseFloat(fine?.companyAmount || 0) || 0;
    const sc = parseFloat(fine?.serviceCharge || 0) || 0;
    const gross = emp + comp + sc;

    if (rf === 'Employee') return netTotal > 0 ? netTotal : partyGross;
    if (rf === 'Employee & Company' && gross > 0 && netTotal >= 0) {
        return Number((netTotal * (partyGross / gross)).toFixed(2));
    }
    return partyGross;
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
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) {
                return applyCompanyDiscountShare(fine, expected);
            }
            const netTotal = resolveFineNetTotal(fine);
            if (netTotal > 0 && stored > netTotal + 0.01) {
                return applyCompanyDiscountShare(fine, expected);
            }
            return applyCompanyDiscountShare(fine, Math.max(stored, expected > 0 ? expected : 0));
        }
    }
    if (entry?.fineAmount != null && entry.fineAmount !== '') {
        const stored = parseFloat(entry.fineAmount) || 0;
        if (stored > 0) {
            if (sc > 0 && rowBase > 0 && stored < expected - 0.01) {
                return applyCompanyDiscountShare(fine, expected);
            }
            if (sc > 0 && Math.abs(stored - rowBase) < 0.01) {
                return applyCompanyDiscountShare(fine, expected);
            }
            const netTotal = resolveFineNetTotal(fine);
            if (netTotal > 0 && stored > netTotal + 0.01) {
                return applyCompanyDiscountShare(fine, expected);
            }
            return applyCompanyDiscountShare(fine, Math.max(stored, expected > 0 ? expected : 0));
        }
    }

    if (expected > 0) {
        return applyCompanyDiscountShare(fine, expected);
    }

    const rf = (fine.responsibleFor || '').trim();
    if (rf === 'Company') {
        const fineAmount = resolveFineNetTotal(fine);
        if (fineAmount > 0) return fineAmount;
    }

    return 0;
}

function applyCompanyDiscountShare(fine, partyGross) {
    const netTotal = resolveFineNetTotal(fine);
    const rf = String(fine?.responsibleFor || 'Employee').trim();
    const emp = parseFloat(fine?.employeeAmount || 0) || 0;
    const comp = parseFloat(fine?.companyAmount || 0) || 0;
    const sc = parseFloat(fine?.serviceCharge || 0) || 0;
    const gross = emp + comp + sc;

    if (rf === 'Company') return netTotal > 0 ? netTotal : partyGross;
    if (rf === 'Employee & Company' && gross > 0 && netTotal >= 0) {
        return Number((netTotal * (partyGross / gross)).toFixed(2));
    }
    return partyGross;
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
    const discountAmt = parseFloat(fine.discount || 0) || 0;
    const combined = empAmt + compAmt + servCharge - discountAmt;

    if (combined > 0 || discountAmt > 0) {
        fine.totalFineAmount = Math.max(0, combined);
        fine.fineAmount = fine.totalFineAmount;
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

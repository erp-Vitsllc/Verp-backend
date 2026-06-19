export function isCompanyFineParty(emp) {
    if (!emp) return false;
    const id = emp.employeeId;
    const name = String(emp.employeeName || '').trim();
    return id === 'VEGA-HR-0000' || id === 'VEGA_INTERNAL' || name === 'Vega Digital IT Solutions';
}

export function isMultiPartyFine(fine) {
    if (!fine || typeof fine !== 'object') return false;

    const rf = String(fine.responsibleFor || '').trim();
    if (rf === 'Employee & Company' || rf === 'Both') return true;

    const assigned = Array.isArray(fine.assignedEmployees) ? fine.assignedEmployees : [];
    const parties = assigned.filter((e) => e?.employeeId || e?.employeeName);
    const companyParties = parties.filter(isCompanyFineParty);
    const employeeParties = parties.filter(
        (e) => !isCompanyFineParty(e) && e.employeeId && e.employeeId !== 'PENDING',
    );

    if (companyParties.length > 0 && employeeParties.length > 0) return true;
    if (employeeParties.length > 1) return true;

    const empAmt = parseFloat(fine.employeeAmount || 0) || 0;
    const compAmt = parseFloat(fine.companyAmount || 0) || 0;
    if (compAmt > 0 && employeeParties.length > 0) return true;
    if (compAmt > 0 && empAmt > 0 && rf !== 'Company') return true;

    return false;
}

function serviceChargeShare(fine, partyCount) {
    const sc = parseFloat(fine.serviceCharge || 0) || 0;
    if (partyCount <= 0) return 0;
    return sc / partyCount;
}

function resolvePartyBaseAmount(emp, fine, isCompany) {
    const fromRow = parseFloat(emp.employeeAmount ?? emp.fineAmount ?? 0);
    if (fromRow > 0) return fromRow;
    if (isCompany) return parseFloat(fine.companyAmount || 0) || 0;
    return parseFloat(fine.employeeAmount || 0) || 0;
}

/** Enrich a single multi-party fine document for group detail view. Mutates and returns fine. */
export function synthesizeSingleRecordGroupFineView(fine) {
    if (!fine || !isMultiPartyFine(fine)) return fine;

    const assigned = Array.isArray(fine.assignedEmployees) ? [...fine.assignedEmployees] : [];
    const rf = String(fine.responsibleFor || '').trim();
    const compBase = parseFloat(fine.companyAmount || 0) || 0;

    const hasCompanyEntry = assigned.some(isCompanyFineParty);
    const hasEmployeeEntry = assigned.some(
        (e) => !isCompanyFineParty(e) && e.employeeId && e.employeeId !== 'PENDING',
    );

    if (!hasCompanyEntry && compBase > 0 && (rf === 'Employee & Company' || rf === 'Company' || rf === 'Both')) {
        assigned.push({
            employeeId: 'VEGA-HR-0000',
            employeeName: fine.companyName || 'Vega Digital IT Solutions',
            employeeAmount: compBase,
            individualAmount: compBase,
        });
    }

    if (!hasEmployeeEntry && parseFloat(fine.employeeAmount || 0) > 0 && rf === 'Employee & Company') {
        assigned.unshift({
            employeeId: assigned[0]?.employeeId || '—',
            employeeName: assigned[0]?.employeeName || 'Employee',
            employeeAmount: parseFloat(fine.employeeAmount || 0),
            individualAmount: parseFloat(fine.employeeAmount || 0),
        });
    }

    if (assigned.length <= 1) return fine;

    const partyCount = assigned.length;
    const scShare = serviceChargeShare(fine, partyCount);

    fine.isGroupView = true;
    fine.assignedEmployees = assigned.map((e) => {
        const isCompany = isCompanyFineParty(e);
        const base = resolvePartyBaseAmount(e, fine, isCompany);
        const sc = parseFloat(e.serviceCharge || 0) || scShare;
        let individualAmt = parseFloat(e.individualAmount || 0);
        if (!individualAmt || individualAmt <= 0) individualAmt = base + sc;

        return {
            ...e,
            fineId: fine.fineId,
            fineStatus: fine.fineStatus,
            employeeAmount: base,
            fineAmount: base,
            individualAmount: individualAmt,
            serviceCharge: sc,
            payableDuration: e.payableDuration ?? fine.payableDuration,
        };
    });

    return fine;
}

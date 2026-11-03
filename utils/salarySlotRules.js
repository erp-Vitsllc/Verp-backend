export function slotStatusOf(row) {
    const status = String(row?.status || '').trim().toLowerCase();
    if (
        status === 'draft' ||
        status === 'pending_hr' ||
        status === 'pending_wps' ||
        status === 'pending_update' ||
        status === 'approved' ||
        status === 'rejected' ||
        status === 'cancelled'
    ) {
        return status;
    }
    return 'approved';
}

/** Draft, applied, rejected, and approved slots keep their employees for that month. */
export function slotHoldsEmployees(row) {
    return slotStatusOf(row) !== 'cancelled';
}

export function slotIsPaid(row) {
    return slotStatusOf(row) === 'approved';
}

function personKey(value) {
    return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

/**
 * Paid: every slot is updated (green) and every enrolled employee is in a slot.
 * Partially paid: at least one enrolled employee is in a green slot.
 * Not paid: nobody is in an updated slot.
 */
export function salaryMonthPaymentLabel({ enrolledIds = [], slots = [] } = {}) {
    const enrolled = [...new Set((enrolledIds || []).map(personKey).filter(Boolean))];
    const active = (slots || []).filter((row) => slotStatusOf(row) !== 'cancelled');
    const paidKeys = new Set();
    let allGreen = active.length > 0;
    for (const slot of active) {
        if (!slotIsPaid(slot)) {
            allGreen = false;
            continue;
        }
        for (const id of slot.employeeIds || slot.selectedIds || []) {
            const key = personKey(id);
            if (key) paidKeys.add(key);
        }
    }
    const paidCount = enrolled.filter((id) => paidKeys.has(id)).length;
    if (enrolled.length > 0 && allGreen && paidCount === enrolled.length) return 'Paid';
    if (paidCount > 0) return 'Partially paid';
    return 'Not paid';
}

export function normalizeSlotPayType(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (raw === 'WPS') return 'WPS';
    if (raw === 'CASH') return 'Cash';
    return '';
}

export function singleSlotPayType(types) {
    const unique = [
        ...new Set((types || []).map((type) => normalizeSlotPayType(type)).filter(Boolean)),
    ];
    if (unique.length > 1) {
        return {
            ok: false,
            method: '',
            message: 'A slot can include only WPS or only Cash employees.',
        };
    }
    return { ok: true, method: unique[0] || '', message: '' };
}

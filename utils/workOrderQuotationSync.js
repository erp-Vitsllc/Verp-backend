function norm(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function money(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 0;
    return Math.round(amount * 100) / 100;
}

function moneyText(value) {
    return money(value).toFixed(2);
}

function lineKey(lines) {
    return (Array.isArray(lines) ? lines : []).map((line) => [
        norm(line?.description),
        moneyText(line?.quantity),
        moneyText(line?.rate),
        moneyText(line?.amount),
    ].join('~')).join('\n');
}

export function snapshotFromEstimate(estimate, fallback = {}) {
    const captured = Boolean(estimate && typeof estimate === 'object' && estimate.number);
    return {
        number: norm(estimate?.number || fallback.quotationRef),
        id: norm(estimate?.id || fallback.quotationId),
        date: String(estimate?.date || fallback.quotationDate || '').slice(0, 10),
        customerName: norm(estimate?.customerName || fallback.customer),
        projectName: norm(estimate?.projectName),
        salespersonName: norm(estimate?.salespersonName || fallback.salespersonName),
        billTo: Array.isArray(estimate?.billTo) ? estimate.billTo.map(norm).filter(Boolean) : [],
        lines: Array.isArray(estimate?.lines) ? estimate.lines : [],
        linesCaptured: captured,
        taxLabel: norm(estimate?.taxLabel) || 'TAX',
        notes: String(estimate?.notes || ''),
        terms: String(estimate?.terms || ''),
        status: norm(estimate?.status),
        valueExclVat: money(estimate?.valueExclVat ?? fallback.valueExclVat),
        vatAmount: money(estimate?.vatAmount ?? fallback.vatAmount),
        total: money(estimate?.total ?? fallback.value),
        capturedAt: new Date().toISOString(),
    };
}

export function savedQuotation(order) {
    const snap = order?.quotationSnapshot;
    if (snap && typeof snap === 'object') return snap;
    return {
        number: norm(order?.quotationRef),
        id: norm(order?.quotationId),
        date: String(order?.quotationDate || '').slice(0, 10),
        customerName: norm(order?.customer),
        projectName: '',
        salespersonName: '',
        billTo: order?.customer ? [norm(order.customer)] : [],
        lines: [],
        linesCaptured: false,
        taxLabel: 'TAX',
        notes: '',
        terms: '',
        status: '',
        valueExclVat: money(order?.valueExclVat),
        vatAmount: money(order?.vatAmount),
        total: money(order?.value),
        capturedAt: '',
    };
}

export function quotationChanges(saved, live) {
    const changes = [];
    const text = (label, from, to) => {
        if (norm(from) === norm(to)) return;
        changes.push({ label, from: norm(from) || '—', to: norm(to) || '—' });
    };
    const amount = (label, from, to) => {
        if (money(from) === money(to)) return;
        changes.push({ label, from: moneyText(from), to: moneyText(to) });
    };

    text('Quotation number', saved?.number, live?.number);
    text('Quotation date', saved?.date, live?.date);
    text('Customer', saved?.customerName, live?.customerName);
    amount('Amount excl. VAT', saved?.valueExclVat, live?.valueExclVat);
    amount('VAT', saved?.vatAmount, live?.vatAmount);
    amount('Total', saved?.total, live?.total);

    if (saved?.linesCaptured) {
        text('Project', saved?.projectName, live?.projectName);
        text('Salesperson', saved?.salespersonName, live?.salespersonName);
        text('Status', saved?.status, live?.status);
        text('Notes', saved?.notes, live?.notes);
        text('Terms', saved?.terms, live?.terms);
        if (lineKey(saved?.lines) !== lineKey(live?.lines)) {
            const fromCount = Array.isArray(saved?.lines) ? saved.lines.length : 0;
            const toCount = Array.isArray(live?.lines) ? live.lines.length : 0;
            changes.push({
                label: 'Line items',
                from: fromCount === toCount ? 'Saved lines' : `${fromCount} line${fromCount === 1 ? '' : 's'}`,
                to: fromCount === toCount ? 'Updated in Zoho' : `${toCount} line${toCount === 1 ? '' : 's'}`,
            });
        }
    }

    return changes;
}

export function applyQuotationSnapshot(order, estimate) {
    const snap = snapshotFromEstimate(estimate, order);
    order.quotationSnapshot = snap;
    order.markModified?.('quotationSnapshot');
    if (snap.number) order.quotationRef = snap.number;
    if (snap.id) order.quotationId = snap.id;
    order.quotationDate = snap.date;
    order.valueExclVat = snap.valueExclVat;
    order.vatAmount = snap.vatAmount;
    order.value = snap.total;
    if (snap.customerName) order.customer = snap.customerName;
    let lpoAdjusted = false;
    if (Array.isArray(order.lpos) && order.lpos.length && snap.total > 0) {
        order.lpos.forEach((row) => {
            if (money(row.lpoValue) !== snap.total) {
                row.lpoValue = snap.total;
                lpoAdjusted = true;
            }
        });
        if (lpoAdjusted) order.markModified?.('lpos');
    }
    return { snapshot: snap, lpoAdjusted };
}

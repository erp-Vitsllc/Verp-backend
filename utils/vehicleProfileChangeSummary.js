const MONEY_KEYS = new Set([
    'assetValue',
    'fuelMonthlyLimit',
    'mortgageAmount',
    'loanAmount',
    'downPayment',
    'monthlyPayment',
    'balancePayment',
    'processCharge',
    'soldValue',
    'totalLossValue',
    'currentLoanAmount',
    'registrationExpense',
    'otherExpense',
    'balanceInHand',
]);

const ASSET_FIELD_LABELS = {
    name: 'Model',
    brand: 'Brand',
    modelYear: 'Model year',
    plateNumber: 'Plate number',
    plateEmirate: 'Emirate',
    assetValue: 'Purchase value',
    currentKilometer: 'Current KM',
    fuelMonthlyLimit: 'Monthly limit',
    mortgageBankName: 'Bank',
    mortgageBank: 'Bank',
    mortgageVehicleName: 'Vehicle name',
    mortgageAmount: 'Vehicle amount',
    loanAmount: 'Loan amount',
    interestRate: 'Interest',
    loanTenureMonths: 'Loan tenure (months)',
    mortgageStartDate: 'Start date',
    mortgageEndDate: 'End date',
    downPayment: 'Down payment',
    monthlyPayment: 'Monthly payment',
    balancePayment: 'Balance payment',
    processCharge: 'Process charge',
    soldValue: 'Sold value',
    totalLossValue: 'Total loss value',
    currentLoanAmount: 'Current loan',
    registrationExpense: 'Registration expense',
    otherExpense: 'Other expense',
    balanceInHand: 'Balance in hand',
};

const normChangeValue = (value) =>
    String(value ?? '')
        .replace(/[—–-]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase();

const formatStepValue = (key, value) => {
    if (value == null || value === '') return '—';
    if (MONEY_KEYS.has(key)) return `AED ${Number(value).toLocaleString()}`;
    if (key === 'currentKilometer') return Number(value).toLocaleString();
    if (key === 'interestRate') return `${Number(value)}%`;
    if (/date/i.test(key)) return String(value).slice(0, 10);
    return String(value);
};

const rowsFromStep = (step) => {
    if (!step || typeof step !== 'object') return [];
    if (step.op === 'delete_document') return [{ label: 'Document removed', value: 'Yes' }];
    const body = step.body;
    if (!body || typeof body !== 'object') return [];
    const rows = [];
    if (typeof body.description === 'string' && body.description.trim().startsWith('{')) {
        try {
            const meta = JSON.parse(body.description);
            if (meta?.company) rows.push({ label: 'Insurer', value: String(meta.company) });
            if (meta?.policy) rows.push({ label: 'Policy', value: String(meta.policy) });
            if (meta?.fee != null && meta.fee !== '') {
                rows.push({ label: 'Registration value', value: `AED ${Number(meta.fee).toLocaleString()}` });
            }
            if (meta?.premiumAmount != null && meta.premiumAmount !== '') {
                rows.push({
                    label: 'Premium amount',
                    value: `AED ${Number(meta.premiumAmount).toLocaleString()}`,
                });
            }
            if (meta?.excessCharge != null && meta.excessCharge !== '') {
                rows.push({ label: 'Excess charge', value: `AED ${Number(meta.excessCharge).toLocaleString()}` });
            }
        } catch {
            /* plain description */
        }
    } else if (body.description) {
        rows.push({ label: 'Description', value: String(body.description) });
    }
    const docType = String(body.type || '').toLowerCase();
    if (body.issueDate) {
        rows.push({
            label: docType.includes('registration') ? 'Registration date' : 'Start',
            value: String(body.issueDate).slice(0, 10),
        });
    }
    if (body.expiryDate) {
        rows.push({
            label: docType.includes('registration') ? 'Expiry' : 'End',
            value: String(body.expiryDate).slice(0, 10),
        });
    }
    if (body.document?.name) rows.push({ label: 'Attachment', value: String(body.document.name) });
    for (const [key, value] of Object.entries(body)) {
        const label = ASSET_FIELD_LABELS[key];
        if (!label || value == null || typeof value === 'object') continue;
        rows.push({ label, value: formatStepValue(key, value) });
    }
    return rows;
};

export function pendingEditChangePairs(entry) {
    const previous = new Map();
    const proposed = new Map();
    for (const row of entry?.previousRows || []) {
        if (row?.label) previous.set(String(row.label), row.value ?? '—');
    }
    for (const row of entry?.proposedRows || []) {
        if (row?.label) proposed.set(String(row.label), row.value ?? '—');
    }
    for (const step of entry?.steps || []) {
        for (const row of rowsFromStep(step)) {
            if (!proposed.has(row.label)) proposed.set(row.label, row.value);
        }
    }
    const labels = [...new Set([...previous.keys(), ...proposed.keys()])];
    return labels
        .map((label) => ({
            label,
            live: previous.has(label) ? previous.get(label) : '—',
            proposed: proposed.has(label) ? proposed.get(label) : '—',
        }))
        .filter((row) => normChangeValue(row.live) !== normChangeValue(row.proposed));
}

const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const findDoc = (asset, type) =>
    (asset?.documents || []).find((doc) => String(doc?.type || '').toLowerCase() === type) || null;

const parseMeta = (doc) => {
    try {
        const parsed = JSON.parse(doc?.description || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
};

const date10 = (value) => (value ? String(value).slice(0, 10) : '—');
const money = (value) =>
    value != null && value !== '' ? `AED ${Number(value).toLocaleString()}` : '—';

export function activationSectionRows(asset, sectionId) {
    const registration = findDoc(asset, 'registration');
    const insurance = findDoc(asset, 'insurance');
    const insuranceMeta = parseMeta(insurance);
    const registrationMeta = parseMeta(registration);
    switch (sectionId) {
        case 'basic':
            return [
                { label: 'Brand', value: asset?.brand || asset?.type || '—' },
                { label: 'Model', value: asset?.name || '—' },
                {
                    label: 'Plate',
                    value: `${asset?.plateEmirate || ''} ${asset?.plateNumber || ''}`.trim() || '—',
                },
                { label: 'Model year', value: asset?.modelYear ?? '—' },
                { label: 'Purchase value', value: money(asset?.assetValue) },
                {
                    label: 'Current KM',
                    value:
                        asset?.currentKilometer != null && asset?.currentKilometer !== ''
                            ? Number(asset.currentKilometer).toLocaleString()
                            : '—',
                },
            ];
        case 'registration':
            return [
                { label: 'Registration date', value: date10(registration?.issueDate) },
                { label: 'Expiry', value: date10(registration?.expiryDate) },
                { label: 'Registration value', value: money(registrationMeta.fee) },
                { label: 'Primary card on file', value: registration?.attachment ? 'Yes' : 'No' },
            ];
        case 'insurance':
            return [
                { label: 'Insurer', value: insuranceMeta.company || insurance?.issueAuthority || '—' },
                { label: 'Policy', value: insuranceMeta.policy || '—' },
                { label: 'Start', value: date10(insurance?.issueDate) },
                { label: 'End', value: date10(insurance?.expiryDate) },
                { label: 'Premium amount', value: money(insuranceMeta.premiumAmount) },
                { label: 'Excess charge', value: money(insuranceMeta.excessCharge) },
            ];
        case 'profile_picture':
            return [
                {
                    label: 'Profile picture',
                    value: asset?.imagePreview || asset?.photo ? 'Uploaded' : 'Missing',
                },
            ];
        default:
            return [];
    }
}

export function activationSubmittedHtml(asset, sections, sectionLabel) {
    const blocks = [];
    for (const sectionId of sections || []) {
        const rows = activationSectionRows(asset, sectionId);
        if (!rows.length) continue;
        const title = sectionLabel(sectionId) || sectionId;
        const body = rows
            .map(
                (row) =>
                    `<tr>
                        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.label)}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.value)}</td>
                    </tr>`,
            )
            .join('');
        blocks.push(`
            <p style="margin:16px 0 6px;"><strong>${escapeHtml(title)}</strong></p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                    <tr>
                        <th style="text-align:left;padding:6px 8px;background:#f8fafc;">Field</th>
                        <th style="text-align:left;padding:6px 8px;background:#f8fafc;">Submitted</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        `);
    }
    return blocks.join('');
}

export function pendingEditsChangeHtml(pending, sectionLabel) {
    const blocks = [];
    for (const entry of pending || []) {
        const pairs = pendingEditChangePairs(entry);
        if (!pairs.length) continue;
        const title = sectionLabel(entry.sectionId) || entry.sectionId || 'Section';
        const body = pairs
            .map(
                (row) =>
                    `<tr>
                        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.label)}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.live)}</td>
                        <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(row.proposed)}</td>
                    </tr>`,
            )
            .join('');
        blocks.push(`
            <p style="margin:16px 0 6px;"><strong>${escapeHtml(title)}</strong></p>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <thead>
                    <tr>
                        <th style="text-align:left;padding:6px 8px;background:#f8fafc;">Field</th>
                        <th style="text-align:left;padding:6px 8px;background:#f8fafc;">Live</th>
                        <th style="text-align:left;padding:6px 8px;background:#f8fafc;">Proposed</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        `);
    }
    return blocks.join('');
}

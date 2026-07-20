/**
 * Resolve employee-ID prefix from the selected company name.
 * - Name contains "vega" → VEGA-HR-
 * - Name contains NNIT / Neoron Nexus (IT) → NNIT-HR-
 * - Fallback → VEGA-HR-
 */
export function resolveEmployeeIdPrefixFromCompany(company) {
    const name = String(company?.name || company?.nickName || '')
        .trim()
        .toLowerCase();

    if (!name) return 'VEGA-HR-';

    if (name.includes('vega')) {
        return 'VEGA-HR-';
    }

    if (
        name.includes('nnit') ||
        name.includes('neuron nexus') ||
        name.includes('neoron nexus') ||
        (name.includes('neuron') && name.includes('nexus')) ||
        (name.includes('neoron') && name.includes('nexus')) ||
        (name.includes('neoron') && name.includes('information technology')) ||
        (name.includes('neuron') && name.includes('information technology'))
    ) {
        return 'NNIT-HR-';
    }

    return 'VEGA-HR-';
}

/** True for company-party placeholders used by fines/payments (never retag). */
export function isPlaceholderEmployeeId(employeeId) {
    const id = String(employeeId || '')
        .trim()
        .toUpperCase();
    return /^(VEGA|NNIT)-HR-0+$/.test(id) || id === 'VEGA-HR-0000' || id === 'NNIT-HR-0000';
}

/**
 * Build target ID: keep trailing digits, swap prefix from company.
 * @returns {{ prefix: string, digits: string, newId: string } | null}
 */
export function buildRetaggedEmployeeId(employeeId, company) {
    const oldId = String(employeeId || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
    if (!oldId || isPlaceholderEmployeeId(oldId)) return null;

    const match = oldId.match(/(\d+)$/);
    if (!match) return null;

    const digits = match[1];
    const prefix = resolveEmployeeIdPrefixFromCompany(company);
    const newId = `${prefix}${digits}`.toUpperCase();

    return { prefix, digits, newId, oldId };
}

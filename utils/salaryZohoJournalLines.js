function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
}

function text(value) {
    return String(value || '').trim();
}

export function zohoOrgBrand(value) {
    const hay = text(value).toLowerCase();
    if (/nnit|neoron|neuron|nexus/.test(hay)) return 'NNIT';
    if (/vega/.test(hay)) return 'VEGA';
    return '';
}

export function zohoOrgShortLabel(org) {
    const brand = text(org?.brand) || zohoOrgBrand(`${org?.name || ''} ${org?.label || ''}`);
    if (brand === 'NNIT') return 'Neuron Nexus';
    if (brand === 'VEGA') return 'Vega Digital';
    return text(org?.name || org?.label) || 'Zoho';
}

function lineKey(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function payrollDescription(note) {
    return text(note);
}

export function normalizeZohoLabel(value) {
    return text(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Pick the Chart of Accounts row whose name is the employee or category label. */
export function findZohoAccount(accounts, label) {
    const target = normalizeZohoLabel(label);
    if (!target || target === 'no category') return null;
    const rows = (Array.isArray(accounts) ? accounts : []).map((account) => ({
        id: text(account?.account_id || account?.id),
        name: text(account?.account_name || account?.name),
    })).filter((row) => row.id && row.name);
    const exact = rows.filter((row) => normalizeZohoLabel(row.name) === target);
    if (exact.length) return exact[0];
    const parts = target.split(' ').filter((part) => part.length > 1);
    if (!parts.length) return null;
    const partial = rows.filter((row) => {
        const name = normalizeZohoLabel(row.name);
        return parts.every((part) => name.includes(part));
    });
    return partial.length === 1 ? partial[0] : null;
}

function journalAccountLabels(line) {
    if (text(line?.accountId)) return [];
    if (line?.kind === 'employee') {
        return [text(line.accountName), text(line.personName)].filter(Boolean);
    }
    if (line?.kind === 'category') {
        const name = text(line.accountName);
        return name && name !== 'No category' ? [name] : [];
    }
    return [];
}

/** Fill a blank account from the saved id, otherwise from the matching Chart of Accounts name. */
export function assignSalaryJournalAccounts(lines, accounts) {
    return (lines || []).map((line) => {
        if (text(line?.accountId)) return line;
        for (const label of journalAccountLabels(line)) {
            const match = findZohoAccount(accounts, label);
            if (match) return { ...line, accountId: match.id, accountName: match.name };
        }
        return line;
    });
}

/**
 * Debit one row per work-details category (employees in the same category are summed).
 * Credit one row per employee, using the salary-modal Zoho account and the slip Zoho salary.
 * Every description is the journal note. The employee name stays off the row.
 */
export function buildSalaryZohoLines(employees, { note = '' } = {}) {
    const description = payrollDescription(note);
    const people = (employees || []).filter((person) => money(person?.zohoSalary) > 0);
    const credits = people.map((person) => {
        const personName = text(person.name) || text(person.employeeId);
        return {
            key: lineKey(`emp-${person.employeeId || 'row'}`),
            kind: 'employee',
            employeeId: text(person.employeeId),
            personName,
            accountId: text(person.zohoAccountId),
            accountName: text(person.zohoAccountName),
            description,
            contactId: '',
            debit: '',
            credit: money(person.zohoSalary).toFixed(2),
        };
    });

    const groups = new Map();
    for (const person of people) {
        const accountId = text(person.zohoCategoryAccountId);
        const accountName = text(person.zohoCategoryAccountName) || (accountId ? '' : 'No category');
        const groupKey = accountId || `name:${accountName.toLowerCase() || 'none'}`;
        const current = groups.get(groupKey) || {
            accountId,
            accountName: accountName || 'No category',
            debit: 0,
        };
        if (!current.accountName && accountName) current.accountName = accountName;
        current.debit = money(current.debit + money(person.zohoSalary));
        groups.set(groupKey, current);
    }

    const debits = [...groups.values()]
        .sort((a, b) => a.accountName.localeCompare(b.accountName, undefined, { sensitivity: 'base' }))
        .map((group) => {
            const categoryName = group.accountName || 'No category';
            return {
                key: lineKey(`cat-${group.accountId || categoryName}`),
                kind: 'category',
                employeeId: '',
                categoryName,
                accountId: group.accountId,
                accountName: group.accountName,
                description,
                contactId: '',
                debit: group.debit.toFixed(2),
                credit: '',
            };
        });

    return [...debits, ...credits];
}

function orgRecord(org) {
    const organizationId = text(org?.organizationId);
    if (!organizationId) return null;
    const name = text(org?.name || org?.label);
    const brand = text(org?.brand) || zohoOrgBrand(name);
    return {
        organizationId,
        name,
        brand,
        label: zohoOrgShortLabel({ brand, name }),
    };
}

function explicitEmployeeOrgId(person) {
    return text(person?.zohoAccountOrganizationId) || text(person?.zohoCategoryOrganizationId);
}

export function resolveEmployeeZohoOrg(company, organizations, explicitOrganizationId = '') {
    const orgs = (organizations || []).map(orgRecord).filter(Boolean);
    const explicit = text(explicitOrganizationId) || text(company?.zohoOrganizationId);
    if (explicit) {
        return orgs.find((org) => org.organizationId === explicit) || orgRecord({
            organizationId: explicit,
            name: company?.zohoOrganizationLabel || company?.nickName || company?.name,
            brand: zohoOrgBrand(`${company?.zohoOrganizationLabel || ''} ${company?.nickName || ''} ${company?.name || ''}`),
        });
    }
    const brand = zohoOrgBrand(`${company?.nickName || ''} ${company?.name || ''} ${company?.zohoOrganizationLabel || ''}`);
    if (!brand) return null;
    return orgs.find((org) => org.brand === brand) || null;
}

/**
 * One journal per connected Zoho company. Vega Digital and Neuron Nexus stay in the list
 * even when that company has no payroll employees this month.
 */
export function groupSalaryZohoJournals({ employees, organizations, note = '' }) {
    const orgs = [];
    const seen = new Set();
    function add(org) {
        const row = orgRecord(org);
        if (!row || seen.has(row.organizationId)) return;
        seen.add(row.organizationId);
        orgs.push(row);
    }

    for (const org of organizations || []) add(org);
    for (const person of employees || []) {
        add(resolveEmployeeZohoOrg(person.company, organizations, explicitEmployeeOrgId(person)));
    }

    orgs.sort((a, b) => {
        const rank = (brand) => (brand === 'VEGA' ? 0 : brand === 'NNIT' ? 1 : 2);
        return rank(a.brand) - rank(b.brand) || a.label.localeCompare(b.label);
    });

    return orgs.map((org) => {
        const people = (employees || []).filter((person) => {
            const match = resolveEmployeeZohoOrg(person.company, orgs, explicitEmployeeOrgId(person));
            return match?.organizationId === org.organizationId;
        });
        return {
            ...org,
            employeeCount: people.length,
            lines: buildSalaryZohoLines(people, { note }),
        };
    });
}

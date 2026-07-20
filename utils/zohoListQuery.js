/**
 * Shared Mongo list helpers for Zoho-cached collections.
 * Keeps list payloads lean (no zohoRaw) and supports page/search/sort.
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_UNPAGED = 5000;

export function parseListQuery(query = {}) {
    const hasPage = query.page !== undefined && query.page !== null && String(query.page).trim() !== '';
    const page = hasPage ? Math.max(1, Number(query.page) || 1) : null;
    const pageSize = Math.max(
        1,
        Math.min(MAX_PAGE_SIZE, Number(query.pageSize || query.limit) || DEFAULT_PAGE_SIZE),
    );
    const search = String(query.search || query.q || '').trim();
    const sortBy = String(query.sortBy || query.sort || '').trim();
    const sortDir = String(query.sortDir || query.order || 'desc').trim().toLowerCase() === 'asc' ? 1 : -1;

    return { page, pageSize, search, sortBy, sortDir, paginate: page !== null };
}

export function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildSearchFilter(search, fields = []) {
    const term = String(search || '').trim();
    if (!term || !fields.length) return null;

    const regex = new RegExp(escapeRegex(term), 'i');
    return {
        $or: fields.map((field) => ({ [field]: regex })),
    };
}

export async function runLeanListQuery({
    Model,
    organizationId,
    activeOnly = true,
    query = {},
    searchFields = [],
    sortMap = {},
    defaultSort = { date: -1 },
    toApiShape,
}) {
    const { page, pageSize, search, sortBy, sortDir, paginate } = parseListQuery(query);

    const filter = { organizationId };
    if (activeOnly) filter.isActive = true;

    const searchFilter = buildSearchFilter(search, searchFields);
    if (searchFilter) {
        Object.assign(filter, searchFilter);
    }

    const sortField = sortMap[sortBy];
    const sort = sortField ? { [sortField]: sortDir } : { ...defaultSort };

    const baseQuery = Model.find(filter).select('-zohoRaw').sort(sort).lean();

    if (!paginate) {
        const docs = await baseQuery.limit(MAX_UNPAGED);
        const data = docs.map(toApiShape).filter(Boolean);
        return {
            data,
            meta: {
                count: data.length,
                total: data.length,
                page: 1,
                pageSize: data.length,
                totalPages: 1,
                source: 'database',
            },
        };
    }

    const skip = (page - 1) * pageSize;
    const [docs, total] = await Promise.all([
        Model.find(filter).select('-zohoRaw').sort(sort).skip(skip).limit(pageSize).lean(),
        Model.countDocuments(filter),
    ]);

    const data = docs.map(toApiShape).filter(Boolean);
    const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);

    return {
        data,
        meta: {
            count: data.length,
            total,
            page,
            pageSize,
            totalPages,
            source: 'database',
        },
    };
}

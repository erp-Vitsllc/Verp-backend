const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BILL_STATUS_ORDER = ['Draft', 'Pending', 'Approved'];
const STOCK_STATUS_ORDER = ['Stock In', 'Low Stock', 'Out of Stock'];

function roundMoney(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function dateParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
}

function dateKey(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(value, days) {
    const parts = dateParts(value);
    if (!parts) return '';
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    date.setUTCDate(date.getUTCDate() + days);
    return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function spanDays(start, end) {
    const from = dateParts(start);
    const to = dateParts(end);
    if (!from || !to) return 0;
    const startUtc = Date.UTC(from.year, from.month - 1, from.day);
    const endUtc = Date.UTC(to.year, to.month - 1, to.day);
    return Math.round((endUtc - startUtc) / 86400000) + 1;
}

function prettyDate(value) {
    const parts = dateParts(value);
    if (!parts) return '';
    return `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}`;
}

function monthList(value) {
    const raw = Array.isArray(value) ? value.join(',') : String(value || '');
    const months = [...new Set(
        raw.split(',')
            .map((part) => Number(String(part).trim()))
            .filter((month) => Number.isInteger(month) && month >= 1 && month <= 12),
    )];
    months.sort((left, right) => left - right);
    return months;
}

function includesDate(scope, value) {
    if (!dateParts(value)) return false;
    if (scope.mode === 'months') {
        return Number(value.slice(0, 4)) === scope.year && scope.months.includes(Number(value.slice(5, 7)));
    }
    return value >= scope.start && value <= scope.end;
}

function scopeLabel(scope) {
    if (scope.mode === 'year') return String(scope.year);
    if (scope.mode === 'months') {
        const names = scope.months.map((month) => MONTHS[month - 1]).join(', ');
        return `${names} ${scope.year}`;
    }
    return `${prettyDate(scope.start)} – ${prettyDate(scope.end)}`;
}

function yearScope(year) {
    return {
        mode: 'year',
        year,
        months: [],
        start: dateKey(year, 1, 1),
        end: dateKey(year, 12, 31),
    };
}

function monthsScope(year, months) {
    const first = months[0];
    const last = months[months.length - 1];
    return {
        mode: 'months',
        year,
        months,
        start: dateKey(year, first, 1),
        end: dateKey(year, last, lastDayOfMonth(year, last)),
    };
}

function customScope(start, end) {
    return {
        mode: 'custom',
        year: dateParts(start).year,
        months: [],
        start,
        end,
    };
}

function withIncludes(scope, previous) {
    return {
        ...scope,
        label: scopeLabel(scope),
        includes(value) {
            return includesDate(scope, value);
        },
        previous: previous || null,
    };
}

function previousOf(scope) {
    if (scope.mode === 'year') return yearScope(scope.year - 1);
    if (scope.mode === 'months') return monthsScope(scope.year - 1, scope.months);
    const days = spanDays(scope.start, scope.end);
    const end = addDays(scope.start, -1);
    const start = addDays(end, -(days - 1));
    return customScope(start, end);
}

export function parseDashboardScope(query, todayKey) {
    const today = dateParts(todayKey) ? todayKey : dateKey(new Date().getUTCFullYear(), 1, 1);
    const todayYear = dateParts(today).year;
    const requested = String(query?.mode || 'year');
    if (!['year', 'months', 'custom'].includes(requested)) {
        throw new Error('Choose year, months, or a custom date range.');
    }
    if (requested === 'custom') {
        const start = String(query?.start || '');
        const end = String(query?.end || '');
        if (!dateParts(start) || !dateParts(end)) throw new Error('Choose a start date and an end date.');
        if (start > end) throw new Error('The start date must be on or before the end date.');
        const scope = customScope(start, end);
        return withIncludes(scope, withIncludes(previousOf(scope)));
    }
    const year = Number(query?.year || todayYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Choose a year from 2000 to 2100.');
    if (requested === 'months') {
        const months = monthList(query?.months);
        if (!months.length) throw new Error('Choose at least one month.');
        const scope = monthsScope(year, months);
        return withIncludes(scope, withIncludes(previousOf(scope)));
    }
    const scope = yearScope(year);
    return withIncludes(scope, withIncludes(previousOf(scope)));
}

/** Same rule as item master: on hand against the subcategory reservation quantity. */
export function stockPosition(availableQuantity, reservationQuantity) {
    const stock = Number(availableQuantity);
    const onHand = Number.isFinite(stock) ? stock : 0;
    if (onHand <= 0) return 'Out of Stock';
    if (reservationQuantity == null || reservationQuantity === '') return 'Stock In';
    const reserve = Number(reservationQuantity);
    if (!Number.isFinite(reserve)) return 'Stock In';
    if (onHand < reserve) return 'Low Stock';
    return 'Stock In';
}

function lineAmount(line) {
    const quantity = Number(line?.quantity) || 0;
    const price = Number(line?.unitPrice) || 0;
    const total = Number(line?.total);
    if (Number.isFinite(total) && total > 0) return roundMoney(total);
    return roundMoney(quantity * price);
}

function priceOn(prices, day) {
    let chosen = null;
    for (const row of prices) {
        if (row.date <= day) chosen = row.unitPrice;
        else break;
    }
    return chosen;
}

function priceBooks(model) {
    const books = new Map();
    const bookFor = (id) => {
        if (!id) return null;
        if (!books.has(id)) books.set(id, { prices: [], fallback: 0 });
        return books.get(id);
    };
    (model.items || []).forEach((item) => {
        const book = bookFor(item.id);
        if (book) book.fallback = Number(item.lastPrice) || 0;
    });
    (model.purchases || []).forEach((purchase) => {
        if (purchase.status !== 'Approved' || !purchase.date) return;
        (purchase.lines || []).forEach((line) => {
            const book = bookFor(line.itemId);
            if (!book) return;
            book.prices.push({
                date: purchase.date,
                unitPrice: Number(line.unitPrice) || 0,
                id: purchase.id,
            });
        });
    });
    books.forEach((book) => {
        book.prices.sort((left, right) => left.date.localeCompare(right.date) || String(left.id).localeCompare(String(right.id)));
    });
    return books;
}

function unitCost(books, itemId, day, fallback) {
    const book = books.get(itemId);
    const historical = book ? priceOn(book.prices, day) : null;
    if (historical != null) return historical;
    if (book) return Number(book.fallback) || Number(fallback) || 0;
    return Number(fallback) || 0;
}

function existedBy(item, end) {
    if (!item.createdOn) return true;
    return item.createdOn <= end;
}

function addedIn(item, scope) {
    return Boolean(item.createdOn) && scope.includes(item.createdOn);
}

function chartBuckets(scope) {
    const months = [];
    if (scope.mode === 'year') {
        for (let month = 1; month <= 12; month += 1) {
            months.push({ year: scope.year, month });
        }
    } else if (scope.mode === 'months') {
        scope.months.forEach((month) => months.push({ year: scope.year, month }));
    } else {
        let cursor = scope.start.slice(0, 7);
        const endMonth = scope.end.slice(0, 7);
        while (cursor <= endMonth) {
            const year = Number(cursor.slice(0, 4));
            const month = Number(cursor.slice(5, 7));
            months.push({ year, month });
            const nextMonth = month === 12 ? 1 : month + 1;
            const nextYear = month === 12 ? year + 1 : year;
            cursor = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;
        }
    }
    if (months.length > 18) {
        const first = Number(scope.start.slice(0, 4));
        const last = Number(scope.end.slice(0, 4));
        const years = [];
        for (let year = first; year <= last; year += 1) {
            years.push({
                key: String(year),
                month: String(year),
                match: (day) => day.slice(0, 4) === String(year),
            });
        }
        return years;
    }
    const multiYear = new Set(months.map((row) => row.year)).size > 1;
    return months.map((row) => {
        const key = `${row.year}-${String(row.month).padStart(2, '0')}`;
        return {
            key,
            month: multiYear ? `${MONTHS[row.month - 1]} ${String(row.year).slice(2)}` : MONTHS[row.month - 1],
            match: (day) => day.slice(0, 7) === key,
        };
    });
}

function packCategories(rows) {
    const sorted = rows
        .filter((row) => row.value > 0)
        .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));
    if (sorted.length <= 8) return sorted;
    const head = sorted.slice(0, 7);
    const others = roundMoney(sorted.slice(7).reduce((sum, row) => sum + row.value, 0));
    return [...head, { name: 'Others', value: others }];
}

function itemLabel(item) {
    return item.description || item.itemCode || 'Item';
}

export function collectYears(model, extraYears = []) {
    const years = new Set();
    (Array.isArray(extraYears) ? extraYears : []).forEach((year) => {
        const number = Number(year);
        if (Number.isInteger(number) && number >= 2000 && number <= 2100) years.add(number);
    });
    const add = (day) => {
        const parts = dateParts(day);
        if (parts && parts.year >= 2000 && parts.year <= 2100) years.add(parts.year);
    };
    (model.items || []).forEach((item) => add(item.createdOn));
    (model.purchases || []).forEach((purchase) => add(purchase.date));
    (model.deliveries || []).forEach((delivery) => add(delivery.date));
    return [...years].sort((left, right) => left - right);
}

export function buildInventoryDashboard(model, scope) {
    const items = Array.isArray(model?.items) ? model.items : [];
    const purchases = Array.isArray(model?.purchases) ? model.purchases : [];
    const deliveries = Array.isArray(model?.deliveries) ? model.deliveries : [];
    const books = priceBooks(model);
    const end = scope.end;
    const billed = new Set();
    const delivered = new Set();
    const inboundAfter = new Map();
    const outboundAfter = new Map();
    const addQty = (map, id, quantity) => {
        if (!id || !quantity) return;
        map.set(id, (map.get(id) || 0) + quantity);
    };

    let purchasedValue = 0;
    const vendorTotals = new Map();
    const monthly = chartBuckets(scope).map((bucket) => ({ ...bucket, value: 0 }));
    const billCounts = new Map(BILL_STATUS_ORDER.map((name) => [name, 0]));
    const recent = [];

    purchases.forEach((purchase) => {
        const day = purchase.date;
        const inScope = Boolean(day) && scope.includes(day);
        const approved = purchase.status === 'Approved';
        const amount = roundMoney((purchase.lines || []).reduce((sum, line) => sum + lineAmount(line), 0));
        if (inScope && billCounts.has(purchase.status)) billCounts.set(purchase.status, billCounts.get(purchase.status) + 1);
        if (inScope) {
            recent.push({
                id: purchase.id,
                billNo: purchase.billNo || 'Bill',
                vendorId: purchase.vendorId || '',
                vendor: purchase.vendorName || 'Manual',
                amount,
                date: day,
                status: purchase.status || 'Draft',
            });
        }
        (purchase.lines || []).forEach((line) => {
            const quantity = Number(line.quantity) || 0;
            if (approved && day && day > end) addQty(inboundAfter, line.itemId, quantity);
            if (!approved || !inScope) return;
            if (line.itemId) billed.add(line.itemId);
        });
        if (!approved || !inScope) return;
        purchasedValue = roundMoney(purchasedValue + amount);
        monthly.forEach((bucket) => {
            if (bucket.match(day)) bucket.value = roundMoney(bucket.value + amount);
        });
        if (purchase.vendorId) {
            const current = vendorTotals.get(purchase.vendorId) || { id: purchase.vendorId, name: purchase.vendorName || 'Vendor', value: 0 };
            current.value = roundMoney(current.value + amount);
            vendorTotals.set(purchase.vendorId, current);
        }
    });

    let deliveredValue = 0;
    deliveries.forEach((delivery) => {
        if (delivery.status !== 'Confirmed' || !delivery.date) return;
        const day = delivery.date;
        (delivery.lines || []).forEach((line) => {
            const quantity = Number(line.quantity) || 0;
            if (!quantity || !line.itemId) return;
            if (day > end) addQty(outboundAfter, line.itemId, quantity);
            if (!scope.includes(day)) return;
            delivered.add(line.itemId);
            const cost = unitCost(books, line.itemId, day, 0);
            deliveredValue = roundMoney(deliveredValue + roundMoney(quantity * cost));
        });
    });

    const quantityAtEnd = new Map();
    items.forEach((item) => {
        if (!existedBy(item, end)) return;
        const quantity = Math.max(0, (Number(item.available) || 0) - (inboundAfter.get(item.id) || 0) + (outboundAfter.get(item.id) || 0));
        quantityAtEnd.set(item.id, quantity);
    });

    let inventoryValue = 0;
    let lowStock = 0;
    let deadStock = 0;
    let itemsAdded = 0;
    let totalItems = 0;
    const categoryValue = new Map();
    const categoryQty = new Map();
    const stockCounts = new Map(STOCK_STATUS_ORDER.map((name) => [name, 0]));
    const lowRows = [];
    const changes = new Map();

    items.forEach((item) => {
        if (addedIn(item, scope)) itemsAdded += 1;
        if (!existedBy(item, end)) return;
        totalItems += 1;
        const quantity = quantityAtEnd.get(item.id) || 0;
        const cost = unitCost(books, item.id, end, item.lastPrice);
        const value = roundMoney(quantity * cost);
        inventoryValue = roundMoney(inventoryValue + value);
        const category = item.categoryName || 'Uncategorized';
        categoryValue.set(category, roundMoney((categoryValue.get(category) || 0) + value));
        categoryQty.set(category, (categoryQty.get(category) || 0) + quantity);
        const status = stockPosition(quantity, item.reservation);
        stockCounts.set(status, (stockCounts.get(status) || 0) + 1);
        if (status === 'Low Stock') lowStock += 1;
        if (status === 'Low Stock' || status === 'Out of Stock') {
            lowRows.push({
                id: item.id,
                item: itemLabel(item),
                available: quantity,
                reorder: item.reservation == null ? null : item.reservation,
                uom: item.unit || '',
                status,
            });
        }
        const untouched = !addedIn(item, scope) && !billed.has(item.id) && !delivered.has(item.id);
        if (untouched) deadStock += 1;
    });

    const events = [];
    purchases.forEach((purchase) => {
        if (purchase.status !== 'Approved' || !purchase.date) return;
        (purchase.lines || []).forEach((line, index) => {
            if (!line.itemId) return;
            events.push({
                itemId: line.itemId,
                date: purchase.date,
                price: Number(line.unitPrice) || 0,
                vendor: purchase.vendorName || 'Manual',
                id: `${purchase.id}-${index}`,
            });
        });
    });
    events.sort((left, right) => left.itemId.localeCompare(right.itemId) || left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
    let previousEvent = null;
    events.forEach((event) => {
        if (!previousEvent || previousEvent.itemId !== event.itemId) {
            previousEvent = event;
            return;
        }
        if (event.price !== previousEvent.price && scope.includes(event.date)) {
            changes.set(event.itemId, {
                itemId: event.itemId,
                oldPrice: previousEvent.price,
                newPrice: event.price,
                up: event.price > previousEvent.price,
                date: event.date,
                vendor: event.vendor,
            });
        }
        previousEvent = event;
    });

    const names = new Map(items.map((item) => [item.id, itemLabel(item)]));
    lowRows.sort((left, right) => {
        const rank = (status) => (status === 'Out of Stock' ? 0 : 1);
        return rank(left.status) - rank(right.status) || left.available - right.available || left.item.localeCompare(right.item);
    });

    return {
        stats: {
            totalItems,
            inventoryValue,
            purchasedValue,
            deliveredValue,
            lowStock,
            deadStock,
            activeVendors: vendorTotals.size,
            itemsAdded,
        },
        categories: packCategories([...categoryValue.entries()].map(([name, value]) => ({ name, value }))),
        monthly: monthly.map((bucket) => ({ month: bucket.month, value: bucket.value })),
        vendors: [...vendorTotals.values()]
            .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
            .slice(0, 5),
        lowStock: lowRows.slice(0, 5),
        purchases: recent
            .sort((left, right) => right.date.localeCompare(left.date) || String(right.id).localeCompare(String(left.id)))
            .slice(0, 5),
        priceChanges: [...changes.values()]
            .map((row) => ({ ...row, product: names.get(row.itemId) || 'Item' }))
            .sort((left, right) => right.date.localeCompare(left.date) || left.product.localeCompare(right.product))
            .slice(0, 5),
        stockByCategory: [...categoryQty.entries()]
            .map(([name, value]) => ({ name, value }))
            .filter((row) => row.value > 0)
            .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
            .slice(0, 8),
        stockStatus: STOCK_STATUS_ORDER
            .map((name) => ({ name, value: stockCounts.get(name) || 0 }))
            .filter((row) => row.value > 0),
        billStatus: BILL_STATUS_ORDER
            .map((name) => ({ name, value: billCounts.get(name) || 0 }))
            .filter((row) => row.value > 0),
    };
}

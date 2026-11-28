import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInventoryDashboard, collectYears, parseDashboardScope } from './inventoryDashboard.js';

const TODAY = '2026-11-21';

function year(value) {
    return parseDashboardScope({ mode: 'year', year: value }, TODAY);
}

function item(fields) {
    return {
        description: 'Item',
        itemCode: '',
        unit: 'Quantity',
        categoryName: 'Cabling',
        reservation: null,
        available: 0,
        lastPrice: 0,
        createdOn: '2024-01-01',
        ...fields,
    };
}

const MODEL = {
    items: [
        item({
            id: 'cable',
            description: 'CAT6 Cable',
            itemCode: 'IT-1',
            unit: 'Box',
            categoryName: 'Cabling',
            reservation: 25,
            available: 10,
            lastPrice: 15,
            createdOn: '2025-01-10',
        }),
        item({
            id: 'spare',
            description: 'Spare PSU',
            categoryName: 'Other',
            available: 3,
            lastPrice: 10,
            createdOn: '2024-05-01',
        }),
        item({
            id: 'new-cam',
            description: 'New Camera',
            categoryName: 'CCTV',
            available: 0,
            lastPrice: 0,
            createdOn: '2026-04-01',
        }),
    ],
    purchases: [
        {
            id: 'p-2025',
            billNo: 'B-2025',
            vendorId: 'vendor-a',
            vendorName: 'Vendor A',
            date: '2025-06-01',
            status: 'Approved',
            lines: [{ itemId: 'cable', quantity: 8, unitPrice: 4, total: 32 }],
        },
        {
            id: 'p-2026',
            billNo: 'B-2026',
            vendorId: 'vendor-a',
            vendorName: 'Vendor A',
            date: '2026-02-01',
            status: 'Approved',
            lines: [{ itemId: 'cable', quantity: 6, unitPrice: 5, total: 30 }],
        },
        {
            id: 'p-manual',
            billNo: 'B-MAN',
            vendorId: '',
            vendorName: 'Manual',
            date: '2026-07-01',
            status: 'Approved',
            lines: [{ itemId: 'cable', quantity: 1, unitPrice: 15, total: 15 }],
        },
        {
            id: 'p-pending',
            billNo: 'B-PEND',
            vendorId: 'vendor-b',
            vendorName: 'Vendor B',
            date: '2026-05-02',
            status: 'Pending',
            lines: [{ itemId: 'cable', quantity: 2, unitPrice: 9, total: 18 }],
        },
    ],
    deliveries: [
        {
            id: 'd-2026',
            date: '2026-03-01',
            status: 'Confirmed',
            lines: [{ itemId: 'cable', quantity: 4 }],
        },
    ],
};

test('year scope covers that calendar year and the previous year', () => {
    const scope = year(2026);
    assert.equal(scope.start, '2026-01-01');
    assert.equal(scope.end, '2026-12-31');
    assert.equal(scope.includes('2026-11-21'), true);
    assert.equal(scope.includes('2025-12-31'), false);
    assert.equal(scope.previous.start, '2025-01-01');
    assert.equal(scope.previous.end, '2025-12-31');
    assert.equal(scope.label, '2026');
});

test('selected months ignore the months in between', () => {
    const scope = parseDashboardScope({ mode: 'months', year: 2026, months: '3,1,1' }, TODAY);
    assert.deepEqual(scope.months, [1, 3]);
    assert.equal(scope.end, '2026-03-31');
    assert.equal(scope.includes('2026-01-15'), true);
    assert.equal(scope.includes('2026-02-01'), false);
    assert.equal(scope.includes('2026-03-31'), true);
    assert.equal(scope.previous.year, 2025);
    assert.equal(scope.previous.includes('2025-02-01'), false);
    assert.equal(scope.label, 'Jan, Mar 2026');
});

test('February uses the leap day', () => {
    const leap = parseDashboardScope({ mode: 'months', year: 2024, months: '2' }, TODAY);
    const common = parseDashboardScope({ mode: 'months', year: 2025, months: '2' }, TODAY);
    assert.equal(leap.end, '2024-02-29');
    assert.equal(common.end, '2025-02-28');
});

test('custom range rejects an end date before the start and builds the previous window', () => {
    assert.throws(
        () => parseDashboardScope({ mode: 'custom', start: '2026-05-01', end: '2026-04-01' }, TODAY),
        /start date/i,
    );
    const scope = parseDashboardScope({ mode: 'custom', start: '2026-03-01', end: '2026-03-31' }, TODAY);
    assert.equal(scope.previous.start, '2026-01-29');
    assert.equal(scope.previous.end, '2026-02-28');
});

test('2026 totals follow purchases, deliveries, and stock still on hand at year end', () => {
    const result = buildInventoryDashboard(MODEL, year(2026));
    assert.deepEqual(result.stats, {
        totalItems: 3,
        inventoryValue: 180,
        purchasedValue: 45,
        deliveredValue: 20,
        lowStock: 1,
        deadStock: 1,
        activeVendors: 1,
        itemsAdded: 1,
    });
    assert.deepEqual(result.categories, [
        { name: 'Cabling', value: 150 },
        { name: 'Other', value: 30 },
    ]);
    assert.equal(result.monthly.find((row) => row.month === 'Feb').value, 30);
    assert.equal(result.monthly.find((row) => row.month === 'Jul').value, 15);
    assert.equal(result.monthly.find((row) => row.month === 'May').value, 0);
    assert.deepEqual(result.vendors, [{ id: 'vendor-a', name: 'Vendor A', value: 30 }]);
    assert.deepEqual(result.stockGraph, [
        { name: 'Cabling', value: 10 },
        { name: 'Other', value: 3 },
    ]);
    assert.deepEqual(result.purchaseGraph, [{ name: 'Cabling', value: 7 }]);
    assert.deepEqual(result.deliveryGraph, [{ name: 'Cabling', value: 4 }]);
    assert.deepEqual(result.billStatus, [
        { name: 'Pending', value: 1 },
        { name: 'Approved', value: 2 },
    ]);
    assert.deepEqual(result.stockStatus, [
        { name: 'Stock In', value: 1 },
        { name: 'Low Stock', value: 1 },
        { name: 'Out of Stock', value: 1 },
    ]);
    assert.equal(result.lowStock[0].item, 'New Camera');
    assert.equal(result.lowStock[0].status, 'Out of Stock');
    assert.equal(result.lowStock[1].item, 'CAT6 Cable');
    assert.equal(result.lowStock[1].available, 10);
    assert.equal(result.lowStock[1].reorder, 25);
    assert.equal(result.purchases[0].billNo, 'B-MAN');
    assert.equal(result.priceChanges[0].oldPrice, 5);
    assert.equal(result.priceChanges[0].newPrice, 15);
    assert.equal(result.priceChanges[0].up, true);
});

test('a past year rolls stock back to the prices and quantities of that year', () => {
    const result = buildInventoryDashboard(MODEL, year(2025));
    assert.equal(result.stats.totalItems, 2);
    assert.equal(result.stats.itemsAdded, 1);
    assert.equal(result.stats.purchasedValue, 32);
    assert.equal(result.stats.deliveredValue, 0);
    assert.equal(result.stats.inventoryValue, 58);
    assert.equal(result.stats.lowStock, 1);
    assert.equal(result.stats.deadStock, 1);
    assert.equal(result.stats.activeVendors, 1);
    assert.equal(result.priceChanges.length, 0);
    const cable = result.categories.find((row) => row.name === 'Cabling');
    assert.equal(cable.value, 28);
});

test('a single month keeps that month only, and a gap does not count as activity', () => {
    const february = parseDashboardScope({ mode: 'months', year: 2026, months: '2' }, TODAY);
    const februaryResult = buildInventoryDashboard(MODEL, february);
    assert.equal(februaryResult.stats.purchasedValue, 30);
    assert.equal(februaryResult.stats.deliveredValue, 0);
    assert.equal(februaryResult.stats.totalItems, 2);
    assert.equal(februaryResult.stats.itemsAdded, 0);
    assert.equal(februaryResult.stats.inventoryValue, 95);
    assert.equal(februaryResult.stats.deadStock, 1);

    const gap = parseDashboardScope({ mode: 'months', year: 2026, months: '1,3' }, TODAY);
    const gapResult = buildInventoryDashboard(MODEL, gap);
    assert.equal(gapResult.stats.purchasedValue, 0);
    assert.equal(gapResult.stats.deliveredValue, 20);
    assert.equal(gapResult.stats.inventoryValue, 75);
    assert.equal(gapResult.stats.deadStock, 1);
    assert.equal(gapResult.monthly.map((row) => row.month).join(','), 'Jan,Mar');
});

test('an item created in a gap month is dead stock for the selected months', () => {
    const scope = parseDashboardScope({ mode: 'months', year: 2026, months: '1,3' }, TODAY);
    const result = buildInventoryDashboard({
        items: [item({ id: 'gap', description: 'Gap Item', createdOn: '2026-02-15', available: 1, lastPrice: 1 })],
        purchases: [],
        deliveries: [],
    }, scope);
    assert.equal(result.stats.itemsAdded, 0);
    assert.equal(result.stats.totalItems, 1);
    assert.equal(result.stats.deadStock, 1);
    assert.equal(result.stats.inventoryValue, 1);
});

test('a delivery with no bill uses the item cost and is not dead stock', () => {
    const result = buildInventoryDashboard({
        items: [item({ id: 'cam', description: 'Cam', categoryName: 'CCTV', available: 0, lastPrice: 8, createdOn: '2024-01-01' })],
        purchases: [],
        deliveries: [{ id: 'd1', date: '2026-01-15', status: 'Confirmed', lines: [{ itemId: 'cam', quantity: 2 }] }],
    }, year(2026));
    assert.equal(result.stats.deliveredValue, 16);
    assert.equal(result.stats.deadStock, 0);
    assert.equal(result.stats.inventoryValue, 0);
});

test('draft deliveries and unapproved bills do not move purchased or delivered value', () => {
    const result = buildInventoryDashboard({
        items: [item({ id: 'a', createdOn: '2024-01-01', available: 4, lastPrice: 2 })],
        purchases: [{
            id: 'draft',
            billNo: 'DRAFT',
            vendorId: 'v',
            vendorName: 'V',
            date: '2026-02-01',
            status: 'Draft',
            lines: [{ itemId: 'a', quantity: 4, unitPrice: 2, total: 8 }],
        }],
        deliveries: [{ id: 'draft-d', date: '2026-02-02', status: 'Submitted', lines: [{ itemId: 'a', quantity: 1 }] }],
    }, year(2026));
    assert.equal(result.stats.purchasedValue, 0);
    assert.equal(result.stats.deliveredValue, 0);
    assert.equal(result.stats.activeVendors, 0);
    assert.equal(result.stats.deadStock, 1);
    assert.deepEqual(result.billStatus, [{ name: 'Draft', value: 1 }]);
});

test('vendor bars keep the five highest purchase totals', () => {
    const purchases = [1, 2, 3, 4, 5, 6].map((index) => ({
        id: `p${index}`,
        billNo: `B${index}`,
        vendorId: `v${index}`,
        vendorName: `Vendor ${index}`,
        date: '2026-01-01',
        status: 'Approved',
        lines: [{ itemId: 'a', quantity: 1, unitPrice: index * 10, total: index * 10 }],
    }));
    const result = buildInventoryDashboard({
        items: [item({ id: 'a', createdOn: '2026-01-01' })],
        purchases,
        deliveries: [],
    }, year(2026));
    assert.deepEqual(result.vendors.map((row) => row.value), [60, 50, 40, 30, 20]);
});

test('more than eight categories collapse the tail into Others', () => {
    const items = Array.from({ length: 9 }, (_, index) => item({
        id: `c${index}`,
        categoryName: `Cat ${index}`,
        available: 1,
        lastPrice: index + 1,
        createdOn: '2026-01-01',
    }));
    const result = buildInventoryDashboard({ items, purchases: [], deliveries: [] }, year(2026));
    assert.equal(result.categories.length, 8);
    assert.equal(result.categories[7].name, 'Others');
    assert.equal(result.categories[0].value, 9);
    const total = result.categories.reduce((sum, row) => sum + row.value, 0);
    assert.equal(total, result.stats.inventoryValue);
});

test('years come from the records that fall on the timeline', () => {
    assert.deepEqual(collectYears(MODEL, [2026]), [2024, 2025, 2026]);
});

test('non-moving stock is on-hand quantity idle for more than 28 days', () => {
    const asOf = '2026-11-28';
    const result = buildInventoryDashboard({
        items: [
            item({ id: 'fresh', modelNumber: 'NEW-1', categoryName: 'CCTV', available: 10, lastPrice: 100, createdOn: '2026-01-01' }),
            item({ id: 'idle', modelNumber: 'CAM-001', categoryName: 'CCTV', available: 35, lastPrice: 250, createdOn: '2026-01-01' }),
            item({ id: 'critical', modelNumber: 'NVR-001', categoryName: 'CCTV', available: 10, lastPrice: 850, createdOn: '2025-01-01' }),
            item({ id: 'gone', modelNumber: 'OLD-1', categoryName: 'CCTV', available: 0, lastPrice: 10, createdOn: '2025-01-01' }),
            item({ id: 'net', modelNumber: 'SW-1', categoryName: 'Active Network', available: 4, lastPrice: 100, createdOn: '2026-06-01' }),
            item({ id: 'both', modelNumber: 'BOTH-1', categoryName: 'CCTV', available: 2, lastPrice: 10, createdOn: '2026-01-01' }),
            item({ id: 'edge28', modelNumber: 'E28', categoryName: 'Audio', available: 1, lastPrice: 10, createdOn: '2026-10-31' }),
            item({ id: 'edge29', modelNumber: 'E29', categoryName: 'Audio', available: 1, lastPrice: 10, createdOn: '2026-10-30' }),
            item({ id: 'rolled', modelNumber: 'ROLL-1', categoryName: 'Automation', available: 20, lastPrice: 10, createdOn: '2026-09-01' }),
            item({ id: 'received', modelNumber: 'RCV-1', categoryName: 'Display', available: 4, lastPrice: 50, createdOn: '2024-01-01' }),
            item({ id: 'pendingOnly', modelNumber: 'P-1', categoryName: 'Printers', available: 2, lastPrice: 10, createdOn: '2026-01-01' }),
            item({ id: 'drafted', modelNumber: 'D-1', categoryName: 'Printers', available: 5, lastPrice: 10, createdOn: '2026-01-01' }),
        ],
        purchases: [
            { id: 'future-buy', billNo: 'F', vendorId: 'v', vendorName: 'V', date: '2026-12-15', status: 'Approved', lines: [{ itemId: 'rolled', quantity: 6, unitPrice: 10, total: 60 }] },
            { id: 'receipt', billNo: 'R', vendorId: 'v', vendorName: 'V', date: '2026-10-01', status: 'Approved', lines: [{ itemId: 'received', quantity: 4, unitPrice: 80, total: 320 }] },
            { id: 'pending-buy', billNo: 'P', vendorId: 'v', vendorName: 'V', date: '2026-11-20', status: 'Pending', lines: [{ itemId: 'pendingOnly', quantity: 2, unitPrice: 10, total: 20 }] },
        ],
        deliveries: [
            { id: 'd-fresh', date: '2026-11-20', status: 'Confirmed', lines: [{ itemId: 'fresh', quantity: 1 }] },
            { id: 'd-idle', date: '2026-09-20', status: 'Confirmed', lines: [{ itemId: 'idle', quantity: 1 }] },
            { id: 'd-critical', date: '2026-08-01', status: 'Confirmed', lines: [{ itemId: 'critical', quantity: 1 }] },
            { id: 'd-gone', date: '2026-08-01', status: 'Confirmed', lines: [{ itemId: 'gone', quantity: 1 }] },
            { id: 'd-net', date: '2026-10-20', status: 'Confirmed', lines: [{ itemId: 'net', quantity: 1 }] },
            { id: 'd-old', date: '2026-08-01', status: 'Confirmed', lines: [{ itemId: 'both', quantity: 1 }] },
            { id: 'd-new', date: '2026-11-10', status: 'Confirmed', lines: [{ itemId: 'both', quantity: 1 }] },
            { id: 'd-future', date: '2026-12-01', status: 'Confirmed', lines: [{ itemId: 'rolled', quantity: 3 }] },
            { id: 'd-draft', date: '2026-11-27', status: 'Submitted', lines: [{ itemId: 'drafted', quantity: 1 }] },
        ],
    }, year(2026), asOf);

    assert.equal(result.nonMoving.quantity, 78);
    assert.equal(result.nonMoving.value, 18220);
    assert.deepEqual(result.nonMoving.categories, [
        { name: 'CCTV', value: 45 },
        { name: 'Automation', value: 17 },
        { name: 'Printers', value: 7 },
        { name: 'Active Network', value: 4 },
        { name: 'Display', value: 4 },
        { name: 'Audio', value: 1 },
    ]);
    const byId = new Map(result.nonMoving.items.map((row) => [row.id, row]));
    assert.equal(byId.has('fresh'), false);
    assert.equal(byId.has('gone'), false);
    assert.equal(byId.has('both'), false);
    assert.equal(byId.has('edge28'), false);
    assert.deepEqual(byId.get('idle'), {
        id: 'idle',
        model: 'CAM-001',
        category: 'CCTV',
        quantity: 35,
        lastDelivery: '2026-09-20',
        idleDays: 69,
        value: 8750,
        band: 'slow',
    });
    assert.equal(byId.get('net').idleDays, 39);
    assert.equal(byId.get('net').band, 'nonMoving');
    assert.equal(byId.get('critical').band, 'critical');
    assert.equal(byId.get('edge29').idleDays, 29);
    assert.equal(byId.get('edge29').band, 'nonMoving');
    assert.equal(byId.get('rolled').quantity, 17);
    assert.equal(byId.get('rolled').lastDelivery, '');
    assert.equal(byId.get('rolled').idleDays, 88);
    assert.equal(byId.get('received').lastDelivery, '');
    assert.equal(byId.get('received').idleDays, 58);
    assert.equal(byId.get('received').value, 320);
    assert.equal(byId.get('pendingOnly').idleDays, 331);
    assert.equal(byId.get('drafted').lastDelivery, '');
    assert.deepEqual(result.nonMoving.items.slice(0, 2).map((row) => row.id), ['drafted', 'pendingOnly']);
});

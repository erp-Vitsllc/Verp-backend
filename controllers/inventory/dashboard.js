import InventoryItem from '../../models/inventory/InventoryItem.js';
import ItemCategory from '../../models/inventory/ItemCategory.js';
import ItemSubcategory from '../../models/inventory/ItemSubcategory.js';
import InventoryVendor from '../../models/inventory/InventoryVendor.js';
import InventoryStockEntry from '../../models/inventory/InventoryStockEntry.js';
import DeliveryOrder from '../../models/inventory/DeliveryOrder.js';
import { dubaiDateKey } from '../../utils/workOrderNumber.js';
import { buildInventoryDashboard, collectYears, parseDashboardScope } from '../../utils/inventoryDashboard.js';
import { httpError, sendError } from './http.js';

function dateKey(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return dubaiDateKey(date);
}

function billStatus(status) {
    if (status === 'posted') return 'Approved';
    if (status === 'pending' || status === 'posting') return 'Pending';
    return 'Draft';
}

function reservationOf(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function purchaseLines(lines) {
    return (lines || []).map((line) => ({
        itemId: line?.itemId ? String(line.itemId) : '',
        quantity: Number(line?.quantity) || 0,
        unitPrice: Number(line?.unitPrice) || 0,
        total: Number(line?.total) || 0,
    }));
}

async function loadModel() {
    const [items, categories, subcategories, vendors, entries, deliveries] = await Promise.all([
        InventoryItem.find()
            .select('description itemCode modelNumber unitOfMeasure categoryId subcategoryId availableQuantity lastStockPrice createdAt')
            .lean(),
        ItemCategory.find().select('name').lean(),
        ItemSubcategory.find().select('reservationQuantity').lean(),
        InventoryVendor.find().select('name').lean(),
        InventoryStockEntry.find({ status: { $in: ['draft', 'pending', 'posting', 'posted'] } })
            .select('status purchaseSource vendorId purchaseDate postedAt createdAt billNo lines.itemId lines.quantity lines.unitPrice lines.total')
            .lean(),
        DeliveryOrder.find({ status: 'Confirmed' })
            .select('status doDate createdAt lines.inventoryItemId lines.quantity')
            .lean(),
    ]);
    const categoryNames = new Map(categories.map((row) => [String(row._id), row.name || '']));
    const reservations = new Map(subcategories.map((row) => [String(row._id), row.reservationQuantity]));
    const vendorNames = new Map(vendors.map((row) => [String(row._id), row.name || '']));
    return {
        items: items.map((row) => ({
            id: String(row._id),
            description: row.description || '',
            itemCode: row.itemCode || '',
            modelNumber: row.modelNumber || '',
            unit: row.unitOfMeasure || '',
            categoryName: categoryNames.get(String(row.categoryId || '')) || 'Uncategorized',
            subcategoryId: row.subcategoryId ? String(row.subcategoryId) : '',
            reservation: reservationOf(reservations.get(String(row.subcategoryId || ''))),
            available: Number(row.availableQuantity) || 0,
            lastPrice: Number(row.lastStockPrice) || 0,
            createdOn: dateKey(row.createdAt),
        })),
        purchases: entries.map((row) => {
            const manual = row.purchaseSource === 'manual' || !row.vendorId;
            const vendorId = manual ? '' : String(row.vendorId);
            return {
                id: String(row._id),
                billNo: row.billNo || '',
                vendorId,
                vendorName: manual ? 'Manual' : (vendorNames.get(vendorId) || 'Vendor'),
                date: dateKey(row.purchaseDate) || dateKey(row.postedAt) || dateKey(row.createdAt),
                status: billStatus(row.status),
                lines: purchaseLines(row.lines),
            };
        }),
        categoryNames: [...new Set([...categoryNames.values()].map((name) => String(name || '').trim()).filter(Boolean))],
        deliveries: deliveries.map((row) => ({
            id: String(row._id),
            date: (/^\d{4}-\d{2}-\d{2}$/.test(row.doDate || '') ? row.doDate : '') || dateKey(row.createdAt),
            status: 'Confirmed',
            lines: (row.lines || []).map((line) => ({
                itemId: line?.inventoryItemId ? String(line.inventoryItemId) : '',
                quantity: Number(line?.quantity) || 0,
            })),
        })),
    };
}

export async function getInventoryDashboard(req, res) {
    try {
        const today = dubaiDateKey();
        let scope;
        try {
            scope = parseDashboardScope(req.query, today);
        } catch (error) {
            throw httpError(400, error.message);
        }
        const model = await loadModel();
        const asOf = (window) => (today < window.end ? today : window.end);
        const current = buildInventoryDashboard(model, scope, asOf(scope));
        const previous = buildInventoryDashboard(model, scope.previous, asOf(scope.previous));
        res.json({
            range: {
                mode: scope.mode,
                start: scope.start,
                end: scope.end,
                label: scope.label,
                year: scope.year,
                months: scope.months,
            },
            years: collectYears(model, [Number(today.slice(0, 4)), scope.year]),
            stats: current.stats,
            previous: previous.stats,
            categories: current.categories,
            monthly: current.monthly,
            vendors: current.vendors,
            lowStock: current.lowStock,
            purchases: current.purchases,
            priceChanges: current.priceChanges,
            stockGraph: current.stockGraph,
            purchaseGraph: current.purchaseGraph,
            deliveryGraph: current.deliveryGraph,
            nonMoving: current.nonMoving,
            stockByCategory: current.stockByCategory,
            stockStatus: current.stockStatus,
            billStatus: current.billStatus,
        });
    } catch (error) {
        sendError(res, error);
    }
}

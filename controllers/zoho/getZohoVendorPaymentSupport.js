import ZohoBill from '../../models/ZohoBill.js';
import ZohoExpense from '../../models/ZohoExpense.js';
import {
    fetchLocations,
    fetchNextVendorPaymentNumber,
    fetchPaymentAccounts,
    fetchPaymentModes,
    fetchVendorBills,
    fetchVendorContact,
    fetchVendorExpenses,
    getZohoOrganizationId,
} from '../../services/zohoService.js';
import {
    toZohoBillApiShape,
    toZohoExpenseApiShape,
} from '../../utils/zohoPurchaseMappers.js';
import { buildVendorPaymentDefaults } from './buildVendorPaymentDefaults.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

async function listOpenVendorBillsFromDb(vendorId) {
    const organizationId = getZohoOrganizationId();
    const docs = await ZohoBill.find({
        organizationId,
        isActive: true,
        vendorId: String(vendorId).trim(),
        balance: { $gt: 0 },
    })
        .select('-zohoRaw')
        .sort({ date: -1 })
        .lean();

    return docs.map(toZohoBillApiShape).filter(Boolean);
}

async function listOpenVendorExpensesFromDb(vendorId) {
    const organizationId = getZohoOrganizationId();
    const docs = await ZohoExpense.find({
        organizationId,
        isActive: true,
        vendorId: String(vendorId).trim(),
        status: { $nin: ['reimbursed', 'invoiced', 'void', 'deleted'] },
    })
        .select('-zohoRaw')
        .sort({ date: -1 })
        .lean();

    return docs
        .map(toZohoExpenseApiShape)
        .filter(Boolean)
        .filter((expense) => {
            const total = Number(expense.total ?? expense.amount) || 0;
            return total > 0;
        });
}

async function loadVendorPayables(vendorId) {
    const id = String(vendorId || '').trim();
    if (!id) {
        return { bills: [], expenses: [], source: 'none' };
    }

    const [zohoBillsResult, zohoExpensesResult, dbBills, dbExpenses] = await Promise.all([
        fetchVendorBills({ vendorId: id })
            .then((rows) => ({ ok: true, rows }))
            .catch((error) => ({ ok: false, rows: [], error })),
        fetchVendorExpenses({ vendorId: id })
            .then((rows) => ({ ok: true, rows }))
            .catch((error) => ({ ok: false, rows: [], error })),
        listOpenVendorBillsFromDb(id).catch(() => []),
        listOpenVendorExpensesFromDb(id).catch(() => []),
    ]);

    if (!zohoBillsResult.ok && zohoBillsResult.error) {
        console.warn(
            '[ZohoVendorPaymentSupport] Bills from Zoho failed:',
            zohoBillsResult.error?.message || zohoBillsResult.error,
        );
    }
    if (!zohoExpensesResult.ok && zohoExpensesResult.error) {
        console.warn(
            '[ZohoVendorPaymentSupport] Expenses from Zoho failed:',
            zohoExpensesResult.error?.message || zohoExpensesResult.error,
        );
    }

    const bills = zohoBillsResult.rows?.length ? zohoBillsResult.rows : dbBills;
    const expenses = zohoExpensesResult.rows?.length ? zohoExpensesResult.rows : dbExpenses;

    return {
        bills,
        expenses,
        source:
            zohoBillsResult.ok || zohoExpensesResult.ok
                ? bills === zohoBillsResult.rows || expenses === zohoExpensesResult.rows
                    ? 'zoho+database'
                    : 'zoho'
                : 'database',
    };
}

export const getZohoVendorPaymentSupport = async (req, res) => {
    try {
        const vendorId = String(req.query?.vendorId || '').trim();
        const accountsOnly = String(req.query?.accountsOnly || '').toLowerCase() === 'true';

        // Cheap path for cross-org Paid Through / Fine Payable dropdown: full Chart of Accounts.
        if (accountsOnly) {
            const includeInactive =
                String(req.query?.includeInactive || '').toLowerCase() === 'true' ||
                String(req.query?.includeInactive || '').trim() === '1' ||
                // default true: same complete CoA as Fine / Utility Bills
                req.query?.includeInactive === undefined;
            const accounts = await fetchPaymentAccounts({ includeInactive });
            return res.status(200).json({
                success: true,
                data: { accounts },
                meta: { accountCount: accounts.length, includeInactive },
            });
        }
        const [accounts, payables, locations, paymentModes, vendorContact, nextPaymentNumber] =
            await Promise.all([
                fetchPaymentAccounts({ includeInactive: true }),
                vendorId
                    ? loadVendorPayables(vendorId)
                    : Promise.resolve({ bills: [], expenses: [], source: 'none' }),
                fetchLocations(),
                fetchPaymentModes(),
                vendorId ? fetchVendorContact(vendorId) : Promise.resolve(null),
                fetchNextVendorPaymentNumber().catch(() => ''),
            ]);

        const vendorDefaults = buildVendorPaymentDefaults(vendorContact || null, locations);

        return res.status(200).json({
            success: true,
            data: {
                accounts,
                bills: payables.bills,
                expenses: payables.expenses,
                locations,
                paymentModes,
                vendorDefaults,
                nextPaymentNumber: String(nextPaymentNumber || '').trim(),
            },
            meta: {
                accountCount: accounts.length,
                billCount: payables.bills.length,
                expenseCount: payables.expenses.length,
                locationCount: locations.length,
                paymentModeCount: paymentModes.length,
                source: payables.source || 'zoho',
            },
        });
    } catch (error) {
        console.error('[ZohoVendorPaymentSupport] Failed:', error?.message || error);

        const message = error?.message || 'Failed to fetch Zoho payment support data';

        return res.status(mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};

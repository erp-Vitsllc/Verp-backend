import {
    fetchLocations,
    fetchNextVendorPaymentNumber,
    fetchPaymentAccounts,
    fetchPaymentModes,
    fetchVendorBills,
    fetchVendorContact,
    fetchVendorExpenses,
} from '../../services/zohoService.js';
import { buildVendorPaymentDefaults } from './buildVendorPaymentDefaults.js';
import { mapZohoErrorStatus } from './zohoVendorPaymentUtils.js';

export const getZohoVendorPaymentSupport = async (req, res) => {
    try {
        const vendorId = String(req.query?.vendorId || '').trim();
        const [accounts, bills, expenses, locations, paymentModes, vendorContact, nextPaymentNumber] =
            await Promise.all([
                fetchPaymentAccounts(),
                vendorId ? fetchVendorBills({ vendorId }) : Promise.resolve([]),
                vendorId ? fetchVendorExpenses({ vendorId }) : Promise.resolve([]),
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
                bills,
                expenses,
                locations,
                paymentModes,
                vendorDefaults,
                nextPaymentNumber: String(nextPaymentNumber || '').trim(),
            },
            meta: {
                accountCount: accounts.length,
                billCount: bills.length,
                expenseCount: expenses.length,
                locationCount: locations.length,
                paymentModeCount: paymentModes.length,
                source: 'zoho',
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

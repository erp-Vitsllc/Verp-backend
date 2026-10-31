import { getAedCurrencyRates } from '../../utils/currencyRates.js';

export async function getCurrencyRates(_req, res) {
    const payload = await getAedCurrencyRates();
    return res.status(200).json({
        base: 'AED',
        rates: payload.rates,
        updatedAt: payload.updatedAt,
        source: payload.source,
    });
}

const RATES_URL = 'https://open.er-api.com/v6/latest/AED';
const CACHE_MS = 6 * 60 * 60 * 1000;

/** Units of each currency for 1 AED. Used when the live rate feed is unavailable. */
const FALLBACK_PER_AED = {
    AED: 1,
    USD: 0.2723,
    EUR: 0.251,
    GBP: 0.211,
    INR: 24.1,
    PKR: 75.8,
    BDT: 32.6,
    LKR: 82,
    NPR: 38.5,
    PHP: 15.6,
    SAR: 1.021,
    QAR: 0.991,
    OMR: 0.105,
    KWD: 0.083,
    BHD: 0.103,
    EGP: 13.4,
    JOD: 0.193,
    CNY: 1.95,
    JPY: 41.2,
    KRW: 375,
    SGD: 0.36,
    MYR: 1.18,
    THB: 9.3,
    IDR: 4350,
    AUD: 0.415,
    CAD: 0.375,
    ZAR: 4.9,
    NGN: 420,
    KES: 35,
    GHS: 3.4,
};

let cache = { at: 0, rates: null };

export async function getAedCurrencyRates() {
    if (cache.rates && Date.now() - cache.at < CACHE_MS) {
        return { rates: cache.rates, updatedAt: new Date(cache.at).toISOString(), source: 'cache' };
    }
    try {
        const response = await fetch(RATES_URL);
        const data = await response.json();
        const live = data?.result === 'success' ? data.rates : data?.rates;
        if (live && Number(live.INR) > 0 && Number(live.USD) > 0) {
            cache = {
                at: Date.now(),
                rates: { ...FALLBACK_PER_AED, ...live, AED: 1 },
            };
            return { rates: cache.rates, updatedAt: new Date(cache.at).toISOString(), source: 'live' };
        }
    } catch (error) {
        console.error('[currencyRates]', error?.message || error);
    }
    const rates = cache.rates || { ...FALLBACK_PER_AED };
    return {
        rates,
        updatedAt: cache.at ? new Date(cache.at).toISOString() : null,
        source: 'fallback',
    };
}

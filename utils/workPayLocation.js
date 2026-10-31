const DUBAI_TZ = 'Asia/Dubai';

export function zoneOffsetMinutes(timeZone, date = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(date);
        const pick = (type) => parts.find((part) => part.type === type)?.value;
        let hour = Number(pick('hour'));
        if (hour === 24) hour = 0;
        const asUtc = Date.UTC(
            Number(pick('year')),
            Number(pick('month')) - 1,
            Number(pick('day')),
            hour,
            Number(pick('minute')),
            Number(pick('second')),
        );
        return Math.round((asUtc - date.getTime()) / 60000);
    } catch {
        return null;
    }
}

/** Minutes to add to a UAE clock to show that same moment in the employee's zone. */
export function clockShiftMinutes(timeZone, date = new Date()) {
    const zone = String(timeZone || '').trim();
    if (!zone || zone === DUBAI_TZ) return 0;
    const local = zoneOffsetMinutes(zone, date);
    const dubai = zoneOffsetMinutes(DUBAI_TZ, date);
    if (local == null || dubai == null) return 0;
    return local - dubai;
}

export function shiftClockLabel(value, minutes) {
    const delta = Number(minutes) || 0;
    const raw = String(value || '').trim();
    if (!delta || !raw || raw === '—') return raw;
    const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return raw;
    let total = Number(match[1]) * 60 + Number(match[2]) + delta;
    total = ((total % 1440) + 1440) % 1440;
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return match[3] != null ? `${hh}:${mm}:${match[3]}` : `${hh}:${mm}`;
}

const UAE_PAY = {
    workLocation: 'uae',
    workingFromCountry: 'United Arab Emirates',
    workingFromCountryCode: 'AE',
    salaryCurrency: 'AED',
    workTimeZone: DUBAI_TZ,
};

/**
 * Work location on add/edit employee.
 * UAE keeps dirhams. Outside UAE requires a country, its currency, and a time zone.
 */
export function normalizeWorkPay(body) {
    const location = String(body?.workLocation || 'uae').trim().toLowerCase() === 'outside_uae'
        ? 'outside_uae'
        : 'uae';
    if (location === 'uae') {
        return { errors: [], value: { ...UAE_PAY } };
    }
    const code = String(body?.workingFromCountryCode || '').trim().toUpperCase();
    const name = String(body?.workingFromCountry || '').trim();
    const currency = String(body?.salaryCurrency || '').trim().toUpperCase();
    const zone = String(body?.workTimeZone || '').trim();
    const errors = [];
    if (!/^[A-Z]{2}$/.test(code) || code === 'AE' || !name) {
        errors.push('Select the country the employee is working from');
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
        errors.push('Salary paying currency is required');
    }
    if (!/^[A-Za-z0-9_+-]+\/[A-Za-z0-9_+-]+/.test(zone) || zone === DUBAI_TZ) {
        errors.push('Working country time zone is missing');
    }
    return {
        errors,
        value: {
            workLocation: 'outside_uae',
            workingFromCountry: name,
            workingFromCountryCode: code,
            salaryCurrency: currency,
            workTimeZone: zone,
        },
    };
}

export function payLocationFromEmployee(employee) {
    const outside = String(employee?.workLocation || '').toLowerCase() === 'outside_uae';
    return {
        workLocation: outside ? 'outside_uae' : 'uae',
        workingFromCountry: outside ? String(employee?.workingFromCountry || '').trim() : '',
        workingFromCountryCode: outside ? String(employee?.workingFromCountryCode || '').trim().toUpperCase() : 'AE',
        salaryCurrency: outside ? String(employee?.salaryCurrency || 'AED').trim().toUpperCase() : 'AED',
        workTimeZone: outside ? String(employee?.workTimeZone || '').trim() : DUBAI_TZ,
    };
}

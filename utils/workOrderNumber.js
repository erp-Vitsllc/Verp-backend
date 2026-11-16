const NUMBER_PATTERN = /^WO-(\d{2}|\d{4})-(\d+)$/;

const DUBAI_DATE = { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' };

export function workOrderYear(date = new Date()) {
    return Number(dubaiDateKey(date).slice(0, 4));
}

/** Calendar date in Dubai, as YYYY-MM-DD. */
export function dubaiDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', DUBAI_DATE).format(date);
}

export function formatWorkOrderNo(year, sequence) {
    const yr = Number(year);
    const seq = Number(sequence);
    if (!Number.isInteger(yr) || yr < 2000 || yr > 9999) {
        throw new Error('Invalid work order year');
    }
    if (!Number.isInteger(seq) || seq < 1) {
        throw new Error('Invalid work order sequence');
    }
    const shortYear = String(yr % 100).padStart(2, '0');
    return `WO-${shortYear}-${String(seq).padStart(3, '0')}`;
}

function fullYear(yearText) {
    const year = Number(yearText);
    return yearText.length === 2 ? 2000 + year : year;
}

export function parseWorkOrderNo(value) {
    const match = String(value || '').trim().match(NUMBER_PATTERN);
    if (!match) return null;
    const year = fullYear(match[1]);
    const sequence = Number(match[2]);
    if (!Number.isInteger(year) || !Number.isInteger(sequence) || sequence < 1) return null;
    return { year, sequence };
}

/** Next count for that year. Other years do not continue this sequence. */
export function nextSequenceForYear(year, workOrderNumbers) {
    const targetYear = Number(year);
    let max = 0;
    for (const value of workOrderNumbers || []) {
        const parsed = parseWorkOrderNo(value);
        if (parsed && parsed.year === targetYear && parsed.sequence > max) {
            max = parsed.sequence;
        }
    }
    return max + 1;
}

export function nextWorkOrderNo(workOrderNumbers, date = new Date()) {
    const year = workOrderYear(date);
    return formatWorkOrderNo(year, nextSequenceForYear(year, workOrderNumbers));
}

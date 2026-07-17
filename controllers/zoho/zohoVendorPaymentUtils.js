export function mapZohoErrorStatus(message) {
    return /not connected|not configured|re-authorize|not authorized|authorization|oauth/i.test(message)
        ? 503
        : 502;
}

export function toFiniteAmount(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : NaN;
}

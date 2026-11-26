const SECTION_PATH = {
    lpo: 'lpo',
    'actual-boq': 'quotation/actual',
    actual: 'quotation/actual',
    mr: 'quotation/mr',
    'vendor-lpo': 'quotation/vendor-lpo',
    quotation: 'quotation',
    overview: 'overview',
};

/** Address for a work order and the tab that should still be open after refresh or Back. */
export function workOrderDetailsPath(id, section = 'overview') {
    const safeId = encodeURIComponent(String(id || '').trim());
    if (!safeId) return '/production/work-order';
    const key = String(section || 'overview').trim().toLowerCase();
    const tail = SECTION_PATH[key] || 'overview';
    return `/production/work-order/${safeId}/${tail}`;
}

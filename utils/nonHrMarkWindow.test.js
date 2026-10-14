import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nonHrMarkableDateKeys } from './nonHrMarkWindow.js';

describe('nonHrMarkableDateKeys', () => {
    it('includes today and the seven previous calendar days', () => {
        const allowed = nonHrMarkableDateKeys('2026-10-14', []);
        assert.deepEqual([...allowed], [
            '2026-10-14',
            '2026-10-13',
            '2026-10-12',
            '2026-10-11',
            '2026-10-10',
            '2026-10-09',
            '2026-10-08',
            '2026-10-07',
        ]);
    });

    it('counts a holiday as one of the seven days', () => {
        const allowed = nonHrMarkableDateKeys('2026-10-05', ['2026-10-04']);
        assert.equal(allowed.has('2026-10-05'), true);
        assert.equal(allowed.has('2026-10-04'), true);
        assert.equal(allowed.has('2026-09-28'), true);
        assert.equal(allowed.has('2026-09-27'), false);
    });
});

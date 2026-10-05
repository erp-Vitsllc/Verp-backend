import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nonHrMarkableDateKeys } from './nonHrMarkWindow.js';

describe('nonHrMarkableDateKeys', () => {
    it('skips a Sunday holiday so Monday includes Saturday and Friday', () => {
        const allowed = nonHrMarkableDateKeys('2026-10-05', ['2026-10-04']);
        assert.deepEqual([...allowed], ['2026-10-05', '2026-10-03', '2026-10-02']);
    });

    it('uses the three calendar days when no holiday falls in the lookback', () => {
        const allowed = nonHrMarkableDateKeys('2026-10-03', []);
        assert.deepEqual([...allowed], ['2026-10-03', '2026-10-02', '2026-10-01']);
    });

    it('skips consecutive holidays and still keeps today', () => {
        const allowed = nonHrMarkableDateKeys('2026-10-05', ['2026-10-04', '2026-10-03']);
        assert.deepEqual([...allowed], ['2026-10-05', '2026-10-02', '2026-10-01']);
    });

    it('keeps today when today is the holiday', () => {
        const allowed = nonHrMarkableDateKeys('2026-10-04', ['2026-10-04']);
        assert.deepEqual([...allowed], ['2026-10-04', '2026-10-03', '2026-10-02']);
    });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import mongoose from 'mongoose';
import {
    assigneeAcceptChannel,
    canLoginThroughAnyChannel,
    loginThroughFlagsAreLoaded,
} from './loginThrough.js';

const probeSchema = new mongoose.Schema({
    employeeId: String,
    loginThrough: {
        portalApp: { type: Boolean },
        web: { type: Boolean },
    },
});
const Probe = mongoose.models.LoginThroughProbe || mongoose.model('LoginThroughProbe', probeSchema);

function employeeWithoutLoginThroughSelected() {
    const doc = new Probe(undefined, { employeeId: 1 }, true);
    doc.init({
        _id: new mongoose.Types.ObjectId(),
        employeeId: 'VEGA-HR-00003',
    });
    return doc;
}

describe('loginThroughFlagsAreLoaded', () => {
    it('treats a mongoose document that did not select loginThrough as not loaded', () => {
        const doc = employeeWithoutLoginThroughSelected();
        assert.equal(typeof doc.loginThrough, 'object');
        assert.equal(canLoginThroughAnyChannel(doc), false);
        assert.equal(loginThroughFlagsAreLoaded(doc), false);
    });

    it('treats stored Web and App flags as loaded', () => {
        const source = { loginThrough: { portalApp: true, web: true } };
        assert.equal(loginThroughFlagsAreLoaded(source), true);
        assert.equal(canLoginThroughAnyChannel(source), true);
    });

    it('treats both channels explicitly off as loaded', () => {
        const source = { loginThrough: { portalApp: false, web: false } };
        assert.equal(loginThroughFlagsAreLoaded(source), true);
        assert.equal(canLoginThroughAnyChannel(source), false);
    });
});

describe('assigneeAcceptChannel', () => {
    it('uses web when web is on, even if app is also on', () => {
        assert.equal(assigneeAcceptChannel({ loginThrough: { portalApp: true, web: true } }), 'web');
    });

    it('uses the app when web is off and app is on', () => {
        assert.equal(assigneeAcceptChannel({ loginThrough: { portalApp: true, web: false } }), 'app');
    });

    it('returns null when neither channel is on', () => {
        assert.equal(assigneeAcceptChannel({ loginThrough: { portalApp: false, web: false } }), null);
    });
});

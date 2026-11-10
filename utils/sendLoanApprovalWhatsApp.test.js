import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLoanApprovalWhatsAppCaption,
    loanEmployeeWhatsAppNote,
} from './sendLoanApprovalWhatsApp.js';

test('caption names the loan so a later send can see it was already delivered', () => {
    const caption = buildLoanApprovalWhatsAppCaption({
        type: 'Loan',
        loanId: 'VEGA-LON-0005',
        amount: 1000,
    });
    assert.match(caption, /VEGA-LON-0005/);
    assert.match(caption, /AED 1,000/);
});

test('no company email without a WhatsApp number is stated plainly', () => {
    assert.equal(
        loanEmployeeWhatsAppNote({ sent: false, reason: 'no_whatsapp' }),
        'This employee has no company email and no WhatsApp number, so the PDF was not sent to them.',
    );
});

test('a successful WhatsApp send is stated as sent', () => {
    assert.equal(
        loanEmployeeWhatsAppNote({ sent: true, reason: 'whatsapp' }),
        'Acknowledgment PDF sent to the employee on WhatsApp.',
    );
});

test('company email does not add a WhatsApp sentence', () => {
    assert.equal(
        loanEmployeeWhatsAppNote({ sent: false, reason: 'has_company_email' }),
        '',
    );
});

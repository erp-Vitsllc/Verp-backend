import mongoose from 'mongoose';
import Fine from '../../models/Fine.js';
import Payment from '../../models/Payment.js';
import EmployeeBasic from '../../models/EmployeeBasic.js';
import { isUserInFlowchart } from '../../utils/getDepartmentHOD.js';
import { withZohoOrganization } from '../../utils/zohoOrgContext.js';
import {
    resolveEmployeeFinePayableAmount,
    resolvePrimaryEmployeeId,
} from '../../utils/finePayableAmount.js';
import { createOpenZohoVendorCredit } from '../zoho/postZohoVendorCredit.js';
import { mapZohoErrorStatus } from '../zoho/zohoVendorPaymentUtils.js';

async function findFine(id) {
    const raw = String(id || '').trim();
    if (!raw) return null;
    if (mongoose.Types.ObjectId.isValid(raw) && String(new mongoose.Types.ObjectId(raw)) === raw) {
        const byId = await Fine.findById(raw);
        if (byId) return byId;
    }
    return Fine.findOne({ fineId: raw });
}

async function findEmployee(paidBy) {
    if (!paidBy) return null;
    const value = String(paidBy).trim();
    let employee = await EmployeeBasic.findOne({ employeeId: value });
    if (!employee && /^[0-9a-fA-F]{24}$/.test(value)) {
        employee = await EmployeeBasic.findById(value);
    }
    return employee;
}

export const postFineVendorCredit = async (req, res) => {
    try {
        const isAccountsUser = await isUserInFlowchart(req.user, 'accounts');
        if (!isAccountsUser && req.user?.isAdmin !== true) {
            return res.status(403).json({
                success: false,
                message: 'Only Accounts can create a Zoho vendor credit from a fine.',
            });
        }

        const fine = await findFine(req.params?.id);
        if (!fine) {
            return res.status(404).json({ success: false, message: 'Fine not found.' });
        }

        const body = req.body || {};
        const organizationId = String(
            body.zohoOrganizationId || body.organizationId || fine.zohoOrganizationId || '',
        ).trim();
        if (!organizationId) {
            return res.status(400).json({
                success: false,
                message: 'Select a Zoho organization.',
            });
        }

        const employeeId =
            String(body.employeeId || body.paidBy || '').trim() || resolvePrimaryEmployeeId(fine);
        const employee = await findEmployee(employeeId);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found for this fine payment.',
            });
        }

        const result = await withZohoOrganization(organizationId, () =>
            createOpenZohoVendorCredit(body),
        );

        const creditTotal = Number(result.total);
        const fallbackAmount = Number(body.amount);
        const amount =
            Number.isFinite(creditTotal) && creditTotal > 0
                ? creditTotal
                : Number.isFinite(fallbackAmount) && fallbackAmount > 0
                  ? fallbackAmount
                  : 0;

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Vendor credit amount must be greater than 0.',
            });
        }

        const paymentCount = await Payment.countDocuments();
        const payment = new Payment({
            paymentId: `PAY-${String(paymentCount + 1).padStart(6, '0')}`,
            paymentType: 'Fine',
            paidBy: employee._id,
            paidByName: `${employee.firstName || ''} ${employee.lastName || ''}`.trim(),
            amount,
            status: 'Completed',
            paymentDate: body.date || new Date(),
            description:
                String(body.notes || '').trim() ||
                `Vendor Credit · Fine ${fine.fineId || ''}`.trim(),
            remarks: `Vendor Credit ${result.vendorCreditNumber || result.vendorCreditId} · Open`,
            referenceId: fine.fineId,
            relatedEntityType: 'Fine',
            relatedEntityId: fine._id,
            createdBy: req.user?._id,
            updatedBy: req.user?._id,
            paymentSource: 'Cash',
            zohoOrganizationId: organizationId,
            expenseAccountId: String(
                body.expenseAccountId || body.line_items?.[0]?.account_id || '',
            ).trim(),
            expenseAccountName: String(body.expenseAccountName || '').trim(),
            vendorId: String(body.vendor_id || body.vendorId || '').trim(),
            vendorName: String(body.vendorName || '').trim(),
            locationId: String(body.location_id || body.locationId || '').trim(),
            taxTreatment: String(body.tax_treatment || body.taxTreatment || '').trim(),
            placeOfSupply: String(body.place_of_supply || body.placeOfSupply || '').trim(),
            taxId: String(body.tax_id || body.taxId || body.line_items?.[0]?.tax_id || '').trim(),
            isInclusiveTax: body.is_inclusive_tax === true || body.isInclusiveTax === true,
            zohoVendorCreditId: result.vendorCreditId,
            zohoVendorCreditNumber: result.vendorCreditNumber,
        });
        await payment.save();

        const paymentQuery = {
            relatedEntityType: 'Fine',
            status: 'Completed',
            $or: [{ relatedEntityId: fine._id }],
        };
        if (fine.fineId) paymentQuery.$or.push({ referenceId: fine.fineId });

        const allPayments = await Payment.find(paymentQuery);
        const totalPaid = allPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        fine.paidAmount = totalPaid;
        fine.zohoVendorCreditId = result.vendorCreditId;
        fine.zohoVendorCreditNumber = result.vendorCreditNumber;
        if (organizationId) fine.zohoOrganizationId = organizationId;

        const employeeShare = resolveEmployeeFinePayableAmount(fine, employee.employeeId);
        if (employeeShare - totalPaid <= 0.01) {
            fine.fineStatus = 'Paid';
        }
        await fine.save();

        return res.status(201).json({
            success: true,
            message: `Vendor credit ${result.vendorCreditNumber || result.vendorCreditId} created in Zoho as Open.`,
            payment,
            fine,
            zohoSync: {
                ok: true,
                vendorCreditId: result.vendorCreditId,
                vendorCreditNumber: result.vendorCreditNumber,
                status: result.status,
            },
        });
    } catch (error) {
        console.error('[FineVendorCredit] Failed:', error?.message || error);
        const message = error?.message || 'Failed to create vendor credit in Zoho Books';
        const isValidationError = /required|YYYY-MM-DD|at least one|must use|greater than/i.test(
            message,
        );
        return res.status(isValidationError ? 400 : mapZohoErrorStatus(message)).json({
            success: false,
            message,
        });
    }
};

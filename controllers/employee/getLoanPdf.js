import Loan from "../../models/Loan.js";
import User from "../../models/User.js";
import { getLoanAcknowledgmentPdfBuffer } from "../../utils/persistLoanApprovalAttachments.js";
import { generatePdf } from "../../utils/generatePdf.js";
import { resolveFrontendBaseUrl } from '../../utils/resolveFrontendBaseUrl.js';

export const getLoanPdf = async (req, res) => {
    try {
        const { id } = req.params;
        const requestingUserId = req.user?.id;

        const cleanId = id.includes('-') ? id.split('-').pop() : id;

        const loan = await Loan.findById(cleanId);
        if (!loan) {
            console.error(`[getLoanPdf] Loan not found: ${id} (Cleaned: ${cleanId})`);
            return res.status(404).json({ message: "Loan request not found" });
        }

        const isApproved = ['Approved', 'Paid'].includes(loan.approvalStatus || loan.status);

        if (isApproved) {
            const pdfBuffer = await getLoanAcknowledgmentPdfBuffer(loan);
            if (pdfBuffer?.length > 500) {
                const typeSlug = loan.type === 'Advance' ? 'Advance' : 'Loan';
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader(
                    'Content-Disposition',
                    `attachment; filename=${typeSlug}_Acknowledgment_${loan.loanId || loan._id}.pdf`,
                );
                res.setHeader('Content-Length', pdfBuffer.length);
                return res.send(pdfBuffer);
            }
        }

        try {
            const baseUrl = resolveFrontendBaseUrl(req);
            const typeSlug = loan.type ? loan.type.replace(/\s+/g, '-') : 'Loan';
            const loanUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${loan._id}`;
            const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;

            const userObj = await User.findById(requestingUserId);
            const userPayload = {
                id: requestingUserId,
                isAdmin: userObj?.isAdmin || userObj?.role === 'Admin',
                role: userObj?.role,
                employeeId: userObj?.employeeId
            };

            const permissions = {
                hrm_loan: { isView: true, isActive: true }
            };

            const pdfBuffer = await generatePdf(loanUrl, token, userPayload, permissions);

            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=Loan_Application_${loan.loanId || loan._id}.pdf`);
            res.setHeader('Content-Length', pdfBuffer.length);
            res.send(pdfBuffer);
        } catch (error) {
            console.error("Failed to generate PDF:", error);
            res.status(500).json({ message: "Failed to generate PDF" });
        }
    } catch (error) {
        console.error("Error in getLoanPdf:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "Invalid loan ID format" });
        }
        res.status(500).json({ message: "Internal server error" });
    }
};

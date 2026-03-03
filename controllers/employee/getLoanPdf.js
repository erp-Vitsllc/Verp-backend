import { generatePdf } from "../../utils/generatePdf.js";
import Loan from "../../models/Loan.js";
import User from "../../models/User.js";

export const getLoanPdf = async (req, res) => {
    try {
        const { id } = req.params;
        const requestingUserId = req.user?.id;

        // Clean ID just in case (handles prefixes like Loan- or Advance-)
        const cleanId = id.includes('-') ? id.split('-').pop() : id;

        const loan = await Loan.findById(cleanId);
        if (!loan) {
            console.error(`[getLoanPdf] Loan not found: ${id} (Cleaned: ${cleanId})`);
            return res.status(404).json({ message: "Loan request not found" });
        }

        // Generate PDF
        try {
            const referer = req.headers.referer;
            const origin = req.headers.origin || (referer ? new URL(referer).origin : null);
            const baseUrl = origin || process.env.FRONTEND_URL || "http://localhost:3000";

            // Be consistent with the URL format used in other notifications
            const typeSlug = loan.type ? loan.type.replace(/\s+/g, '-') : 'Loan';
            const loanUrl = `${baseUrl}/HRM/LoanAndAdvance/${typeSlug}-${loan._id}`;
            const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;

            console.log("[getLoanPdf] PDF Generation Request:", {
                origin,
                baseUrl,
                loanUrl,
                hasToken: !!token,
                loanId: loan._id,
                requestingUserId
            });

            // Get user details for auth injection
            const userObj = await User.findById(requestingUserId);
            const userPayload = {
                id: requestingUserId,
                isAdmin: userObj?.isAdmin || userObj?.role === 'Admin',
                role: userObj?.role,
                employeeId: userObj?.employeeId
            };

            // Inject permission to view the loan module
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

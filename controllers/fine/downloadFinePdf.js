import Fine from "../../models/Fine.js";
import { generatePdf } from "../../utils/generatePdf.js";

/**
 * Download Fine Form PDF
 * Generates a PDF of the fine form for printing/signing.
 */
export const downloadFinePdf = async (req, res) => {
    try {
        const { id } = req.params;
        const { employeeId } = req.query; // Optional: If specific employee context needed

        // Verify Fine Exists
        // Handle ID or custom FineID
        let query = { fineId: id };
        const mongoose = await import("mongoose");
        if (mongoose.Types.ObjectId.isValid(id)) {
            query = { $or: [{ _id: id }, { fineId: id }] };
        }

        const fine = await Fine.findOne(query);
        if (!fine) {
            return res.status(404).json({ message: "Fine not found" });
        }

        // Construct Frontend URL
        const baseUrl = process.env.FRONTEND_URL || "http://localhost:3000";
        const printUrl = `${baseUrl}/HRM/Fine/${fine._id}`;

        console.log(`Generating Fine PDF from: ${printUrl}`);

        // Prepare Tokens for Puppeteer
        const token = req.headers.authorization?.split(' ')[1] || '';

        // Mock User Payload for Auth injection (similar to Loan PDF)
        const requestingUserId = req.user?.id;
        const User = await import("../../models/User.js").then(m => m.default);
        const userObj = await User.findById(requestingUserId);

        const userPayload = {
            id: requestingUserId,
            isAdmin: userObj?.isAdmin || userObj?.role === 'Admin',
            role: userObj?.role,
            employeeId: userObj?.employeeId
        };

        const permissions = {
            hrm_fine: { isView: true, isActive: true }
        };

        // Use the main app container selector (or body, since we want full page but CSS handles print view)
        // Loan PDF typically waits for network idle.
        const selector = 'body';

        const pdfBuffer = await generatePdf(printUrl, token, userPayload, permissions, selector);

        // Send PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="FineForm-${fine.fineId}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        console.error("Error generating Fine PDF:", error);
        res.status(500).json({ message: "Failed to generate PDF", error: error.message });
    }
};

import OutsideUaeDocumentType from "../models/OutsideUaeDocumentType.js";
import { escapeRegex } from "../utils/regexHelper.js";

export const getOutsideUaeDocumentTypes = async (req, res) => {
    try {
        const types = await OutsideUaeDocumentType.find({ status: "Active" }).sort({ name: 1 }).lean();
        res.status(200).json(types);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export const createOutsideUaeDocumentType = async (req, res) => {
    try {
        const name = String(req.body?.name || "").trim();
        if (name.length < 2) {
            return res.status(400).json({ message: "Document type must be at least 2 characters" });
        }
        if (name.length > 120) {
            return res.status(400).json({ message: "Document type must be no more than 120 characters" });
        }

        const existing = await OutsideUaeDocumentType.findOne({
            name: { $regex: new RegExp(`^${escapeRegex(name)}$`, "i") },
        });
        if (existing) {
            if (existing.status !== "Active") {
                existing.status = "Active";
                await existing.save();
            }
            return res.status(200).json(existing);
        }

        const created = await OutsideUaeDocumentType.create({ name });
        res.status(201).json(created);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

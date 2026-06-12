import axios from "axios";
import { log } from "console";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// Import pdf-parse - handle both named and default exports
const pdfParseModule = require("pdf-parse");
// Try to get PDFParse class from various possible export formats
const PDFParse = pdfParseModule.PDFParse ||
    (pdfParseModule.default && pdfParseModule.default.PDFParse) ||
    pdfParseModule;

const OCR_SPACE_ENDPOINT = "https://api.ocr.space/parse/image";
const SUPPORTED_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/jpg",
    "image/webp",
];
const MIN_TEXT_LENGTH_FOR_PARSER = 60;

// --- Helper Function: Date Formatting ---
const formatDate = (dateStr = "") => {
    const normalized = dateStr.trim();
    const match = normalized.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);

    if (!match) {
        if (normalized.length === 6 && !Number.isNaN(Number(normalized))) {
            const year = normalized.substring(0, 2);
            const month = normalized.substring(2, 4);
            const day = normalized.substring(4, 6);
            return formatDate(`${day}/${month}/${year}`);
        }
        return "";
    }

    let day = match[1].padStart(2, "0");
    let month = match[2].padStart(2, "0");
    let year = match[3];

    if (year.length === 2) {
        year = parseInt(year, 10) > 50 ? `19${year}` : `20${year}`;
    }

    return `${year}-${month}-${day}`;
};

// --- Core Function: Passport Detail Extraction ---
const extractPassportDetails = (text = "") => {
    // --- Safety Limit for Regex Processing ---
    // Prevent ReDoS by limiting the text length passed to complex regexes
    const MAX_TEXT_LENGTH = 15000;
    const safeText = text.length > MAX_TEXT_LENGTH ? text.substring(0, MAX_TEXT_LENGTH) : text;


    const cleanedText = safeText.replace(/\s+/g, " ").trim();
    const mrzReadyText = safeText.replace(/\r/g, "").trim();
    const originalText = safeText; // Keep original for better matching

    const result = {
        number: "",
        nationality: "",
        issueDate: "",
        expiryDate: "",
        placeOfIssue: "",
        dateOfBirth: "",
        sex: "",
        surname: "",
        givenNames: "",
        fatherName: "",
        motherName: "",
        spouseName: "",
        address: "",
    };

    // 1. MRZ Extraction (Highest Reliability) - Multiple patterns
    const mrzPatterns = [
        /([A-Z0-9<]{30,})\s*\n?\s*([A-Z0-9<]{30,})\s*$/m,
        /P<[A-Z]{3}([A-Z0-9<]{30,})\s*\n?\s*([A-Z0-9<]{30,})/m,
        /([A-Z0-9<]{40,})/g
    ];

    let mrzMatch = null;
    for (const pattern of mrzPatterns) {
        mrzMatch = mrzReadyText.match(pattern);
        if (mrzMatch && mrzMatch.length >= 2) break;
    }

    if (mrzMatch && mrzMatch.length >= 2) {
        const mrzLine1 = mrzMatch[1] || "";
        const mrzLine2 = mrzMatch[2] || "";

        if (mrzLine2.length >= 9) {
            result.number = mrzLine2.substring(0, 9).replace(/<| /g, "").trim();
        }

        if (mrzLine2.length >= 27) {
            const dobMrz = mrzLine2.substring(13, 19);
            const expiryMrz = mrzLine2.substring(21, 27);

            if (dobMrz.length === 6 && !dobMrz.includes("<")) {
                result.dateOfBirth = formatDate(dobMrz);
            }

            if (expiryMrz.length === 6 && !expiryMrz.includes("<")) {
                result.expiryDate = formatDate(expiryMrz);
            }

            if (mrzLine2.length > 20) {
                result.sex = mrzLine2.substring(20, 21);
            }
        }

        if (mrzLine1.length > 5) {
            const mrzNameSections = mrzLine1.substring(5).split("<<").filter(Boolean);
            if (mrzNameSections.length >= 1) {
                result.surname = mrzNameSections[0].replace(/<+/g, " ").trim();
            }
            if (mrzNameSections.length >= 2) {
                result.givenNames = mrzNameSections[1].replace(/<+/g, " ").trim();
            }
        }
    } else {
    }

    // 2. Passport Number - Multiple patterns
    if (!result.number) {
        const numberPatterns = [
            /(?:पासपोर्ट\s*न\.|Passport\s*(?:No\.?|Number|No)[:\s]*)([A-Z0-9]{6,12})/i,
            /Passport\s*No[.:\s]*([A-Z]{1,2}\d{6,9})/i,
            /([A-Z]{2}\d{6,9})/,
            /([A-Z]{1,2}\d{6,})/,
            /AF\d{6,}/i
        ];

        for (const pattern of numberPatterns) {
            const match = originalText.match(pattern);
            if (match && match[1] && match[1].length >= 7) {
                result.number = match[1].replace(/[^A-Z0-9]/gi, "").trim();
                break;
            }
        }
    }

    // 3. Nationality - Multiple patterns
    const nationalityPatterns = [
        /(?:राष्ट्रीयता|Nationality)[:\s]*([A-Z]+)/i,
        /(INDIAN|IND)/i,
        /भारतीय/i
    ];
    for (const pattern of nationalityPatterns) {
        const match = originalText.match(pattern);
        if (match) {
            result.nationality = match[1] || "INDIAN";
            break;
        }
    }

    // 4. Place of Issue - Multiple patterns
    const placePatterns = [
        /(?:जारी\s*करने\s*का\s*स्थान|Place\s*of\s*Issue)[:\s]*([A-Z][A-Z\s]{2,30})/i,
        /(COCHIN|MUMBAI|DELHI|KOLKATA|CHENNAI|BANGALORE|HYDERABAD|PUNE|AHMEDABAD)/i
    ];
    for (const pattern of placePatterns) {
        const match = originalText.match(pattern);
        if (match) {
            result.placeOfIssue = (match[1] || match[0]).trim();
            break;
        }
    }

    // 5. Issue Date - Multiple patterns
    const issueDatePatterns = [
        /(?:जारी\s*करने\s*की\s*तिथि|Date\s*of\s*Issue)[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
        /Issue[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
        /(\d{2}\/\d{2}\/\d{4})/g
    ];
    for (const pattern of issueDatePatterns) {
        const matches = originalText.match(pattern);
        if (matches) {
            const dateStr = matches[1] || matches[0];
            const formatted = formatDate(dateStr);
            if (formatted) {
                result.issueDate = formatted;
                break;
            }
        }
    }

    // 6. Expiry Date - Multiple patterns
    if (!result.expiryDate) {
        const expiryDatePatterns = [
            /(?:समाप्ति\s*की\s*तिथि|Date\s*of\s*Expiry)[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
            /Expiry[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
            /(\d{2}\/\d{2}\/\d{4})/g
        ];
        for (const pattern of expiryDatePatterns) {
            const matches = originalText.match(pattern);
            if (matches) {
                // Try to get the last date (usually expiry comes after issue)
                const dateStr = Array.isArray(matches) ? matches[matches.length - 1] : (matches[1] || matches[0]);
                const formatted = formatDate(dateStr);
                if (formatted) {
                    result.expiryDate = formatted;
                    break;
                }
            }
        }
    }

    // 7. Date of Birth - Multiple patterns
    if (!result.dateOfBirth) {
        const dobPatterns = [
            /(?:जन्मतिथि|Date\s*of\s*Birth)[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
            /DOB[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i,
            /Birth[:\s]*(\d{1,2}[.\-\/]\d{1,2}[.\-\/]\d{2,4})/i
        ];
        for (const pattern of dobPatterns) {
            const match = originalText.match(pattern);
            if (match) {
                const formatted = formatDate(match[1] || match[0]);
                if (formatted) {
                    result.dateOfBirth = formatted;
                    break;
                }
            }
        }
    }

    // 8. Names - Surname and Given Names
    if (!result.surname || !result.givenNames) {
        const namePatterns = [
            /(?:उपनाम|Surname)[:\s]*([A-Z\s]{2,50})/i,
            /(?:दिया\s*गया\s*नाम|Given\s*Name)[:\s]*([A-Z\s]{2,50})/i
        ];
        for (const pattern of namePatterns) {
            const match = originalText.match(pattern);
            if (match) {
                const name = match[1].trim();
                if (pattern.toString().includes("Surname") && !result.surname) {
                    result.surname = name;
                } else if (pattern.toString().includes("Given") && !result.givenNames) {
                    result.givenNames = name;
                }
            }
        }
    }

    // 9. Father's Name
    const fatherPatterns = [
        /(?:पिता|Name\s*of\s*Father)[:\s\/]*([A-Z\s]{3,50})/i,
        /Father[:\s]*([A-Z\s]{3,50})/i
    ];
    for (const pattern of fatherPatterns) {
        const match = originalText.match(pattern);
        if (match) {
            result.fatherName = match[1].trim().split(/\s{2,}/)[0];
            console.log("   ✅ Found Father's Name:", result.fatherName);
            break;
        }
    }

    // 10. Mother's Name
    console.log("\n🔍 Looking for Mother's Name...");
    const motherPatterns = [
        /(?:माता|Name\s*of\s*Mother)[:\s]*([A-Z\s]{3,50})/i,
        /Mother[:\s]*([A-Z\s]{3,50})/i
    ];
    for (const pattern of motherPatterns) {
        const match = originalText.match(pattern);
        if (match) {
            result.motherName = match[1].trim().split(/\s{2,}/)[0];
            console.log("   ✅ Found Mother's Name:", result.motherName);
            break;
        }
    }

    // 11. Spouse Name
    console.log("\n🔍 Looking for Spouse Name...");
    const spousePatterns = [
        /(?:पति|पत्नी|Name\s*of\s*Spouse)[:\s]*([A-Z\s]{3,50})/i,
        /Spouse[:\s]*([A-Z\s]{3,50})/i
    ];
    for (const pattern of spousePatterns) {
        const match = originalText.match(pattern);
        if (match) {
            result.spouseName = match[1].trim().split(/\s{2,}/)[0];
            console.log("   ✅ Found Spouse Name:", result.spouseName);
            break;
        }
    }

    // 12. Address
    console.log("\n🔍 Looking for Address...");
    const addressPatterns = [
        /(?:पता|Address)[:\s]*([A-Z0-9\s,.:\/-]{10,200}?)(?:\s*(?:File|Passport|PIN|PIN:))/i,
        /Address[:\s]*([A-Z0-9\s,.:\/-]{10,200})/i
    ];
    for (const pattern of addressPatterns) {
        const match = originalText.match(pattern);
        if (match) {
            result.address = match[1]
                .replace(/\s{2,}/g, " ")
                .replace(/\s+,/g, ",")
                .trim();
            console.log("   ✅ Found Address:", result.address.substring(0, 50));
            break;
        }
    }

    console.log("\n✅ Extraction complete!");
    return result;
};

const isPdfFile = (file = {}) => {
    const mimeType = file.mimetype || "";
    const name = file.originalname || "";
    return mimeType === "application/pdf" || name.toLowerCase().endsWith(".pdf");
};

const callOcrSpace = async (fileBuffer, mimeType = "application/octet-stream") => {
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
        return { text: "", warning: "OCR_SPACE_API_KEY is not configured." };
    }

    const payload = new URLSearchParams();
    payload.append("language", "eng");
    payload.append("isTable", "false");
    payload.append("scale", "true");
    payload.append("detectOrientation", "true");
    payload.append("OCREngine", "2");
    payload.append("base64Image", `data:${mimeType};base64,${fileBuffer.toString("base64")}`);

    try {
        const { data } = await axios.post(OCR_SPACE_ENDPOINT, payload, {
            headers: {
                apikey: apiKey,
            },
            timeout: 20000,
        });

        if (data?.IsErroredOnProcessing) {
            const errorMessage = Array.isArray(data?.ErrorMessage) ? data.ErrorMessage.join(", ") : data?.ErrorMessage;
            return { text: "", warning: errorMessage || "OCR provider failed to process the document." };
        }

        const parsedText = data?.ParsedResults?.map((result) => result?.ParsedText || "").join("\n");
        return { text: parsedText?.trim() || "", warning: "" };
    } catch (error) {
        console.error("OCR.space request failed:", error);
        return { text: "", warning: "OCR request failed. Please verify your OCR_SPACE_API_KEY or network connectivity." };
    }
};

// --- Controller Function ---
export const parsePassport = async (req, res) => {

    if (!req.file) {
        return res.status(400).json({ message: "Passport file is required." });
    }



    const mimeType = req.file.mimetype || "";
    const isSupported = SUPPORTED_MIME_TYPES.some((type) =>
        type === "application/pdf" ? mimeType === type : mimeType === type
    );

    if (!isSupported) {
        return res.status(415).json({
            message: "Unsupported file type. Please upload a PDF or image (JPG, PNG, WEBP).",
        });
    }

    try {
        const sourcesUsed = [];
        const warnings = [];
        let text = "";

        if (isPdfFile(req.file)) {
            console.log("\n🔍 Attempting PDF text extraction...");
            try {
                const parser = new PDFParse({ data: req.file.buffer });
                const result = await parser.getText();
                text = result?.text || "";


                if (text.length > 500) {
                    console.log("   ... (truncated)");
                }

                sourcesUsed.push("pdf-parse");
            } catch (pdfError) {
                console.error("❌ PDF parsing error:", pdfError);
                warnings.push("Failed to parse PDF text. Attempting OCR fallback.");
            }
        }

        if (!text.trim() || text.trim().length < MIN_TEXT_LENGTH_FOR_PARSER) {
            console.log("\n🔍 Text too short or empty, attempting OCR...");
            const { text: ocrText, warning } = await callOcrSpace(req.file.buffer, mimeType);
            if (warning) {
                warnings.push(warning);
                console.log("⚠️  OCR Warning:", warning);
            }
            if (ocrText) {
                text = `${text}\n${ocrText}`.trim();
                sourcesUsed.push("ocr-space");
            }
        }

        if (!text.trim()) {
            console.log("\n❌ No text extracted from document");
            return res.status(422).json({
                message: "Unable to extract text from the document. Please upload a clearer scan or configure OCR.",
                warnings,
            });
        }

        const details = extractPassportDetails(text);


        if (warnings.length > 0) {
            console.log("   Warnings:", warnings.join(", "));
        }
        console.log("==========================================\n");

        return res.json({
            status: "success",
            data: details,
            rawTextLength: text.length,
            sourcesUsed,
            warnings,
        });
    } catch (error) {
        console.error("Document AI parsing failed:", error);
        return res.status(500).json({
            message: "Failed to extract passport details. Please try again.",
            error: error.message,
        });
    }
};

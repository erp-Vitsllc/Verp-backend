import Company from "../../models/Company.js";
import { calculateCompanyActivationProgress } from "../../utils/companyActivation.js";

export const addCompany = async (req, res) => {
    try {
        // Prevent MongoDB injection & trim/sanitize inputs to prevent XSS
        const sanitizeInput = (val, fieldName) => {
            if (val === undefined || val === null) return "";
            if (typeof val === "object" || Array.isArray(val)) {
                throw new Error(`Invalid data type for field ${fieldName}`);
            }
            let str = String(val).trim();
            // Prevent XSS attacks by stripping HTML tags
            str = str.replace(/<[^>]*>?/gm, '');
            return str;
        };

        const name = sanitizeInput(req.body.name, "Company Name");
        const nickName = sanitizeInput(req.body.nickName, "Short Name");
        const email = sanitizeInput(req.body.email, "Company Email ID").toLowerCase();
        const phone = sanitizeInput(req.body.phone, "Phone Number");
        const phoneCountryCode = sanitizeInput(req.body.phoneCountryCode, "Phone Country Code");
        const website = sanitizeInput(req.body.website, "Website");
        const address = sanitizeInput(req.body.address, "Company Address");
        const city = sanitizeInput(req.body.city, "City");
        const state = sanitizeInput(req.body.state, "State / Emirates");
        const country = sanitizeInput(req.body.country, "Country");
        const registrationNumber = sanitizeInput(req.body.registrationNumber, "Registration Number");
        const vatNumber = sanitizeInput(req.body.vatNumber, "VAT Number");
        const logo = sanitizeInput(req.body.logo, "Logo");
        const establishedDate = sanitizeInput(req.body.establishedDate, "Established Date");
        const postalCode = sanitizeInput(req.body.postalCode, "Postal Code");

        // 1. Company ID validation and generation
        // Requirement: Required, Must be unique, Auto-generated only, No manual edit, Format: /^EST-\d{3,6}$/
        const lastCompany = await Company.findOne({
            companyId: { $regex: /^EST-\d+$/ }
        }).sort({ createdAt: -1 }).select('companyId');

        let nextNumber = 1;
        if (lastCompany && lastCompany.companyId) {
            const match = lastCompany.companyId.match(/\d+$/);
            if (match) {
                nextNumber = parseInt(match[0], 10) + 1;
            }
        }
        const generatedCompanyId = `EST-${String(nextNumber).padStart(3, '0')}`;
        const idRegex = /^EST-\d{3,6}$/;
        if (!idRegex.test(generatedCompanyId)) {
            return res.status(400).json({ message: "Invalid generated Company ID format" });
        }

        // Double check uniqueness
        const duplicateId = await Company.findOne({ companyId: generatedCompanyId });
        if (duplicateId) {
            return res.status(400).json({ message: "Auto-generated Company ID is not unique. Please try again." });
        }

        // 2. Company Name validations
        // Required, Min 3 characters, Must be unique, Special characters restricted, Format: /^[A-Za-z0-9&.,()' -]{3,100}$/
        if (!name) {
            return res.status(400).json({ message: "Company Name is required" });
        }
        if (name.length < 3) {
            return res.status(400).json({ message: "Company Name must be at least 3 characters" });
        }
        const nameRegex = /^[A-Za-z0-9&.,()' -]{3,100}$/;
        if (!nameRegex.test(name)) {
            return res.status(400).json({ message: "Company Name contains invalid special characters or does not meet length constraints" });
        }
        const duplicateName = await Company.findOne({
            name: { $regex: new RegExp("^" + name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + "$", "i") }
        });
        if (duplicateName) {
            return res.status(400).json({ message: "Company Name must be unique" });
        }

        // 3. Short Name validations
        // Optional, Max 50 characters, Letters and numbers, Format: /^[A-Za-z0-9&.' -]{0,50}$/
        if (nickName) {
            if (nickName.length > 50) {
                return res.status(400).json({ message: "Short Name must be no more than 50 characters" });
            }
            const nickNameRegex = /^[A-Za-z0-9&.' -]{0,50}$/;
            if (!nickNameRegex.test(nickName)) {
                return res.status(400).json({ message: "Short Name contains invalid characters" });
            }
        }

        // 4. Company Email ID validations
        // Required, Must be unique, Valid email format, lowercase, No spaces, Format: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        if (!email) {
            return res.status(400).json({ message: "Company Email ID is required" });
        }
        if (email.includes(" ")) {
            return res.status(400).json({ message: "Company Email ID cannot contain spaces" });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: "Invalid Company Email ID format" });
        }
        const duplicateEmail = await Company.findOne({ email });
        if (duplicateEmail) {
            return res.status(400).json({ message: "Company Email ID must be unique" });
        }

        // 5. Phone Number validations
        // Required, Numbers only, UAE format supported, Min 7 digits, Country code stored separately, Format: /^5[0-9]{8}$/
        if (!phone) {
            return res.status(400).json({ message: "Phone Number is required" });
        }
        if (!phoneCountryCode) {
            return res.status(400).json({ message: "Phone Country Code is required" });
        }
        const cleanPhone = phone.replace(/\D/g, ''); // Numbers only

        const isUAE = phoneCountryCode === "+971" || 
                      phoneCountryCode === "971" || 
                      (country && (country.toLowerCase() === "ae" || country.toLowerCase() === "united arab emirates" || country.toLowerCase() === "uae"));

        if (isUAE) {
            const phoneRegex = /^5[0-9]{8}$/;
            if (!phoneRegex.test(cleanPhone)) {
                return res.status(400).json({ message: "Phone Number must match UAE format starting with 5 (9 digits total)" });
            }
        } else {
            if (cleanPhone.length < 7 || cleanPhone.length > 15) {
                return res.status(400).json({ message: "Phone Number must be a valid format between 7 and 15 digits" });
            }
        }

        // 6. Established Date validations
        // Required, Cannot be future date, Minimum year: 1900, Must be valid date
        if (!establishedDate) {
            return res.status(400).json({ message: "Established Date is required" });
        }
        const parsedDate = new Date(establishedDate);
        if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({ message: "Established Date must be a valid date" });
        }
        const today = new Date();
        if (parsedDate > today) {
            return res.status(400).json({ message: "Established Date cannot be a future date" });
        }
        if (parsedDate.getFullYear() < 1900) {
            return res.status(400).json({ message: "Established Date minimum year is 1900" });
        }

        // 7. Company Address validations
        // Required, Min 10 characters, Max 300 characters, No only spaces, Dangerous scripts blocked, Format: /^[A-Za-z0-9\s,./#()-]{10,300}$/
        if (!address) {
            return res.status(400).json({ message: "Company Address is required" });
        }
        if (address.length < 10) {
            return res.status(400).json({ message: "Company Address must be at least 10 characters" });
        }
        if (address.length > 300) {
            return res.status(400).json({ message: "Company Address must be no more than 300 characters" });
        }
        const addressRegex = /^[A-Za-z0-9\s,./#()-]{10,300}$/;
        if (!addressRegex.test(address)) {
            return res.status(400).json({ message: "Company Address contains restricted special characters" });
        }

        // 8. Country validations
        // Required, Dropdown selection only, Must match allowed country list
        if (!country) {
            return res.status(400).json({ message: "Country is required" });
        }

        // 9. State / Emirates validations
        // Required, Dropdown selection only, Must match UAE emirates list
        if (!state) {
            return res.status(400).json({ message: "State / Emirates is required" });
        }
        if (country.toLowerCase() === "united arab emirates" || country.toLowerCase() === "uae") {
            const uaeEmirates = [
                "Abu Dhabi",
                "Dubai",
                "Sharjah",
                "Ajman",
                "Umm Al Quwain",
                "Ras Al Khaimah",
                "Fujairah"
            ];
            const isValidEmirate = uaeEmirates.some(e => e.toLowerCase() === state.toLowerCase());
            if (!isValidEmirate) {
                return res.status(400).json({ message: "State must match a valid UAE Emirate" });
            }
        }

        // 10. City validations
        // Required, Min 2 characters, Max 50 characters, Letters only, Format: /^[A-Za-z\s-]{2,50}$/
        if (!city) {
            return res.status(400).json({ message: "City is required" });
        }
        if (city.length < 2) {
            return res.status(400).json({ message: "City must be at least 2 characters" });
        }
        if (city.length > 50) {
            return res.status(400).json({ message: "City must be no more than 50 characters" });
        }
        const cityRegex = /^[A-Za-z\s-]{2,50}$/;
        if (!cityRegex.test(city)) {
            return res.status(400).json({ message: "City must contain only letters, spaces or hyphens" });
        }

        // 11. Postal Code validations
        // Optional, Max 20 characters, Letters and numbers allowed, Format: /^[A-Za-z0-9\s-]{0,20}$/
        if (postalCode) {
            if (postalCode.length > 20) {
                return res.status(400).json({ message: "Postal Code must be no more than 20 characters" });
            }
            const postalRegex = /^[A-Za-z0-9\s-]{0,20}$/;
            if (!postalRegex.test(postalCode)) {
                return res.status(400).json({ message: "Postal Code contains invalid characters" });
            }
        }

        // Save new company with validated and sanitized data
        const newCompany = new Company({
            name,
            nickName,
            companyId: generatedCompanyId,
            email,
            phone: cleanPhone,
            phoneCountryCode,
            website,
            address,
            city,
            state,
            country,
            registrationNumber,
            vatNumber,
            logo,
            establishedDate: parsedDate,
            postalCode,
            status: "Inactive",
            activationStatus: "draft",
            createdBy: req.user?._id
        });

        await newCompany.save();

        return res.status(201).json({
            message: "Company added successfully",
            company: newCompany,
            activationProgress: calculateCompanyActivationProgress(newCompany.toObject())
        });
    } catch (error) {
        console.error("Error in addCompany:", error);
        return res.status(500).json({ message: error.message || "Failed to add company" });
    }
};

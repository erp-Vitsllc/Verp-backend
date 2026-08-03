import mongoose from "mongoose";

/** Trade license + establishment card (1:1 per company). */
export const companyComplianceSchema = new mongoose.Schema(
    {
        company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
        tradeLicenseNumber: { type: String },
        tradeLicenseIssueDate: { type: Date },
        tradeLicenseExpiry: { type: Date },
        tradeLicenseOwnerName: { type: String },
        tradeLicenseAttachment: { type: String },
        establishmentCardNumber: { type: String },
        establishmentCardIssueDate: { type: Date },
        establishmentCardExpiry: { type: Date },
        establishmentCardAttachment: { type: String },
    },
    { timestamps: true },
);

const ownerSubdoc = {
    ownerProfileId: { type: String },
    name: { type: String },
    email: { type: String },
    phone: { type: String },
    nationality: { type: String },
    sharePercentage: { type: String },
    attachment: { type: String },
    passport: {
        number: { type: String },
        nationality: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        countryOfIssue: { type: String },
        placeOfIssue: { type: String },
        attachment: { type: String },
    },
    visa: {
        number: { type: String },
        type: { type: String },
        issueDate: { type: Date },
        sponsor: { type: String },
        expiryDate: { type: Date },
        attachment: { type: String },
    },
    visitVisa: {
        number: { type: String },
        type: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        attachment: { type: String },
    },
    employmentVisa: {
        number: { type: String },
        type: { type: String },
        issueDate: { type: Date },
        sponsor: { type: String },
        expiryDate: { type: Date },
        attachment: { type: String },
    },
    spouseVisa: {
        number: { type: String },
        type: { type: String },
        issueDate: { type: Date },
        sponsor: { type: String },
        expiryDate: { type: Date },
        attachment: { type: String },
    },
    emiratesId: {
        number: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        attachment: { type: String },
    },
    medical: {
        provider: { type: String },
        number: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        attachment: { type: String },
    },
    drivingLicense: {
        number: { type: String },
        issueDate: { type: Date },
        expiryDate: { type: Date },
        issuingCountry: { type: String },
        attachment: { type: String },
    },
    labourCard: {
        number: { type: String },
        expiryDate: { type: Date },
        lastUpdated: { type: Date },
        attachment: { type: String },
    },
};

const archivedOwnerSubdoc = {
    ...ownerSubdoc,
    archivedAt: { type: Date, default: Date.now },
    archiveReason: { type: String, enum: ["Replaced", "Deleted", "Not Renewed"], default: "Replaced" },
    previousOwnerId: { type: String, default: "" },
    replacedByName: { type: String, default: "" },
};

/** Current + archived owners (1:1 per company). */
export const companyOwnersSchema = new mongoose.Schema(
    {
        company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
        owners: [ownerSubdoc],
        oldOwners: [archivedOwnerSubdoc],
    },
    { timestamps: true },
);

const documentRowSchema = {
    type: { type: String },
    description: { type: String },
    context: { type: String },
    provider: { type: String },
    issueDate: { type: Date },
    startDate: { type: Date },
    expiryDate: { type: Date },
    value: { type: Number },
    document: {
        url: { type: String },
        publicId: { type: String },
        name: { type: String },
        mimeType: { type: String },
    },
};

const oldDocumentRowSchema = {
    ...documentRowSchema,
    cost: { type: Number, default: null },
    archivedAt: { type: Date, default: Date.now },
    archiveReason: { type: String, enum: ["Replaced", "Deleted", "Not Renewed"], default: "Replaced" },
};

/** General docs, insurance, ejari, training, archives (1:1 per company). */
export const companyDocumentBundleSchema = new mongoose.Schema(
    {
        company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
        documents: [documentRowSchema],
        insurance: [documentRowSchema],
        ejari: [documentRowSchema],
        trainingDetails: [
            {
                trainingName: { type: String },
                trainingDetails: { type: String },
                provider: { type: String },
                trainingDate: { type: Date },
                trainingCost: { type: Number },
                certificate: {
                    url: { type: String },
                    publicId: { type: String },
                    name: { type: String },
                    mimeType: { type: String },
                },
            },
        ],
        oldDocuments: [oldDocumentRowSchema],
        customTabs: [String],
        /** Denormalized for fast list activation % without loading full documents[]. */
        hasLiveMoa: { type: Boolean, default: false },
    },
    { timestamps: true },
);

/** Activation / hold / not-renew queues (1:1 per company). */
export const companyWorkflowSchema = new mongoose.Schema(
    {
        company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
        activationWorkflow: [
            {
                role: { type: String, required: true },
                assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeBasic" },
                status: { type: String, enum: ["submitted", "active", "rejected"], default: "submitted" },
                assignedAt: { type: Date, default: Date.now },
                actionedAt: { type: Date },
                comment: { type: String },
                reason: { type: String, default: "" },
                description: { type: String, default: "" },
                attachment: { type: String, default: "" },
                attachmentName: { type: String, default: "" },
            },
        ],
        pendingReactivationChanges: [
            {
                card: { type: String, default: "" },
                reason: { type: String, default: "" },
                section: { type: String, default: "" },
                changeType: { type: String, enum: ["add", "update", "delete", ""], default: "" },
                targetIndex: { type: Number, default: null },
                isRenewal: { type: Boolean, default: false },
                previousData: { type: mongoose.Schema.Types.Mixed, default: null },
                proposedData: { type: mongoose.Schema.Types.Mixed, default: null },
                changedAt: { type: Date, default: Date.now },
                queuedByUserId: { type: String, default: "" },
                queuedByEmployeeId: { type: String, default: "" },
                queuedByEmployeeObjectId: { type: String, default: "" },
                queuedByName: { type: String, default: "" },
            },
        ],
        activationHold: {
            type: new mongoose.Schema(
                {
                    heldAt: { type: Date },
                    unapprovedEntryIds: [{ type: String }],
                    unapprovedCards: [{ type: String }],
                    comment: { type: String, default: "" },
                    resolvedEntryIds: [{ type: String }],
                    addressedLabelsByEntryId: { type: mongoose.Schema.Types.Mixed, default: undefined },
                    rowNotesByEntryId: { type: mongoose.Schema.Types.Mixed, default: undefined },
                },
                { _id: false },
            ),
            default: undefined,
        },
        pendingNotRenewRequests: [
            {
                requestId: { type: String, required: true },
                kind: {
                    type: String,
                    enum: ["tradeLicense", "establishmentCard", "document", "ownerDoc", "ejari", "insurance"],
                    required: true,
                },
                label: { type: String, default: "" },
                documentIndex: { type: Number },
                documentItemId: { type: String, default: "" },
                arrayIndex: { type: Number },
                arrayItemId: { type: String, default: "" },
                ownerIndex: { type: Number },
                ownerProfileId: { type: String, default: "" },
                docKey: { type: String, default: "" },
                reason: { type: String, required: true },
                supportingAttachmentKey: { type: String, default: "" },
                supportingAttachmentName: { type: String, default: "" },
                status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
                submittedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
                submittedByName: { type: String, default: "" },
                submittedByEmployeeId: { type: String, default: "" },
                submittedAt: { type: Date, default: Date.now },
                hrComment: { type: String, default: "" },
                actionedAt: { type: Date },
                actionedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
            },
        ],
    },
    { timestamps: true },
);

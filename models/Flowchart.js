import mongoose from "mongoose";

/**
 * Flowchart - Organization structure and responsibilities
 * Stores department heads and their responsibilities separate from companies
 */
const flowchartSchema = new mongoose.Schema(
    {
        // Department/Category information
        category: {
            type: String,
            required: true,
            enum: ["hr", "accounts", "finance", "assetcontroller", "management", "it", "admin"]
        },

        // Employee information
        employeeId: {
            type: String,
            required: true
        },
        employeeName: {
            type: String,
            required: true
        },
        designation: {
            type: String,
            required: true
        },

        // Reference to employee
        empObjectId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "EmployeeBasic"
        },

        // Status
        status: {
            type: String,
            enum: ["Active", "Inactive", "Pending"],
            default: "Active"
        },

        // Additional metadata
        department: { type: String },
        companyEmail: { type: String },
        email: { type: String },

        // Audit fields
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        },
        updatedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User"
        }
    },
    {
        timestamps: true
    }
);

// Indexes for faster queries
flowchartSchema.index({ category: 1, status: 1 });
flowchartSchema.index({ employeeId: 1 });
flowchartSchema.index({ empObjectId: 1 });

export default mongoose.model("Flowchart", flowchartSchema);

import mongoose from "mongoose";
import Flowchart from "../models/Flowchart.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import User from "../models/User.js";
import DashboardAction from "../models/DashboardAction.js";
import { sendResponsibilityApprovalEmail } from "../utils/sendResponsibilityApprovalEmail.js";

// @desc    Get all flowchart responsibilities
// @route   GET /api/flowchart
// @access  Private
export const getFlowchartResponsibilities = async (req, res) => {
    try {
        const responsibilities = await Flowchart.find()
            .populate('empObjectId', 'employeeId firstName lastName department designation')
            .sort({ category: 1, status: -1 });

        res.status(200).json(responsibilities);
    } catch (error) {
        console.error('Error fetching flowchart responsibilities:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Add or update flowchart responsibility
// @route   POST /api/flowchart
// @access  Private
export const addFlowchartResponsibility = async (req, res) => {
    try {
        const { category, employeeId, employeeName, designation, empObjectId, status, department, companyEmail, email } = req.body;

        console.log('Received flowchart data:', { category, employeeId, employeeName, designation, empObjectId, status });

        // Auto-resolve empObjectId if missing
        let resolvedEmpObjectId = empObjectId;
        if (!resolvedEmpObjectId && employeeId) {
            const employee = await EmployeeBasic.findOne({
                employeeId: { $regex: new RegExp(`^${employeeId.replace(/\s+/g, '\\s*')}$`, 'i') }
            }).select('_id');
            if (employee) {
                resolvedEmpObjectId = employee._id;
                console.log(`Auto-resolved empObjectId for ${employeeId}: ${resolvedEmpObjectId}`);
            }
        }

        // Validate required fields
        if (!category || !employeeId || !employeeName || !designation) {
            return res.status(400).json({
                message: 'Missing required fields: category, employeeId, employeeName, designation are required',
                received: { category, employeeId, employeeName, designation }
            });
        }

        // Check if responsibility already exists for this category
        const existing = await Flowchart.findOne({ category });

        if (existing) {
            // Update existing
            existing.employeeId = employeeId;
            existing.employeeName = employeeName;
            existing.designation = designation;
            existing.empObjectId = resolvedEmpObjectId; // Make sure this is updated
            existing.status = status || 'Active';
            existing.department = department;
            existing.companyEmail = companyEmail;
            existing.email = email;
            existing.updatedBy = req.user._id;

            await existing.save();
            res.status(200).json({ message: 'Responsibility updated successfully', responsibility: existing });
        } else {
            // Create new
            const responsibility = new Flowchart({
                category,
                employeeId,
                employeeName,
                designation,
                empObjectId: resolvedEmpObjectId,
                status: status || 'Active',
                department,
                companyEmail,
                email,
                createdBy: req.user._id
            });

            await responsibility.save();

            // Create dashboard action for responsibility approval if status is Pending
            if (status === 'Pending' && resolvedEmpObjectId) {
                try {
                    // Find the employee record
                    const employee = await EmployeeBasic.findById(resolvedEmpObjectId);
                    if (employee) {
                        // Check if we already have a pending dashboard action for this specific role and employee
                        const existingAction = await DashboardAction.findOne({
                            assignedTo: employee._id,
                            requestType: 'Responsibility Approval',
                            status: 'Pending',
                            extra1: category
                        });

                        if (!existingAction) {
                            const newAction = await DashboardAction.create({
                                assignedTo: employee._id,
                                assignedToEmpId: employee.employeeId,
                                requestId: responsibility._id,
                                requestType: 'Responsibility Approval',
                                subjectEmployeeId: employee.employeeId,
                                subjectName: `${employee.firstName} ${employee.lastName}`,
                                requestedByName: req.user.name || 'Admin',
                                extra1: category,
                                extra2: `${category} Responsibility Approval`,
                                status: 'Pending'
                            });

                            console.log(`[Flowchart] Created responsibility approval action for ${category}: ${employee.employeeId}`);

                            // Send approval email
                            const roleLabels = {
                                'hr': 'HR Admin',
                                'accounts': 'Financial Controller',
                                'assetcontroller': 'Asset Controller',
                                'management': 'General Management',
                                'admincontroller': 'System Admin'
                            };

                            await sendResponsibilityApprovalEmail({
                                employee: employee,
                                companyName: 'Main ERP', // Global flowchart is for the whole system
                                category: roleLabels[category] || category,
                                requestId: newAction._id,
                                unassignedAssets: [] // We'll let them see unassigned on approval
                            });
                        }
                    }
                } catch (err) {
                    console.error(`[Flowchart Error] Failed to create responsibility approval action for ${category}:`, err);
                }
            }

            res.status(201).json({ message: 'Responsibility created successfully', responsibility });
        }
    } catch (error) {
        console.error('Error adding flowchart responsibility:', error);

        // Send detailed error message
        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                message: 'Validation Error',
                errors: errors,
                details: error.message
            });
        }

        res.status(500).json({
            message: 'Server Error',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

// @desc    Respond to responsibility approval
// @route   PUT /api/flowchart/respond-responsibility
// @access  Private
export const respondToResponsibility = async (req, res) => {
    try {
        const { action, actionId, category } = req.body;

        // Find the responsibility by ID or category
        let responsibility;
        if (actionId) {
            responsibility = await Flowchart.findById(actionId);
        } else {
            responsibility = await Flowchart.findOne({ category });
        }

        if (!responsibility) {
            return res.status(404).json({ message: 'Responsibility not found' });
        }

        // Update the flowchart responsibility status
        responsibility.status = action === 'Approve' ? 'Active' : 'Rejected';
        responsibility.updatedBy = req.user._id;
        await responsibility.save();

        // Also update any dashboard action if it exists
        const dashboardAction = await DashboardAction.findOne({
            $or: [
                { requestId: responsibility._id, requestType: 'Responsibility Approval', status: 'Pending' },
                { extra1: category, requestType: 'Responsibility Approval', status: 'Pending' }
            ]
        });

        if (dashboardAction) {
            dashboardAction.status = action === 'Approve' ? 'Approved' : 'Rejected';
            dashboardAction.resolvedAt = new Date();
            dashboardAction.resolvedBy = req.user._id;
            await dashboardAction.save();
        }

        res.status(200).json({ message: `Responsibility ${action}ed successfully` });
    } catch (error) {
        console.error('Error responding to responsibility:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Delete flowchart responsibility
// @route   DELETE /api/flowchart/:id
// @route   DELETE /api/flowchart/category/:category
// @access  Private
export const deleteFlowchartResponsibility = async (req, res) => {
    try {
        const { id } = req.params;
        const { category } = req.params;

        let responsibility;

        if (category) {
            // Delete by category
            responsibility = await Flowchart.findOneAndDelete({ category });
        } else {
            // Delete by ID
            responsibility = await Flowchart.findByIdAndDelete(id);
        }

        if (!responsibility) {
            return res.status(404).json({ message: 'Responsibility not found' });
        }

        res.status(200).json({ message: 'Responsibility deleted successfully' });
    } catch (error) {
        console.error('Error deleting flowchart responsibility:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

// @desc    Get employees for dropdown
// @route   GET /api/flowchart/employees
// @access  Private
export const getEmployeesForFlowchart = async (req, res) => {
    try {
        const employees = await EmployeeBasic.find({ profileStatus: 'active' })
            .select('employeeId firstName lastName department designation companyEmail email')
            .sort({ firstName: 1, lastName: 1 });

        res.status(200).json(employees);
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({ message: 'Server Error' });
    }
};

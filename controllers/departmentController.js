import Department from "../models/Department.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import { escapeRegex } from "../utils/regexHelper.js";

// Create a new department
export const createDepartment = async (req, res) => {
    try {
        const { name } = req.body;

        if (!name) {
            return res.status(400).json({ message: "Department name is required" });
        }

        const existingDepartment = await Department.findOne({ name: { $regex: new RegExp(`^${escapeRegex(name)}$`, 'i') } });
        if (existingDepartment) {
            return res.status(400).json({ message: "Department already exists" });
        }

        const department = new Department({ name });
        await department.save();

        res.status(201).json(department);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Get all departments
export const getDepartments = async (req, res) => {
    try {
        // Ensure "Management" department exists and is protected
        await Department.findOneAndUpdate(
            { name: "Management" },
            { $set: { name: "Management", isSystem: true, status: "Active" } },
            { upsert: true, new: true }
        );

        const departments = await Department.find({ status: "Active" }).sort({ name: 1 });
        res.status(200).json(departments);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Delete a department
export const deleteDepartment = async (req, res) => {
    try {
        const { id } = req.params;
        const department = await Department.findById(id);

        if (!department) {
            return res.status(404).json({ message: "Department not found" });
        }

        if (department.isSystem) {
            return res.status(403).json({ message: "Cannot delete system default department" });
        }

        // Check if any employees are assigned to this department
        // Note: In EmployeeBasic, department is stored as a string (the name)
        const employeeCount = await EmployeeBasic.countDocuments({
            department: { $regex: new RegExp(`^${escapeRegex(department.name)}$`, 'i') }
        });

        if (employeeCount > 0) {
            const employees = await EmployeeBasic.find({
                department: { $regex: new RegExp(`^${escapeRegex(department.name)}$`, 'i') }
            }).select('firstName lastName employeeId');

            return res.status(400).json({
                message: `This department contains ${employeeCount} employee(s). You must reassign these employees to another department/template before deleting this one.`,
                employeeCount: employeeCount,
                employees: employees.map(emp => ({
                    name: `${emp.firstName} ${emp.lastName}`,
                    id: emp.employeeId
                })),
                departmentName: department.name
            });
        }

        await Department.findByIdAndDelete(id);

        res.status(200).json({ message: "Department deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

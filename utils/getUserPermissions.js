import User from "../models/User.js";
import Group from "../models/Group.js";
import EmployeeBasic from "../models/EmployeeBasic.js";

/**
 * Get user permissions based on:
 * 1. If user is Administrator (by designation) → all permissions allowed
 * 2. If user has a group → return group permissions
 * 3. Otherwise → return empty permissions (all off)
 */
export const getUserPermissions = async (userId) => {
    try {
        const user = await User.findById(userId)
            .populate('group')
            .lean();

        if (!user) {
            return null;
        }

        // Check if user is Administrator by designation
        let isAdministrator = false;
        if (user.employeeId) {
            const employee = await EmployeeBasic.findOne({ employeeId: user.employeeId })
                .select('designation')
                .lean();
            
            if (employee && employee.designation) {
                // Check if designation is Administrator (case-insensitive)
                const designation = employee.designation.trim().toLowerCase();
                isAdministrator = designation === 'administrator' || designation === 'admin';
            }
        }

        // If user is Administrator, return all permissions enabled
        if (isAdministrator) {
            return getAllPermissionsEnabled();
        }

        // If user has a group, return group permissions
        if (user.group) {
            // If group is populated as object, use it directly
            // Otherwise, fetch the group
            let groupPermissions = null;
            if (typeof user.group === 'object' && user.group.permissions) {
                groupPermissions = user.group.permissions;
            } else if (user.group) {
                const group = await Group.findById(user.group).lean();
                if (group && group.permissions) {
                    groupPermissions = group.permissions;
                }
            }
            
            if (groupPermissions) {
                return groupPermissions;
            }
        }

        // Otherwise, return empty permissions (all off)
        return {};
    } catch (error) {
        console.error('Error getting user permissions:', error);
        return {};
    }
};

/**
 * Generate all permissions enabled for Administrator
 * This matches the MODULES structure from the frontend
 */
const getAllPermissionsEnabled = () => {
    const allPermissions = {};
    
    const modules = [
        'login',
        'dashboard',
        'hrm',
        'hrm_employees',
        'hrm_employees_add',
        'hrm_employees_list',
        'hrm_employees_view',
        'hrm_employees_view_basic',
        'hrm_employees_view_personal',
        'hrm_employees_view_passport',
        'hrm_employees_view_visa',
        'hrm_employees_view_education',
        'hrm_employees_view_experience',
        'hrm_employees_view_work',
        'hrm_employees_view_salary',
        'hrm_employees_view_bank',
        'hrm_employees_view_emergency',
        'hrm_attendance',
        'hrm_leave',
        'hrm_salary',
        'hrm_ncr',
        'crm',
        'purchases',
        'sales',
        'accounts',
        'production',
        'reports',
        'settings',
        'settings_user_group',
    ];

    const permissionTypes = ['full', 'create', 'view', 'edit', 'delete'];

    modules.forEach(moduleId => {
        allPermissions[moduleId] = {};
        permissionTypes.forEach(permType => {
            allPermissions[moduleId][permType] = true;
        });
    });

    return allPermissions;
};

/**
 * Check if user has a specific permission
 */
export const hasPermission = async (userId, moduleId, permissionType) => {
    const permissions = await getUserPermissions(userId);
    
    if (!permissions) {
        return false;
    }

    // If module has 'full' permission, user has all permissions
    if (permissions[moduleId]?.full === true) {
        return true;
    }

    // Check specific permission
    return permissions[moduleId]?.[permissionType] === true;
};


import User from "../models/User.js";
import EmployeeBasic from "../models/EmployeeBasic.js";
import Group from "../models/Group.js";
import { HRM_MODULE } from "../constants/hrmModulePermissions.js";

/**
 * Get user permissions
 * - System admin (username from .env) gets all permissions automatically
 * - Users without a group get no permissions (unless System Admin)
 * - Users with a group get permissions from that group
 */
export const getUserPermissions = async (userId, isSystemAdmin = false) => {
    try {
        const user = await User.findById(userId)
            .populate('group', 'permissions')
            .lean();

        if (!user) {
            return null;
        }

        // Check if user is System Admin (username matches ADMIN_USERNAME from .env)
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const isAdministrator = isSystemAdmin || user.username.toLowerCase() === adminUsername.toLowerCase();

        // System Admin gets all permissions automatically
        if (isAdministrator) {
            return {
                isAdministrator: true,
                isAdmin: true,
                permissions: getAllPermissions(),
                group: null,
                groupName: null
            };
        }

        // User without a group gets NO permissions (unless admin)
        if (!user.group) {
            return {
                isAdministrator: false,
                isAdmin: false,
                permissions: {},
                group: null,
                groupName: null
            };
        }

        // User with a group gets group permissions
        const group = await Group.findById(user.group).lean();
        if (!group) {
            return {
                isAdministrator: false,
                permissions: {},
                group: null,
                groupName: null
            };
        }

        // Convert permissions from old format to new format if needed
        const rawPermissions = group.permissions || {};
        const convertedPermissions = convertPermissionsFormat(rawPermissions);

        return {
            isAdministrator: false,
            isAdmin: false,
            permissions: convertedPermissions,
            group: user.group,
            groupName: user.groupName || group.name
        };
    } catch (error) {
        console.error('Error getting user permissions:', error);
        return null;
    }
};

/**
 * Convert permissions from old format (full, create, view, edit, delete) to new format (isView, isCreate, isEdit, isDelete, isDownload)
 * Supports both isActive (old) and isView (new) for backward compatibility
 */
const convertPermissionsFormat = (permissions) => {
    const converted = {};

    Object.keys(permissions).forEach(moduleId => {
        const oldPerm = permissions[moduleId];

        // Check if already in new format (isView)
        if (oldPerm && oldPerm.hasOwnProperty('isView')) {
            converted[moduleId] = {
                isView: oldPerm.isView ?? false,
                isCreate: oldPerm.isCreate ?? false,
                isEdit: oldPerm.isEdit ?? false,
                isDelete: oldPerm.isDelete ?? false,
                isDownload: oldPerm.isDownload ?? false,
                // Also set isActive for backward compatibility
                isActive: oldPerm.isView ?? false
            };
        } 
        // Check if in old new format (isActive)
        else if (oldPerm && oldPerm.hasOwnProperty('isActive')) {
            converted[moduleId] = {
                isView: oldPerm.isActive ?? false,
                isCreate: oldPerm.isCreate ?? false,
                isEdit: oldPerm.isEdit ?? false,
                isDelete: oldPerm.isDelete ?? false,
                isDownload: oldPerm.isDownload ?? false,
                // Keep isActive for backward compatibility
                isActive: oldPerm.isActive ?? false
            };
        } 
        // Convert from very old format (full, create, view, edit, delete)
        else if (oldPerm) {
            converted[moduleId] = {
                isView: oldPerm.full || oldPerm.view || false,
                isCreate: oldPerm.full || oldPerm.create || false,
                isEdit: oldPerm.full || oldPerm.edit || false,
                isDelete: oldPerm.full || oldPerm.delete || false,
                isDownload: oldPerm.download || false,
                // Also set isActive for backward compatibility
                isActive: oldPerm.full || oldPerm.view || false
            };
        }
    });

    // Ensure dashboard is always active
    if (!converted.dashboard) {
        converted.dashboard = {
            isView: true,
            isCreate: false,
            isEdit: false,
            isDelete: false,
            isDownload: false,
            isActive: true
        };
    } else {
        converted.dashboard.isView = true;
        converted.dashboard.isActive = true;
    }

    return converted;
};

/**
 * Check if user has permission for a specific module and action
 */
export const hasPermission = async (userId, moduleId, permissionType) => {
    const userPermissions = await getUserPermissions(userId);

    if (!userPermissions) {
        return false;
    }

    // Administrator has all permissions
    if (userPermissions.isAdministrator) {
        return true;
    }

    // Dashboard and logout are always accessible
    if (moduleId === 'dashboard' || moduleId === 'logout') {
        return true;
    }

    // Check if module permission exists
    let modulePermission = userPermissions.permissions[moduleId];
    if (
        !modulePermission &&
        String(moduleId || '').startsWith('hrm_asset_vehicle') &&
        moduleId !== 'hrm_asset_vehicle' &&
        userPermissions.permissions.hrm_asset_vehicle
    ) {
        modulePermission = userPermissions.permissions.hrm_asset_vehicle;
    }
    if (!modulePermission) {
        return false;
    }

    // First check if module has View permission (isView or isActive must be true)
    const hasView = modulePermission.isView === true || modulePermission.isActive === true;
    if (!hasView) {
        return false;
    }

    // For isView/isActive check, just return the View value
    if (permissionType === 'isView' || permissionType === 'isActive' || permissionType === 'view') {
        return hasView;
    }

    // Map old permission types to new ones for backward compatibility
    const permissionMap = {
        'create': 'isCreate',
        'edit': 'isEdit',
        'delete': 'isDelete',
        'view': 'isActive',
        'full': 'isActive' // Full permission means isActive = true
    };

    const newPermissionType = permissionMap[permissionType] || permissionType;

    // Check specific permission type
    return modulePermission[newPermissionType] === true;
};

/**
 * MODULES structure matching the frontend
 * This defines all available modules/sessions with their hierarchical structure
 */
const MODULES_STRUCTURE = [
    { id: 'login', label: 'Login', parent: null },
    { id: 'dashboard', label: 'Dashboard', parent: null },
    HRM_MODULE,
    { id: 'crm', label: 'CRM', parent: null },
    { id: 'purchases', label: 'Purchases', parent: null },
    { id: 'sales', label: 'Sales', parent: null },
    { id: 'accounts', label: 'Accounts', parent: null },
    { id: 'production', label: 'Production', parent: null },
    { id: 'reports', label: 'Reports', parent: null },
    {
        id: 'settings',
        label: 'Settings',
        parent: null,
        children: [
            { 
                id: 'settings_user_group', 
                label: 'Create User & Group', 
                parent: 'settings',
                children: [
                    { id: 'settings_user_group_create', label: 'Create', parent: 'settings_user_group' },
                    { id: 'settings_user_group_edit', label: 'Edit', parent: 'settings_user_group' },
                    { id: 'settings_user_group_delete', label: 'Delete', parent: 'settings_user_group' },
                    { id: 'settings_user_group_view', label: 'View', parent: 'settings_user_group' },
                ]
            }
        ]
    },
];

/**
 * Recursively extract all module IDs from the MODULES structure
 */
const getAllModuleIds = (modules) => {
    const moduleIds = [];

    modules.forEach(module => {
        moduleIds.push(module.id);
        if (module.children && module.children.length > 0) {
            moduleIds.push(...getAllModuleIds(module.children));
        }
    });

    return moduleIds;
};

/**
 * Get all possible permissions (for Administrator)
 * Returns permissions for all modules/sessions with all permission types enabled
 */
export const getAllPermissions = () => {
    // Get all module IDs from the hierarchical structure
    const allModuleIds = getAllModuleIds(MODULES_STRUCTURE);

    const permissions = {};

    // Set all permissions to true for each module/session
    allModuleIds.forEach(moduleId => {
        permissions[moduleId] = {
            isView: true,
            isCreate: true,
            isEdit: true,
            isDelete: true,
            isDownload: true,
            // Also set isActive for backward compatibility
            isActive: true
        };
    });

    // Dashboard is always active (but not necessarily create/edit/delete)
    permissions.dashboard = {
        isView: true,
        isCreate: false,
        isEdit: false,
        isDelete: false,
        isDownload: false,
        isActive: true
    };

    return permissions;
};

/**
 * Check if user is System Administrator
 * Checks if username matches ADMIN_USERNAME from .env
 */
export const isUserAdministrator = async (userId) => {
    try {
        const user = await User.findById(userId)
            .select('username')
            .lean();

        if (!user) {
            return false;
        }

        // Check if username matches admin username from .env
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        return user.username.toLowerCase() === adminUsername.toLowerCase();
    } catch (error) {
        console.error('Error checking if user is administrator:', error);
        return false;
    }
};


import express from 'express';
import { getUsers } from '../controllers/user/getUsers.js';
import { getUserById } from '../controllers/user/getUserById.js';
import { getUserPermissionsController } from '../controllers/user/getUserPermissions.js';
import { createUser } from '../controllers/user/createUser.js';
import { updateUser } from '../controllers/user/updateUser.js';
import { deleteUser } from '../controllers/user/deleteUser.js';
import { validatePassword } from '../controllers/user/validatePassword.js';
import { uploadUserProfilePicture } from '../controllers/user/uploadUserProfilePicture.js';
import { getGroups } from '../controllers/group/getGroups.js';
import { getGroupById } from '../controllers/group/getGroupById.js';
import { createGroup } from '../controllers/group/createGroup.js';
import { updateGroup } from '../controllers/group/updateGroup.js';
import { deleteGroup } from '../controllers/group/deleteGroup.js';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission, requireAdmin } from '../middleware/permissionMiddleware.js';

const router = express.Router();

// All user routes require authentication
router.use(protect);

// Group routes (must come before /:id to avoid route conflicts)
// All group routes require settings_user_group permission
router.get('/groups/all', checkPermission('settings_user_group', 'view'), getGroups);
router.get('/groups/:id', checkPermission('settings_user_group', 'view'), getGroupById);
router.post('/groups', checkPermission('settings_user_group', 'create'), createGroup);
router.patch('/groups/:id', checkPermission('settings_user_group', 'edit'), updateGroup);
router.delete('/groups/:id', checkPermission('settings_user_group', 'delete'), deleteGroup);

// User routes
// Get all users - requires view permission
router.get('/', checkPermission('settings_user_group', 'view'), getUsers);

// Get current user permissions - no permission check needed (user's own permissions)
router.get('/permissions', getUserPermissionsController);

// Validate password - no permission check needed (user's own password)
router.post('/:id/validate-password', validatePassword); // Must come before /:id

// Get user by ID - requires view permission
router.get('/:id', checkPermission('settings_user_group', 'view'), getUserById);

// Create user - requires create permission
router.post('/', checkPermission('settings_user_group', 'create'), createUser);

// Update user - requires edit permission
router.patch('/:id', checkPermission('settings_user_group', 'edit'), updateUser);

// Upload profile picture
router.post('/:id/upload-profile-picture', checkPermission('settings_user_group', 'edit'), uploadUserProfilePicture);

// Delete user - requires delete permission
router.delete('/:id', checkPermission('settings_user_group', 'delete'), deleteUser);

export default router;

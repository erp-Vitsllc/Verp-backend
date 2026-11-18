import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkModuleOrParent, checkPermission, checkPermissionAny } from '../middleware/permissionMiddleware.js';
import { listCategoryImages, listCategories, createCategory, updateCategory, deleteCategory } from '../controllers/inventory/categories.js';
import { listSubcategoryImages, listSubcategories, createSubcategory, updateSubcategory, deleteSubcategory } from '../controllers/inventory/subcategories.js';
import { listItemOptions, createItemOption } from '../controllers/inventory/itemOptions.js';
import { listBrandImages, listBrands, createBrand, updateBrand, deleteBrand } from '../controllers/inventory/itemBrands.js';
import { listItems, getItem, createItem, updateItem, deleteItem } from '../controllers/inventory/items.js';
import { addItemStock, createPendingItem, listStockOptions } from '../controllers/inventory/itemStock.js';
import { approveStockEntry, getStockEntry, listInventoryBills, listStockEntries, rejectStockEntry, saveStockEntry, stockApprovalContext } from '../controllers/inventory/stockEntries.js';
import { createVendor, deleteVendor, getVendor, listVendorBills, listVendors, nextVendorCode, previewZohoVendor, syncVendorFromZoho, updateVendor } from '../controllers/inventory/vendors.js';
import { createVendorContact, deleteVendorContact, markVendorContactPrimary, updateVendorContact } from '../controllers/inventory/vendorContacts.js';
import { createDelivery, deleteDelivery, listDeliveries } from '../controllers/inventory/deliveries.js';
import { hasPermission } from '../services/permissionService.js';

const router = express.Router();

const viewItems = checkPermission('inventory_item_master', 'view');
const createItems = checkPermission('inventory_item_master', 'create');
const editItems = checkPermission('inventory_item_master', 'edit');
const deleteItems = checkPermission('inventory_item_master', 'delete');

router.get('/categories/images', protect, viewItems, listCategoryImages);
router.get('/categories', protect, viewItems, listCategories);
router.post('/categories', protect, checkPermission('inventory_item_master_category', 'create'), createCategory);
router.put('/categories/:id', protect, checkPermission('inventory_item_master_category', 'edit'), updateCategory);
router.delete('/categories/:id', protect, checkPermission('inventory_item_master_category', 'delete'), deleteCategory);

router.get('/subcategories/images', protect, viewItems, listSubcategoryImages);
router.get('/subcategories', protect, viewItems, listSubcategories);
router.post('/subcategories', protect, checkPermission('inventory_item_master_subcategory', 'create'), createSubcategory);
router.put('/subcategories/:id', protect, checkPermission('inventory_item_master_subcategory', 'edit'), updateSubcategory);
router.delete('/subcategories/:id', protect, checkPermission('inventory_item_master_subcategory', 'delete'), deleteSubcategory);

router.get('/item-options', protect, viewItems, listItemOptions);
router.post('/item-options', protect, createItems, createItemOption);

router.get('/brands/images', protect, viewItems, listBrandImages);
router.get('/brands', protect, viewItems, listBrands);
router.post('/brands', protect, checkPermission('inventory_item_master_brand', 'create'), createBrand);
router.put('/brands/:id', protect, checkPermission('inventory_item_master_brand', 'edit'), updateBrand);
router.delete('/brands/:id', protect, checkPermission('inventory_item_master_brand', 'delete'), deleteBrand);

const viewVendors = checkPermission('inventory_vendor', 'view');
const createVendors = checkPermission('inventory_vendor', 'create');
const editVendors = checkPermission('inventory_vendor', 'edit');
const deleteVendors = checkPermission('inventory_vendor', 'delete');
const createContacts = checkModuleOrParent('inventory_vendor_contact', 'inventory_vendor', 'create');
const editContacts = checkModuleOrParent('inventory_vendor_contact', 'inventory_vendor', 'edit');
const deleteContacts = checkModuleOrParent('inventory_vendor_contact', 'inventory_vendor', 'delete');

router.get('/vendors/next-code', protect, viewVendors, nextVendorCode);
router.get('/vendors/zoho-preview', protect, viewVendors, previewZohoVendor);
router.get('/vendors', protect, viewVendors, listVendors);
router.post('/vendors', protect, createVendors, createVendor);
router.get('/vendors/:id', protect, viewVendors, getVendor);
router.get('/vendors/:id/bills', protect, viewVendors, listVendorBills);
router.post('/vendors/:id/sync', protect, viewVendors, syncVendorFromZoho);
router.put('/vendors/:id', protect, editVendors, updateVendor);
router.delete('/vendors/:id', protect, deleteVendors, deleteVendor);
router.post('/vendors/:id/contacts', protect, createContacts, createVendorContact);
router.put('/vendors/:id/contacts/:contactId', protect, editContacts, updateVendorContact);
router.post('/vendors/:id/contacts/:contactId/primary', protect, editContacts, markVendorContactPrimary);
router.delete('/vendors/:id/contacts/:contactId', protect, deleteContacts, deleteVendorContact);

const DELIVERY_VIEW_MODULES = [
    'inventory',
    'inventory_item_master',
    'inventory_item_master_category',
    'inventory_item_master_subcategory',
    'inventory_item_master_brand',
    'inventory_vendor',
    'inventory_vendor_contact',
];

async function viewDelivery(req, res, next) {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ message: 'Not authorized, no user found' });
        for (const moduleId of DELIVERY_VIEW_MODULES) {
            if (await hasPermission(userId, moduleId, 'view')) return next();
        }
        return res.status(403).json({ message: "Access denied. You don't have permission for Delivery." });
    } catch (error) {
        console.error('Error checking delivery permission:', error);
        return res.status(500).json({ message: 'Error checking permissions' });
    }
}

router.get('/bills', protect, viewDelivery, listInventoryBills);
router.get('/deliveries', protect, viewDelivery, listDeliveries);
router.post('/deliveries', protect, viewDelivery, createDelivery);
router.delete('/deliveries/:id', protect, viewDelivery, deleteDelivery);

const stockWriters = checkPermissionAny('inventory_item_master', ['edit', 'create']);
router.get('/stock-entries/approval-context', protect, viewItems, stockApprovalContext);
router.get('/stock-entries', protect, viewItems, listStockEntries);
router.post('/stock-entries', protect, stockWriters, saveStockEntry);
router.post('/stock-entries/:id/approve', protect, viewItems, approveStockEntry);
router.post('/stock-entries/:id/reject', protect, viewItems, rejectStockEntry);
router.get('/stock-entries/:id', protect, viewItems, getStockEntry);

router.get('/items', protect, viewItems, listItems);
router.get('/items/stock-options', protect, viewItems, listStockOptions);
router.post('/items/pending', protect, createItems, createPendingItem);
router.post('/items', protect, createItems, createItem);
router.post('/items/:id/stock', protect, checkPermissionAny('inventory_item_master', ['edit', 'create']), addItemStock);
router.get('/items/:id', protect, viewItems, getItem);
router.put('/items/:id', protect, editItems, updateItem);
router.delete('/items/:id', protect, deleteItems, deleteItem);

export default router;

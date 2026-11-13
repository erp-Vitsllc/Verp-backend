import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission } from '../middleware/permissionMiddleware.js';
import { listCategories, createCategory } from '../controllers/inventory/categories.js';
import { listSubcategories, createSubcategory } from '../controllers/inventory/subcategories.js';
import { listItemOptions, createItemOption } from '../controllers/inventory/itemOptions.js';
import { listBrands, createBrand } from '../controllers/inventory/itemBrands.js';
import { listItems, getItem, createItem, updateItem } from '../controllers/inventory/items.js';
import { createVendor, deleteVendor, getVendor, listVendors, nextVendorCode, previewZohoVendor } from '../controllers/inventory/vendors.js';
import { createVendorContact, updateVendorContact } from '../controllers/inventory/vendorContacts.js';

const router = express.Router();

const viewItems = checkPermission('inventory_item_master', 'view');
const createItems = checkPermission('inventory_item_master', 'create');
const editItems = checkPermission('inventory_item_master', 'edit');

router.get('/categories', protect, viewItems, listCategories);
router.post('/categories', protect, checkPermission('inventory_item_master_category', 'create'), createCategory);

router.get('/subcategories', protect, viewItems, listSubcategories);
router.post('/subcategories', protect, checkPermission('inventory_item_master_subcategory', 'create'), createSubcategory);

router.get('/item-options', protect, viewItems, listItemOptions);
router.post('/item-options', protect, createItems, createItemOption);

router.get('/brands', protect, viewItems, listBrands);
router.post('/brands', protect, checkPermission('inventory_item_master_brand', 'create'), createBrand);

const viewVendors = checkPermission('inventory_vendor', 'view');
const createVendors = checkPermission('inventory_vendor', 'create');
const editVendors = checkPermission('inventory_vendor', 'edit');

router.get('/vendors/next-code', protect, viewVendors, nextVendorCode);
router.get('/vendors/zoho-preview', protect, viewVendors, previewZohoVendor);
router.get('/vendors', protect, viewVendors, listVendors);
router.post('/vendors', protect, createVendors, createVendor);
router.get('/vendors/:id', protect, viewVendors, getVendor);
router.delete('/vendors/:id', protect, deleteVendor);
router.post('/vendors/:id/contacts', protect, createVendors, createVendorContact);
router.put('/vendors/:id/contacts/:contactId', protect, editVendors, updateVendorContact);

router.get('/items', protect, viewItems, listItems);
router.post('/items', protect, createItems, createItem);
router.get('/items/:id', protect, viewItems, getItem);
router.put('/items/:id', protect, editItems, updateItem);

export default router;

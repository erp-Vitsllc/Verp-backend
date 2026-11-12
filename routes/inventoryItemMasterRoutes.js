import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { listCategories, createCategory } from '../controllers/inventory/categories.js';
import { listSubcategories, createSubcategory } from '../controllers/inventory/subcategories.js';
import { listItemOptions, createItemOption } from '../controllers/inventory/itemOptions.js';
import { listBrands, createBrand } from '../controllers/inventory/itemBrands.js';
import { listItems, getItem, createItem, updateItem } from '../controllers/inventory/items.js';

const router = express.Router();

router.get('/categories', protect, listCategories);
router.post('/categories', protect, createCategory);

router.get('/subcategories', protect, listSubcategories);
router.post('/subcategories', protect, createSubcategory);

router.get('/item-options', protect, listItemOptions);
router.post('/item-options', protect, createItemOption);

router.get('/brands', protect, listBrands);
router.post('/brands', protect, createBrand);

router.get('/items', protect, listItems);
router.post('/items', protect, createItem);
router.get('/items/:id', protect, getItem);
router.put('/items/:id', protect, updateItem);

export default router;

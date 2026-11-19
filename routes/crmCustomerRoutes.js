import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { checkPermission } from '../middleware/permissionMiddleware.js';
import {
    createCustomerContact,
    deleteCustomerContact,
    markCustomerContactPrimary,
    updateCustomerContact,
} from '../controllers/crm/customerContacts.js';
import {
    createCustomer,
    deleteCustomer,
    getCustomer,
    listCustomerDeliveries,
    listCustomerInvoices,
    listCustomerProjects,
    listCustomers,
    nextCustomerCode,
    previewZohoCustomer,
    syncCustomerFromZoho,
    updateCustomer,
} from '../controllers/crm/customers.js';

const router = express.Router();

const viewCustomers = checkPermission('crm', 'view');
const createCustomers = checkPermission('crm', 'create');
const editCustomers = checkPermission('crm', 'edit');
const deleteCustomers = checkPermission('crm', 'delete');

router.get('/customers/next-code', protect, viewCustomers, nextCustomerCode);
router.get('/customers/zoho-preview', protect, viewCustomers, previewZohoCustomer);
router.get('/customers', protect, viewCustomers, listCustomers);
router.post('/customers', protect, createCustomers, createCustomer);
router.get('/customers/:id', protect, viewCustomers, getCustomer);
router.get('/customers/:id/invoices', protect, viewCustomers, listCustomerInvoices);
router.get('/customers/:id/deliveries', protect, viewCustomers, listCustomerDeliveries);
router.get('/customers/:id/projects', protect, viewCustomers, listCustomerProjects);
router.post('/customers/:id/sync', protect, viewCustomers, syncCustomerFromZoho);
router.post('/customers/:id/contacts', protect, createCustomers, createCustomerContact);
router.put('/customers/:id/contacts/:contactId', protect, editCustomers, updateCustomerContact);
router.post('/customers/:id/contacts/:contactId/primary', protect, editCustomers, markCustomerContactPrimary);
router.delete('/customers/:id/contacts/:contactId', protect, deleteCustomers, deleteCustomerContact);
router.put('/customers/:id', protect, editCustomers, updateCustomer);
router.delete('/customers/:id', protect, deleteCustomers, deleteCustomer);

export default router;

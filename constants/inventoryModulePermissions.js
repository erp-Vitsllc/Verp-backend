/**
 * Inventory permission tree — used by services/permissionService.js (MODULES_STRUCTURE).
 * Keep in sync with VERP_frontend/src/constants/inventoryModulePermissions.js.
 *
 * Create, edit, and delete on Category, Sub Category, and Brand control those row actions.
 * Create, edit, and delete on Item Master control Add Item and the Items row actions.
 * Create, edit, and delete on Vendor Management control the vendor list.
 * Create, edit, and delete on Contact control a vendor's contacts.
 */

export const INVENTORY_MODULE = {
    id: 'inventory',
    label: 'Inventory',
    parent: null,
    hasDownload: false,
    children: [
        {
            id: 'inventory_item_master',
            label: 'Item Master',
            parent: 'inventory',
            hasDownload: false,
            children: [
                {
                    id: 'inventory_item_master_category',
                    label: 'Category',
                    parent: 'inventory_item_master',
                    hasDownload: false,
                },
                {
                    id: 'inventory_item_master_subcategory',
                    label: 'Sub Category',
                    parent: 'inventory_item_master',
                    hasDownload: false,
                },
                {
                    id: 'inventory_item_master_brand',
                    label: 'Brand',
                    parent: 'inventory_item_master',
                    hasDownload: false,
                },
            ],
        },
        {
            id: 'inventory_vendor',
            label: 'Vendor Management',
            parent: 'inventory',
            hasDownload: false,
            children: [
                {
                    id: 'inventory_vendor_contact',
                    label: 'Contact',
                    parent: 'inventory_vendor',
                    hasDownload: false,
                },
            ],
        },
    ],
};

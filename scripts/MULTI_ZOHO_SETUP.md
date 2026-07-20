# Multi-Zoho setup (2 Zoho Books orgs)

Use this when some employees belong to **Vega** Zoho and others to **NNIT** Zoho.

## How it works

| Layer | Behavior |
|---|---|
| `.env` | One OAuth app (`ZOHO_CLIENT_ID` / `SECRET` / `REDIRECT`) + **default** `ZOHO_ORGANIZATION_ID` (Zoho #1) |
| Company | `zohoOrganizationId` = that company’s Zoho Books org id |
| Tokens | `data/zoho-tokens.json` (default) and `data/zoho-tokens-{orgId}.json` per org |
| API | Pass `?organizationId=` or `?companyId=` on `/api/zoho/*` |

## Steps

### 1. Zoho side
1. Create / open Zoho Books org A (e.g. Vega) → copy **Organization ID**.
2. Create / open Zoho Books org B (e.g. NNIT) → copy **Organization ID**.
3. API Console app redirect URI = `ZOHO_REDIRECT_URI` (e.g. `http://localhost:5000/api/zoho/callback`).
4. If both orgs are under the **same Zoho account**, one Client ID/Secret is enough.  
   If they are **different Zoho logins**, you need a second API client (advanced — not in `.env` dual keys yet).

### 2. `.env` (default = Zoho #1)
```env
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REDIRECT_URI=http://localhost:5000/api/zoho/callback
ZOHO_ORGANIZATION_ID=<VEGA_ORG_ID>
ZOHO_OAUTH_SCOPE=...full scopes from .env.example...
```

### 3. Map companies in ERP
On each Company document set:

- Vega Digital company → `zohoOrganizationId = <VEGA_ORG_ID>`
- NNIT / Neoron Nexus company → `zohoOrganizationId = <NNIT_ORG_ID>`

Example (Mongo):
```js
db.companies.updateOne(
  { name: /vega/i },
  { $set: { zohoOrganizationId: "665524812", zohoOrganizationLabel: "Vega Books" } }
)
db.companies.updateOne(
  { name: /neoron|nnit/i },
  { $set: { zohoOrganizationId: "NNNNNNNNN", zohoOrganizationLabel: "NNIT Books" } }
)
```

Or via company update API fields: `zohoOrganizationId`, `zohoOrganizationLabel`.

### 4. Connect each org (OAuth)
Logged-in admin:

1. `GET /api/zoho/auth-url?organizationId=<VEGA_ORG_ID>` → open `authorizationUrl` → approve  
2. `GET /api/zoho/auth-url?organizationId=<NNIT_ORG_ID>` → approve again (as that org’s Zoho user)

Check: `GET /api/zoho/connections`

### 5. Use the right Zoho when calling
Examples:

- Vendors for NNIT company:  
  `GET /api/zoho/vendors?companyId=<nnitCompanyMongoId>&sync=true`
- Or:  
  `GET /api/zoho/vendors?organizationId=<NNIT_ORG_ID>`

Without query params, the **default** `ZOHO_ORGANIZATION_ID` is used.

### 6. Utility bills
After HR approve, sync picks Zoho org from the employee’s **company** (`zohoOrganizationId`), then creates the bill in that org.

## Notes
- Do **not** put two `ZOHO_ORGANIZATION_ID=` lines in `.env` (last wins).
- Re-login / reconnect after changing scopes.
- Accounts UI “Connect Zoho” currently uses the default org unless you pass `organizationId` (hooks can be extended later with an org picker).

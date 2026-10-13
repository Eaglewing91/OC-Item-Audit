# OC Item Audit

**A clean, read-only Organized Crime item audit dashboard for [Torn](https://www.torn.com/).**

**Version:** 1.0.0 (first public release)  
**Author:** Eaglewing [571041]  
**Licence:** [MIT](LICENSE)  
**Dependencies:** A userscript manager, a personal Torn API key. TornTools is optional.

OC Item Audit helps faction members review the items **lost** or **consumed** during completed Organized Crimes (OCs). It separates total estimated item costs from the **faction-owned portion**, shows ownership and activity details, and exports CSV summaries without automating any actions in Torn.

> **Not an official Torn product.** This community userscript is independent of OC Ultimate Helper. Values are estimates based on **current market prices**, not historical purchase prices.

## Features

- **Overview dashboard** — completed OCs, lost items, consumed items, overall estimated cost and faction-specific cost.
- **Ownership breakdown** — faction-owned, member-owned and unknown-owner item events.
- **Item cost table** — sortable quantities, current unit values, estimated costs and OC counts by item.
- **Activity log** — event-by-event view with execution date, OC name, slot, member XID, item, reason and owner; 100 entries per page.
- **Flexible date ranges** — 7/14/30 days or custom TCT (UTC) dates.
- **Filters** — filter by ownership and OC type. These filters affect item records and cost totals, *not* the number of completed OCs.
- **Optional TornTools prices** — import visible unit values from identified item rows on the Items page. Torn API prices are the default.
- **Two CSV exports** — item totals and individual slot details. **No Audit JSON / raw completed-crimes export.**
- **Read-only Torn API access** — no joining crimes, item use, attacks or automated game actions.

## Installation

1. Install a userscript manager (for example, **Tampermonkey**) in your browser.
2. Open [`OC-Item-Audit.user.js`](OC-Item-Audit.user.js) in this repository and select **Raw**. If your manager offers an installation prompt, confirm it.
3. If no prompt appears, copy the raw script into a new userscript in your manager, then save.
4. Open Torn's **Faction**, **Organized Crimes**, or **Items** page.
5. Click the **OC Item Audit** launcher and open **Settings** to enter your own API key.
6. Return to **Overview**, select a date range and choose **Fetch report**.

The script is active on:

```text
https://www.torn.com/factions.php*
https://www.torn.com/organizedcrimes.php*
https://www.torn.com/item.php*
```

## Torn API requirements

Each user supplies **their own** 16-character Torn API key. The key must permit access to: (Minimal API is sufficient)

| API endpoint | Used for |
| --- | --- |
| `faction/basic` | Faction identity/name |
| `faction/crimes` | Completed OC history and reported slot item outcomes |
| `torn/items` | Item names and current market values |

A key with these endpoint selections is not a guarantee of access: Torn may restrict faction information according to the player's position or API permissions. Create/manage your key at [Torn API settings](https://www.torn.com/preferences.php#tab=api).

## API key privacy and local storage

**No developer API key is included or hardcoded in the public userscript.** Everyone enters their **own** key in **Settings → Torn API key → Save key**.

### Where is the key stored?

The script stores the key in the **userscript manager's persistent storage for this script**, inside the user's local browser profile, using `GM.setValue` and retrieves it with `GM.getValue`.

The key's internal storage name in v1.0.0 is:

```text
eaglewing_oc_item_audit_v1_key
```

The relevant code is:

```javascript
const PREFIX = 'eaglewing_oc_item_audit_v1_';
const save = (name, value) => GM.setValue(PREFIX + name, value);
// Save key: await save('key', next);
// Load key: key = await read('key', '');
```

This is **not stored in the downloaded `.user.js` source file**, GitHub repository or a developer database. The tracker also stores item-price caches and the TornTools price preference in the same per-script storage area. Completed OC history is held in page memory while a report is open; it is not saved as a persistent history database by this script.

### Where is the key sent?

Torn API requests are sent over HTTPS to **`https://api.torn.com/v2/`**. Authentication uses the request header:

```http
Authorization: ApiKey <your-own-key>
```

The key is **not appended to the API URL**, transmitted to the author, sent to analytics, or uploaded to GitHub by this script. A browser, userscript manager or other extension with sufficient access may still be able to inspect local storage or in-memory data.

**Security considerations:** The script does **not** encrypt the key at rest; storage protection depends on your browser, profile, device and userscript manager. Use the least-privileged key you can, do not share it, and avoid saving it on shared computers. Anyone with access to your browser profile or a sufficiently privileged extension might be able to access it.

Click **Settings → Remove key** to clear the saved key value from the script's storage. This does not revoke the key at Torn; revoke it separately in Torn API settings if needed. Uninstalling the script and clearing its manager storage are separate actions determined by your userscript manager.

## How items and costs are counted

The script audits **completed OCs**, including successful and failed OCs in the selected date range. An OC is counted even if **no item** was lost or consumed.

| Report field | Calculation |
| --- | --- |
| **Completed OCs** | All fetched completed crimes in the chosen execution period (regardless of items). |
| **Lost** | Slot item outcomes explicitly reported as `lost`. |
| **Consumed** | Outcomes reported as `used` where the corresponding required item is explicitly **non-reusable**. |
| **Total item cost** | `(lost + consumed) × current available unit market value`, across all ownership categories. |
| **Faction item cost** | The corresponding cost attributable to `faction`-owned item events only. |

The **Consumed** figure can include both faction-owned and member-owned items. The owner filter and faction-specific cost distinguish those categories.

The script does **not** infer depletion for items merely listed as required, reusable items reported as used, unused outcomes, or used items whose reusability cannot be established. Missing or expired prices are not guessed: relevant item events remain in quantities, but their cost is **excluded from the priced subtotal** and a warning is displayed.

### Limitations and historical coverage

- Torn execution-date reporting used by the script begins **15 January 2025**.
- Item outcomes are available for OCs executed **after 25 July 2025**. Older OCs can still be counted, but their unrecorded item outcomes cannot be reconstructed.
- Missing timestamps, incomplete slots, unknown reusability or item IDs, and unpriced items can limit the estimate; the dashboard reports relevant issues.
- Long date ranges may require many **sequential, read-only** API requests. Progress and cancellation are supported. Interrupted data fetches are identified as **partial**, never complete.
- Market-price estimates may differ from actual historical purchase costs or replacement prices.

## Item prices and TornTools

The tracker uses the Torn API's market values by default. If TornTools is installed, you can optionally import unit prices that are **already visible** on Torn's **Items** page:

1. Open an Items inventory category where TornTools values are displayed.
2. In **OC Item Audit → Settings**, select **Import visible prices**.
3. Repeat for each category you want to import.
4. Enable **Prefer imported TornTools unit prices** to prefer fresh imported values.

The script only reads identifiable, visible item rows. It cannot access TornTools' private extension storage. Both imported values and API catalogue prices expire after **six hours**. You can refresh or clear price caches from Settings.

## CSV exports and sharing

- **Items CSV:** aggregated item quantities, unit values, cost estimates, ownership-related faction cost and report metadata.
- **Details CSV:** individual item events, including OC identifiers, member XIDs, ownership, timestamps, and calculated costs.

Exports are generated **locally in the browser**. They are not uploaded by this script. **Review exported data before posting publicly**; a CSV can reveal private faction or member information.

**Audit JSON export was intentionally removed for this public release.** Normal JSON parsing of Torn API responses remains necessary for the script to work.

## Troubleshooting

**“Save your own Torn API key first.”** Open Settings, enter a valid key and select Save key. If this is a renamed installation, the prior script's saved key may not carry over.

**Torn denies faction crime access.** Verify the API endpoint selections and your faction position/permissions.

**Completed OCs exceed losses/consumption.** Completed OCs with no qualifying item events are still counted.

**Prices are unavailable.** Refresh API prices, or import eligible visible TornTools values. Missing prices are never estimated silently.

**A report is slow or partial.** Long history requests are deliberately paced to protect API usage and completeness. Choose a shorter range or retry.

## Licence and attribution

Copyright © 2026 **Eaglewing [571041]**. Released under the [MIT License](LICENSE).

OC Item Audit is an independent community userscript and is not affiliated with or endorsed by Torn.

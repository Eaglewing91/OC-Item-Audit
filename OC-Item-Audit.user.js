// ==UserScript==
// @name         OC Item Audit
// @namespace    https://www.torn.com/profiles.php?XID=571041
// @version      1.0.2
// @updateURL    https://raw.githubusercontent.com/Eaglewing91/OC-Item-Audit/main/OC-Item-Audit.user.js
// @downloadURL  https://raw.githubusercontent.com/Eaglewing91/OC-Item-Audit/main/OC-Item-Audit.user.js
// @description  Audit completed Torn OC item losses, consumption, ownership and estimated costs in a clean dashboard.
// @author       Eaglewing [571041]
// @match        https://www.torn.com/factions.php*
// @match        https://www.torn.com/organizedcrimes.php*
// @match        https://www.torn.com/item.php*
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.registerMenuCommand
// @connect      api.torn.com
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

// Terms of Service
// | Data Storage                 | Data Sharing | Purpose of Use                          | Key Storage & Sharing             | Key Access Level                           |
// |------------------------------|--------------|-----------------------------------------|-----------------------------------|--------------------------------------------|
// | No / Only locally (key and   | Nobody       | Non malicious statistical analysis      | Stored locally / Not shared; sent | Minimal (faction/basic, faction/crimes,    |
// | price caches in userscript   |              | (faction OC item loss and cost audit)   | only to api.torn.com              | torn/items) + faction position with API    |
// | storage; OC history in memory|              |                                         |                                   | access                                     |
// | only while a report is open) |              |                                         |                                   |                                            |

(function () {
    'use strict';
    const VERSION = '1.0.2';
    // Local, per-userscript storage prefix. No API key is bundled in this file.
    const PREFIX = 'eaglewing_oc_item_audit_v1_';
    const API = 'https://api.torn.com/v2/';
    const OUTCOME_START = Date.UTC(2025, 6, 26) / 1000;
    const EXECUTION_START = Date.UTC(2025, 0, 15) / 1000;
    const PRICE_TTL = 6 * 60 * 60 * 1000;
    const sleep = (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Cancelled'));
        const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
        const timer = setTimeout(finish, ms);
        const cancel = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
        signal?.addEventListener('abort', cancel, { once: true });
    });
    const validId = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
    const priceNumber = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
    const stamp = x => typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : null;
    const utcDay = date => date.toISOString().slice(0, 10);
    const timeText = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' TCT';
    const money = n => n == null ? 'Unavailable' : '$' + Math.round(n).toLocaleString('en-US');
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

    function dateRange(start, end, now = Math.floor(Date.now() / 1000)) {
        function parse(s) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Choose valid start and end dates.');
            const ms = Date.parse(s + 'T00:00:00Z');
            if (!Number.isFinite(ms) || utcDay(new Date(ms)) !== s) throw new Error('Invalid date.');
            return ms / 1000;
        }
        const from = parse(start), endStart = parse(end);
        if (from > endStart) throw new Error('The start date must be before the end date.');
        if (from > now) throw new Error('The start date cannot be in the future.');
        if (from < EXECUTION_START) throw new Error('Execution-date reports begin on 15 January 2025, when Torn started recording executed_at.');
        return { from, to: Math.min(endStart + 86399, now), start, end };
    }

    function makeRecords(crimes, range) {
        // IMPORTANT: Always count all completed OCs independently of item outcomes.
        // A crime with no lost items must still be included in the completed OC count.
        const records = [], seen = new Set();
        let undated = 0, incomplete = 0, outside = 0, selectedCrimes = 0;
        let unknownConsumption = 0, missingOutcomeItemId = 0;
        for (const crime of crimes) {
            if (!validId(crime?.id) || seen.has(Number(crime.id))) continue;
            seen.add(Number(crime.id));
            if (!['successful', 'failure', 'failed'].includes(String(crime.status).toLowerCase())) continue;
            const when = stamp(crime.executed_at);
            if (when == null) { undated++; continue; }
            if (when < range.from || when > range.to) { outside++; continue; }
            selectedCrimes++;
            if (!Array.isArray(crime.slots)) { incomplete++; continue; }
            crime.slots.forEach((slot, index) => {
                const req = slot?.item_requirement;
                const io = slot?.user?.item_outcome;
                const actualId = validId(io?.item_id) ? Number(io.item_id) : null;
                const requiredId = validId(req?.id) ? Number(req.id) : null;
                const outcome = String(io?.outcome || '').toLowerCase();

                // The API distinguishes lost (explicitly lost) and used (which may
                // be consumable). Do not infer any loss from an item requirement or
                // from missing/unused outcomes.
                if (outcome !== 'lost' && outcome !== 'used') return;
                if (!actualId) { missingOutcomeItemId++; return; }
                const reusable = actualId === requiredId && typeof req?.is_reusable === 'boolean' ? req.is_reusable : null;
                const lost = outcome === 'lost';
                const consumed = outcome === 'used' && reusable === false;
                if (outcome === 'used' && reusable === null) unknownConsumption++;
                if (!lost && !consumed) return; // reusable used items never need replacing

                const owner = ['faction', 'user'].includes(io?.owned_by) ? io.owned_by : 'unknown';
                const note = requiredId && actualId !== requiredId ? 'Outcome item differs from requirement' : '';
                records.push({ crimeId: Number(crime.id), crime: String(crime.name || 'Unnamed OC'), status: String(crime.status),
                    executed: when, slot: String(slot.position_info?.label || slot.position || 'Slot ' + (index + 1)),
                    slotIndex: index, userId: validId(slot.user?.id) ? Number(slot.user.id) : null,
                    itemId: actualId, itemUid: io?.item_uid ?? null, requiredItemId: requiredId,
                    owner, outcome, reason: lost ? 'Lost' : 'Consumed', reusable, note });
            });
        }
        return { records, undated, incomplete, outside, selectedCrimes, unknownConsumption, missingOutcomeItemId };
    }

    function aggregate(records, itemInfo) {
        const map = new Map();
        for (const rec of records) {
            if (rec.reason !== 'Lost' && rec.reason !== 'Consumed') continue;
            if (!map.has(rec.itemId)) map.set(rec.itemId, { id: rec.itemId, name: itemInfo(rec.itemId).name,
                lost: 0, consumed: 0, depleted: 0,
                factionDepleted: 0, userDepleted: 0, unknownDepleted: 0, crimes: new Set() });
            const row = map.get(rec.itemId);
            if (rec.reason === 'Lost') row.lost++;
            else row.consumed++;
            row.depleted++;
            row.crimes.add(rec.crimeId);
            row[rec.owner === 'faction' ? 'factionDepleted' : rec.owner === 'user' ? 'userDepleted' : 'unknownDepleted']++;
        }
        return [...map.values()].map(row => {
            const info = itemInfo(row.id), price = priceNumber(info.price);
            return { ...row, crimes: row.crimes.size, price, source: info.source, pricedAt: info.at,
                cost: price == null ? null : row.depleted * price,
                factionCost: !row.factionDepleted ? 0 : price == null ? null : row.factionDepleted * price };
        });
    }

    function csvCell(value) {
        let s = String(value ?? '');
        // Prevent spreadsheet formula injection, including leading whitespace.
        if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
    }
    const csv = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    function unitPriceFromTT(text) {
        // TornTools writes "$unit | Nx = $total" for stacks and "$unit" for single items.
        // Do not guess shortened values (e.g. "$1.2m") or confuse a total with a unit price.
        const t = String(text).trim();
        const match = t.match(/^\$([\d,]+(?:\.\d{1,2})?)\s*(?:\|\s*\d+x\s*=\s*\$[\d,.]+)?$/i);
        if (!match) return null;
        return priceNumber(Number(match[1].replace(/,/g, '')));
    }

    async function fetchHistory(request, range, signal, progress) {
        const crimes = new Map();
        const windows = [{ from: range.from, to: range.to }];
        let requests = 0;
        async function page(from, to, offset = 0) {
            if (signal?.aborted) throw new Error('Cancelled');
            if (requests >= 500) throw new Error('Request safety limit reached; report is partial. Use a shorter range.');
            const parameters = { cat: 'completed', filters: 'executed_at', from, to, sort: 'DESC', limit: 100 };
            // Normal history retrieval does not rely on offsets. They are only needed if
            // at least 100 crimes share one exact second, which cannot be split further.
            if (offset) parameters.offset = offset;
            requests++;
            const data = await request('faction/crimes', parameters, signal);
            if (!Array.isArray(data?.crimes)) throw new Error('Torn did not return a crimes array.');
            const rows = data.crimes;
            if (rows.some(crime => !validId(crime?.id))) throw new Error('Crime records have missing IDs; report would be incomplete.');
            if (new Set(rows.map(crime => Number(crime.id))).size !== rows.length) throw new Error('Torn returned duplicate crime IDs within a page.');
            // Reject ignored date filters rather than reporting a false complete result.
            if (rows.some(crime => stamp(crime.executed_at) == null || crime.executed_at < from || crime.executed_at > to)) {
                throw new Error('Torn returned crimes outside the requested execution-time window. Date filtering was not respected; report is partial.');
            }
            for (const crime of rows) crimes.set(Number(crime.id), crime);
            progress(requests, crimes.size);
            return rows;
        }
        try {
            while (windows.length) {
                const window = windows.pop();
                const rows = await page(window.from, window.to);
                if (rows.length < 100) continue;
                if (window.from < window.to) {
                    // Full windows may hide older records. Split into disjoint inclusive
                    // halves and verify both. No second is dropped at a page boundary.
                    const midpoint = window.from + Math.floor((window.to - window.from) / 2);
                    windows.push({ from: window.from, to: midpoint });
                    windows.push({ from: midpoint + 1, to: window.to });
                    continue;
                }
                let offset = rows.length;
                const sameSecond = new Set(rows.map(crime => Number(crime.id)));
                while (true) {
                    const more = await page(window.from, window.to, offset);
                    if (!more.length) break;
                    let added = 0;
                    for (const crime of more) if (!sameSecond.has(Number(crime.id))) {
                        sameSecond.add(Number(crime.id)); added++;
                    }
                    if (!added) throw new Error('At least 100 OCs share one execution second and Torn repeated its offset page. That second cannot be fully verified; report is partial.');
                    if (more.length < 100) break;
                    offset += more.length;
                }
            }
            return [...crimes.values()].sort((a, b) => b.executed_at - a.executed_at || Number(b.id) - Number(a.id));
        } catch (error) {
            error.partial = [...crimes.values()];
            throw error;
        }
    }

    const core = { dateRange, makeRecords, aggregate, unitPriceFromTT, csv, csvCell, fetchHistory, priceNumber };
    if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }

    let key = '', catalog = { at: 0, items: {} }, ttPrices = {}, preferTT = true;
    let report = null, busy = false, controller = null, lastRequest = 0, detailPage = 0;
    let host, root, panel, launcher;
    let sortBy = 'cost', sortDirection = -1, currentView = 'overview', launcherPos = 'bottom-right';
    const LAUNCHER_POSITIONS = ['bottom-right', 'bottom-left', 'middle-right'];
    const read = async (name, fallback) => {
        try { return await GM.getValue(PREFIX + name, fallback); } catch (_) { return fallback; }
    };
    // GM storage belongs to the userscript manager in this browser profile.
    const save = (name, value) => GM.setValue(PREFIX + name, value);
    const $ = selector => root.querySelector(selector);
    function message(text, bad = false) { $('#status-text').textContent = text; $('#status').classList.toggle('bad', bad); }
    function safeError(error) { return String(error?.message || 'Unknown error').split(key || '\u0000').join('[key redacted]'); }
    function info(id) {
        const item = catalog.items?.[id], tt = ttPrices[id];
        const freshTT = preferTT && tt && Date.now() - tt.at < PRICE_TTL && priceNumber(tt.price) != null;
        const freshAPI = Date.now() - catalog.at < PRICE_TTL && priceNumber(item?.price) != null;
        return { name: item?.name || 'Item #' + id,
            price: freshTT ? tt.price : freshAPI ? item.price : null,
            source: freshTT ? 'TornTools visible price' : freshAPI ? 'Torn API market value' : 'Unavailable / expired',
            at: freshTT ? tt.at : freshAPI ? catalog.at : null };
    }
    async function apiRequest(path, parameters = {}, signal) {
        if (!/^[A-Za-z0-9/]+$/.test(path)) throw new Error('Invalid API path.');
        for (let attempt = 0; attempt < 4; attempt++) {
            if (signal?.aborted) throw new Error('Cancelled');
            await sleep(Math.max(0, 2100 - (Date.now() - lastRequest)), signal);
            if (signal?.aborted) throw new Error('Cancelled');
            lastRequest = Date.now();
            const url = new URL(API + path);
            Object.entries({ ...parameters, comment: 'Eaglewing OC Item Audit' }).forEach(([k, v]) => url.searchParams.set(k, v));
            const response = await new Promise((resolve, reject) => {
                let handle, ended = false;
                const finish = (fn, result) => {
                    if (ended) return; ended = true;
                    signal?.removeEventListener('abort', abort); fn(result);
                };
                const abort = () => { try { handle?.abort(); } catch (_) {} finish(reject, new Error('Cancelled')); };
                signal?.addEventListener('abort', abort, { once: true });
                try {
                    handle = GM.xmlHttpRequest({ method: 'GET', url: url.href,
                        headers: { Authorization: 'ApiKey ' + key }, timeout: 25000,
                        onload: r => finish(resolve, r), onerror: () => finish(reject, new Error('API connection failed.')),
                        ontimeout: () => finish(reject, new Error('API request timed out.')), onabort: () => finish(reject, new Error('Cancelled')) });
                } catch (_) { finish(reject, new Error('API request could not start.')); }
            });
            let data = null, invalidJSON = false;
            try { data = JSON.parse(response.responseText); } catch (_) { invalidJSON = true; }
            const code = Number(data?.error?.code);
            const retry = response.status === 429 || code === 5 || (response.status >= 500 && response.status <= 599);
            if (retry && attempt < 3) {
                const seconds = code === 5 || response.status === 429 ? 30 : 5 * (attempt + 1);
                message('Torn is busy or rate-limited. Retrying in ' + seconds + ' seconds…');
                await sleep(seconds * 1000, signal); continue;
            }
            if (invalidJSON) throw new Error('Torn returned a non-JSON response (HTTP ' + response.status + ').');
            if (data?.error) {
                const hint = [2, 16].includes(code) ? ' Check the key and permissions for faction/crimes, faction/basic and torn/items. Your faction position must grant API access.' : '';
                throw new Error('Torn API ' + code + ': ' + String(data.error.error || data.error.message || 'request denied') + hint);
            }
            if (response.status !== 200) throw new Error('Torn API HTTP ' + response.status + '.');
            return data;
        }
        throw new Error('Torn API retries exhausted.');
    }
    async function loadPrices(force, signal) {
        if (!force && Date.now() - catalog.at < PRICE_TTL && Object.keys(catalog.items || {}).length) return;
        const data = await apiRequest('torn/items', {}, signal);
        if (!Array.isArray(data.items)) throw new Error('Torn did not return the v2 items catalogue.');
        const items = {};
        for (const item of data.items) if (validId(item?.id)) {
            items[item.id] = { name: String(item.name || 'Item #' + item.id), price: priceNumber(item.value?.market_price) };
        }
        if (!Object.keys(items).length) throw new Error('The item catalogue is empty.');
        catalog = { at: Date.now(), items }; await save('catalog', catalog);
    }
    function setBusy(value) {
        busy = value;
        root.querySelectorAll('[data-lock]').forEach(el => { el.disabled = value; });
        $('#cancel').hidden = !value;
        $('#fetch').innerHTML = value ? 'Fetching…' : 'Fetch report <span aria-hidden="true">↗</span>';
    }
    async function runReport() {
        if (busy) return;
        let range;
        try { range = dateRange($('#from').value, $('#to').value); } catch (err) { return message(safeError(err), true); }
        if (!key) { showView('settings'); $('#key').focus(); return message('Save your own Torn API key first.', true); }
        controller = new AbortController(); const signal = controller.signal;
        setBusy(true); report = null; detailPage = 0; showView('overview'); render();
        let faction = null, priceWarning = '', crimes = [];
        try {
            message('Checking your faction and API access…');
            const basic = await apiRequest('faction/basic', {}, signal);
            if (!validId(basic?.basic?.id)) throw new Error('This key has no valid faction.');
            faction = { id: Number(basic.basic.id), name: String(basic.basic.name || 'Faction') };
            crimes = await fetchHistory(apiRequest, range, signal, (page, count) => message('Fetched ' + count + ' completed OCs · API request ' + page + '…'));
            message('Loading item names and market values…');
            try { await loadPrices(false, signal); } catch (error) {
                if (signal.aborted) throw error;
                priceWarning = safeError(error);
            }
            report = { range, faction, crimes, complete: true, fetchedAt: Date.now(), priceWarning };
            message('Report ready. ' + crimes.length + ' completed OCs fetched; ' + makeRecords(crimes, range).records.length + ' lost/consumed item records.' + (priceWarning ? ' Some item values are unavailable.' : ''), !!priceWarning);
        } catch (error) {
            // A failure before completion must never publish a complete-looking result.
            if (faction) report = { range, faction, crimes: error.partial || crimes, complete: false, fetchedAt: Date.now(), priceWarning, error: safeError(error) };
            message((signal.aborted ? 'Cancelled.' : safeError(error)) + (report ? ' Showing a clearly marked partial report.' : ''), true);
        } finally { controller = null; setBusy(false); updateCrimeFilter(); render(); }
    }
    function filtered() {
        if (!report) return { records: [], selectedCrimes: 0 };
        const result = makeRecords(report.crimes, report.range);
        const owner = $('#owner').value, crime = $('#crime').value;
        result.records = result.records.filter(r => (owner === 'all' || owner === r.owner)
            && (crime === 'all' || crime === r.crime));
        return result;
    }
    function updateCrimeFilter() {
        const select = $('#crime');
        select.innerHTML = '<option value="all">All crimes</option>';
        for (const name of [...new Set((report ? makeRecords(report.crimes, report.range).records : []).map(r => r.crime))].sort()) {
            const option = document.createElement('option'); option.value = name; option.textContent = name; select.append(option);
        }
    }
    function totals(rows) {
        return rows.reduce((t, r) => {
            t.lost += r.lost; t.consumed += r.consumed; t.depleted += r.depleted;
            t.cost += r.cost || 0; t.factionCost += r.factionCost || 0;
            t.unpriced += r.price == null ? r.depleted : 0;
            return t;
        }, { lost: 0, consumed: 0, depleted: 0, cost: 0, factionCost: 0, unpriced: 0 });
    }
    function render() {
        const result = filtered(), rows = aggregate(result.records, info), t = totals(rows);
        const available = !!report;
        $('#exports').hidden = !available;
        $('#report-body').hidden = !available;
        $('#empty').hidden = available;
        updateConnection();
        updateView();
        if (!available) {
            $('#report-state').textContent = 'No report loaded';
            $('#report-state').className = 'report-state';
            return;
        }
        $('#report-state').textContent = report.complete ? 'Verified report' : 'Partial report';
        $('#report-state').className = 'report-state ' + (report.complete ? 'ready' : 'partial');
        $('#heading').textContent = report.faction.name + ' [' + report.faction.id + '] · ' + (report.complete ? 'OC item cost report' : 'PARTIAL REPORT');
        $('#heading').classList.toggle('bad', !report.complete);
        $('#period').textContent = timeText(report.range.from) + ' → ' + timeText(report.range.to) + ' · fetched ' + new Date(report.fetchedAt).toISOString().replace('T', ' ').slice(0, 19) + ' TCT';
        $('#summary').innerHTML = [
            ['Completed OCs', result.selectedCrimes, 'All completed OCs in range'],
            ['Lost items', t.lost, 'Explicitly lost outcomes'],
            ['Consumed items', t.consumed, 'Used non-reusable items'],
            ['Total item cost', money(t.cost), t.unpriced ? t.unpriced + ' events excluded: unpriced' : 'Current market value'],
            ['Faction item cost', money(t.factionCost), 'Faction-owned depleted items']
        ].map(([name, value, caption]) => '<div class="metric"><span>' + escape(name) + '</span><strong>' + escape(value) + '</strong><small>' + escape(caption) + '</small></div>').join('');
        const warnings = [];
        if (!report.complete) warnings.push('PARTIAL: ' + (report.error || 'Fetch did not finish') + '. Counts and costs cover fetched records only.');
        if (report.range.from < OUTCOME_START) warnings.push('Item outcomes only exist for crimes executed after 25 July 2025. Earlier crimes are included in OC totals but their unavailable item outcomes cannot be counted.');
        if (result.undated) warnings.push(result.undated + ' crimes excluded because execution timestamps were missing.');
        if (result.incomplete) warnings.push(result.incomplete + ' crimes have missing or invalid slots. Item totals may be incomplete.');
        if (result.outside) warnings.push(result.outside + ' crimes outside the selected execution period were excluded.');
        if (result.unknownConsumption) warnings.push(result.unknownConsumption + ' used item outcomes have unknown reusable status and are excluded from item cost calculations.');
        if (result.missingOutcomeItemId) warnings.push(result.missingOutcomeItemId + ' used/lost item outcomes have no valid item ID and cannot be assigned to an item.');
        if (t.unpriced) warnings.push(t.unpriced + ' lost/consumed items have no current price; their costs are excluded from the displayed subtotal.');
        if (report.priceWarning) warnings.push('Price lookup: ' + report.priceWarning);
        $('#warnings').textContent = warnings.map(w => '• ' + w).join('\n');
        $('#warnings').hidden = !warnings.length;
        $('#price-note').textContent = 'All completed OCs are counted, even those without item losses. Only LOST outcomes and USED non-reusable items contribute to item costs. Reusable used items, unused items, and unknown outcomes are excluded. Costs use current market values, not historical purchase prices. Owner and crime filters affect item costs, not the completed OC count.';
        const owners = { faction: 0, user: 0, unknown: 0 };
        for (const rec of result.records) owners[rec.owner]++;
        const totalEvents = result.records.length;
        const fraction = type => totalEvents ? owners[type] * 100 / totalEvents : 0;
        $('#ownership').innerHTML = '<div class="ownership-bar" title="Faction / member / unknown ownership">' +
            '<span class="ownership-faction" style="width:' + fraction('faction') + '%"></span>' +
            '<span class="ownership-member" style="width:' + fraction('user') + '%"></span>' +
            '<span class="ownership-unknown" style="width:' + fraction('unknown') + '%"></span></div>' +
            '<div class="ownership-legend">' + [
                ['faction', 'Faction-owned', 'ownership-faction'],
                ['user', 'Member-owned', 'ownership-member'],
                ['unknown', 'Unknown owner', 'ownership-unknown']
            ].map(([id, name, color]) => '<div class="legend-row"><span class="legend-name"><span class="legend-dot ' + color + '"></span>' + name + '</span><strong>' + owners[id].toLocaleString('en-US') + ' <span class="muted">(' + fraction(id).toFixed(1) + '%)</span></strong></div>').join('') + '</div>';
        rows.sort((a, b) => {
            const av = a[sortBy], bv = b[sortBy];
            if (av == null) return bv == null ? a.id - b.id : 1;
            if (bv == null) return -1;
            return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sortDirection || a.id - b.id;
        });
        root.querySelectorAll('[data-sort]').forEach(th => {
            const active = th.dataset.sort === sortBy;
            th.setAttribute('aria-sort', active ? (sortDirection === 1 ? 'ascending' : 'descending') : 'none');
            th.querySelector('.sort-arrow').textContent = !active ? '↕' : sortDirection === 1 ? '↑' : '↓';
        });
        $('#item-count').textContent = rows.length.toLocaleString('en-US') + ' item ' + (rows.length === 1 ? 'type' : 'types');
        $('#items').innerHTML = rows.length ? rows.map(r => '<tr><td><span class="primary-cell">' + escape(r.name) + '</span><span class="secondary-cell">Item #' + r.id + '</span></td>' +
            '<td class="t-right value-lost">' + r.lost + '</td><td class="t-right value-used">' + r.consumed + '</td>' +
            '<td class="t-right" title="' + escape(r.source + (r.pricedAt ? ' · ' + new Date(r.pricedAt).toISOString() : '')) + '"><span class="value-strong">' + money(r.price) + '</span><span class="secondary-cell">' + escape(r.source) + '</span></td>' +
            '<td class="t-right value-strong">' + money(r.cost) + '</td><td class="t-right value-accent">' + money(r.factionCost) + '</td><td class="t-right">' + r.crimes + '</td></tr>').join('') : '<tr><td class="empty-row" colspan="7">No lost or consumed items match the selected filters.</td></tr>';
        renderDetails(result.records);
    }
    function renderDetails(records) {
        const ordered = records.slice().sort((a, b) => b.executed - a.executed || b.crimeId - a.crimeId || a.slotIndex - b.slotIndex);
        const pages = Math.max(1, Math.ceil(ordered.length / 100)); detailPage = Math.min(Math.max(0, detailPage), pages - 1);
        $('#details-body').innerHTML = ordered.slice(detailPage * 100, (detailPage + 1) * 100).map(r => '<tr><td><span class="primary-cell">' + escape(timeText(r.executed).replace(' TCT', '')) + '</span><span class="secondary-cell">TCT</span></td>' +
            '<td><span class="primary-cell">' + escape(r.crime) + '</span><span class="secondary-cell">OC #' + r.crimeId + ' · ' + escape(r.status) + '</span></td>' +
            '<td><span class="primary-cell">' + escape(r.slot) + '</span><span class="secondary-cell">XID ' + escape(r.userId || 'unknown') + '</span></td>' +
            '<td><span class="primary-cell">' + escape(info(r.itemId).name) + '</span><span class="secondary-cell">Item #' + r.itemId + '</span></td>' +
            '<td><span class="pill ' + (r.reason === 'Lost' ? 'pill-lost' : 'pill-consumed') + '">' + escape(r.reason) + '</span></td>' +
            '<td><span class="pill ' + (r.owner === 'faction' ? 'pill-faction' : r.owner === 'user' ? 'pill-user' : 'pill-unknown') + '">' + escape(r.owner === 'user' ? 'Member' : r.owner === 'faction' ? 'Faction' : 'Unknown') + '</span></td>' +
            '<td class="muted">' + escape(r.note || '—') + '</td></tr>').join('') || '<tr><td class="empty-row" colspan="7">No matching losses or consumed items.</td></tr>';
        $('#detail-count').textContent = ordered.length.toLocaleString('en-US') + ' records · Page ' + (detailPage + 1) + ' of ' + pages;
        $('#prev').disabled = detailPage === 0; $('#next').disabled = detailPage >= pages - 1;
    }
    function download(content, type, suffix) {
        const prefix = report?.complete === false ? 'PARTIAL-' : '';
        const filename = prefix + 'OC-Item-Audit-' + (report?.faction?.id || 'prices') + '-' + (report?.range?.start || utcDay(new Date())) + '-' + (report?.range?.end || '') + '-' + suffix;
        const url = URL.createObjectURL(new Blob([content], { type }));
        const link = document.createElement('a'); link.href = url; link.download = filename;
        link.style.display = 'none'; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    function metaColumns() {
        return [report.complete ? 'Complete' : 'PARTIAL', report.faction.id, report.faction.name,
            timeText(report.range.from), timeText(report.range.to), $('#owner').value, $('#crime').value];
    }
    const metaHeaders = ['Report completeness', 'Faction ID', 'Faction', 'Range from TCT', 'Range to TCT', 'Owner filter', 'Crime filter'];
    function exportSummary() {
        if (!report) return;
        const rows = aggregate(filtered().records, info);
        const headers = [...metaHeaders, 'Item ID', 'Item', 'Lost', 'Consumed (used non-reusable)',
            'Unit market value', 'Price source', 'Price captured UTC', 'Total item cost', 'Faction item cost', 'OC count'];
        download(csv([headers, ...rows.map(r => [...metaColumns(), r.id, r.name, r.lost, r.consumed, r.price ?? '', r.source,
            r.pricedAt ? new Date(r.pricedAt).toISOString() : '', r.cost ?? '', r.factionCost ?? '', r.crimes])]),
            'text/csv;charset=utf-8', 'summary.csv');
    }
    function exportDetails() {
        if (!report) return;
        const headers = [...metaHeaders, 'OC ID', 'OC', 'Status', 'Executed TCT', 'Slot', 'Member XID', 'Item ID', 'Item', 'Item UID',
            'Owner', 'Torn item outcome', 'Cost reason', 'Unit market value', 'Price source', 'Price captured UTC', 'Item cost', 'Note'];
        download(csv([headers, ...filtered().records.map(r => {
            const item = info(r.itemId);
            return [...metaColumns(), r.crimeId, r.crime, r.status, timeText(r.executed), r.slot, r.userId, r.itemId, item.name,
                r.itemUid, r.owner, r.outcome, r.reason, item.price ?? '', item.source,
                item.at ? new Date(item.at).toISOString() : '', item.price ?? '', r.note];
        })]), 'text/csv;charset=utf-8', 'details.csv');
    }
    async function importTTPrices() {
        if (busy) return;
        let count = 0;
        const additions = {};
        for (const el of document.querySelectorAll('.tt-item-price')) {
            const row = el.closest('li[data-item]');
            // Only accept verified item IDs. Faction armory React row IDs are not item IDs.
            if (!row || !validId(row.dataset.item) || !el.getClientRects().length) continue;
            const price = unitPriceFromTT(el.textContent);
            if (price == null) continue;
            additions[Number(row.dataset.item)] = { price, at: Date.now() };
        }
        count = Object.keys(additions).length;
        if (!count) return message('No readable TornTools prices found. Open Items, enable TornTools item values, select a category and use OC Item Audit → Import visible prices. API prices still work.');
        // Merge against current storage so an inventory tab does not erase another tab's prices.
        ttPrices = { ...(await read('ttPrices', {})), ...additions };
        await save('ttPrices', ttPrices); render();
        message('Imported ' + count + ' visible TornTools unit prices. Cache lasts 6 hours. No API requests were needed.');
    }
    function setSelectedPreset(days) {
        root.querySelectorAll('[data-days]').forEach(el => {
            const selected = Number(el.dataset.days) === days;
            el.classList.toggle('is-selected', selected);
            el.setAttribute('aria-pressed', String(selected));
        });
    }
    function preset(days) {
        const now = new Date(), from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        from.setUTCDate(from.getUTCDate() - days + 1);
        $('#from').value = utcDay(from); $('#to').value = utcDay(now);
        setSelectedPreset(days);
    }
    function updateConnection() {
        if (!root) return;
        $('#connection-text').textContent = key ? 'API key saved' : 'No API key saved';
        $('#connection-dot').classList.toggle('connected', !!key);
    }
    function updateView() {
        if (!root) return;
        if (!report && (currentView === 'costs' || currentView === 'activity')) currentView = 'overview';
        root.querySelectorAll('[data-view]').forEach(button => {
            button.disabled = (button.dataset.view === 'costs' || button.dataset.view === 'activity') && !report;
            const active = button.dataset.view === currentView;
            button.classList.toggle('is-active', active);
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
        });
        root.querySelectorAll('[data-view-panel]').forEach(section => { section.hidden = section.dataset.viewPanel !== currentView; });
        $('#report-controls').hidden = currentView === 'settings';
        const titles = {
            overview: ['Report overview', 'Understand OC item usage, losses, and estimated replacement costs.'],
            costs: ['Item cost breakdown', 'See item quantities, unit prices, total value, and faction costs.'],
            activity: ['OC activity log', 'Inspect individual item loss and consumption records.'],
            settings: ['Audit settings', 'Manage your API connection, item values, and price preferences.']
        };
        $('#view-title').textContent = titles[currentView][0];
        $('#view-subtitle').textContent = titles[currentView][1];
    }
    function showView(view) {
        if ((view === 'costs' || view === 'activity') && !report) return;
        if (!['overview', 'costs', 'activity', 'settings'].includes(view)) return;
        currentView = view;
        updateView();
        $('#main-scroll').scrollTop = 0;
    }
    function applyLauncherPos() {
        if (!launcher) return;
        LAUNCHER_POSITIONS.forEach(pos => launcher.classList.toggle('pos-' + pos, pos === launcherPos));
    }
    function open() { panel.hidden = false; $('#backdrop').hidden = false; launcher.hidden = true; $('#close').focus(); }
    function close() { panel.hidden = true; $('#backdrop').hidden = true; launcher.hidden = false; launcher.focus(); }

    function buildUI() {
        host = document.createElement('div'); host.id = 'eaglewing-oc-item-audit';
        root = host.attachShadow({ mode: 'open' }); document.body.append(host);
        root.innerHTML = `<style>
:host { all: initial; color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif; font-size: 13px; color: #e9eef7; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select { font: inherit; }
button { cursor: pointer; transition: background .16s, color .16s, border-color .16s, transform .16s; }
button:disabled { opacity: .45; cursor: not-allowed; transform: none !important; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid #ff7b84; outline-offset: 2px; }
button, select { -webkit-tap-highlight-color: transparent; }
#launcher { position: fixed; right: 22px; bottom: 74px; z-index: 2147483646; display: flex; align-items: center; gap: 10px; padding: 10px 15px 10px 10px; color: #fff; font-size: 12px; font-weight: 750; letter-spacing: .015em; background: #a52a3c; border: 1px solid #eb6878; border-radius: 14px; box-shadow: 0 12px 38px #0009, 0 0 0 3px #9e203a18; }
#launcher:hover { background: #bc354a; transform: translateY(-2px); }
#launcher.pos-bottom-left { right: auto; left: 22px; }
#launcher.pos-middle-right { bottom: auto; top: 50%; transform: translateY(-50%); }
#launcher.pos-middle-right:hover { transform: translateY(calc(-50% - 2px)); }
.launcher-mark, .brand-mark { display: inline-grid; place-items: center; flex-shrink: 0; background: linear-gradient(145deg,#fc6678,#9b2037); color: #fff; font-weight: 850; letter-spacing: -.06em; border: 1px solid #ffffff20; }
.launcher-mark { width: 28px; height: 28px; border-radius: 9px; background: #ffffff1d; }
#backdrop { position: fixed; inset: 0; z-index: 2147483645; background: #03060bc9; backdrop-filter: blur(5px); }
#panel { position: fixed; z-index: 2147483647; left: 50%; top: 50%; transform: translate(-50%,-50%); width: min(1490px, calc(100vw - 44px)); height: min(94vh, 1020px); display: flex; flex-direction: column; overflow: hidden; background: #10151e; border: 1px solid #344050; border-radius: 17px; box-shadow: 0 25px 90px #000d, 0 0 0 1px #ffffff08; }
#panel::before { content: ''; height: 3px; width: 100%; flex-shrink: 0; background: linear-gradient(90deg,#f46b76,#ae2c45 48%,#342635); }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 70px; padding: 12px 22px; background: #151c26; border-bottom: 1px solid #2b3543; }
.brand { display: flex; align-items: center; gap: 12px; }
.brand-mark { width: 39px; height: 39px; border-radius: 11px; font-size: 14px; }
.brand-name { font-size: 15px; font-weight: 790; letter-spacing: -.025em; }
.brand-sub { margin-top: 2px; font-size: 11px; color: #94a2b5; }
.topbar-actions { display:flex; align-items:center; gap: 11px; }
.version-label { padding: 5px 9px; font-size: 11px; font-weight: 650; color: #aebcce; border: 1px solid #303c4d; border-radius: 7px; }
.icon-close { width: 34px; height: 34px; display: grid; place-items: center; background: #222c39; color: #c2cbd7; border: 1px solid #364457; border-radius: 9px; font-size: 22px; line-height: 1; }
.icon-close:hover { background: #343f4e; color: #fff; }
.shell { min-height: 0; flex: 1; display: grid; grid-template-columns: 219px minmax(0,1fr); }
.sidebar { display: flex; flex-direction: column; min-height: 0; padding: 22px 12px 17px; background: #131923; border-right: 1px solid #2b3542; }
.nav-eyebrow { padding: 0 13px 12px; color: #79899e; font-size: 10px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; }
.nav-item { display:flex; align-items:center; width:100%; gap: 12px; padding: 12px 14px; margin: 2px 0; background: transparent; color: #aab6c6; border: 1px solid transparent; border-radius: 10px; text-align: left; font-size: 13px; font-weight: 640; }
.nav-item svg { width: 17px; height: 17px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.nav-item:hover:not(:disabled) { color:#f2f5fa; background:#242e3c; }
.nav-item.is-active { color: #fff; background: linear-gradient(95deg,#81283b66,#51233525); border-color: #a743554f; }
.nav-item.is-active svg { color:#ff7587; }
.nav-rule { margin: 17px 12px; border-top: 1px solid #2a3442; }
.nav-bottom { margin-top: auto; padding: 16px 11px 0; border-top: 1px solid #2a3442; }
.connection-label { display: flex; align-items: center; gap: 8px; color: #9eacbe; font-size: 11px; }
.connection-dot { width: 7px; height: 7px; border-radius: 50%; background: #7c8594; box-shadow: 0 0 0 3px #7c85941b; }
.connection-dot.connected { background: #61cc9b; box-shadow:0 0 0 3px #61cc9b1b; }
.author { margin-top: 11px; color: #6e7e92; font-size: 10px; line-height: 1.6; }
.main { min-width:0; min-height:0; display:flex; flex-direction:column; overflow-y:auto; overscroll-behavior:contain; scrollbar-color: #485567 transparent; scrollbar-width: thin; }
.main-inner { width:100%; max-width: 1380px; margin: 0 auto; padding: 26px clamp(18px,3vw,38px) 36px; }
.workspace-head { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
.eyebrow { color:#f07887; font-size:10px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; margin-bottom:6px; }
h1, h2, h3, p { margin-top: 0; }
h1 { font-size: clamp(22px,2.3vw,29px); letter-spacing: -.04em; line-height:1.16; margin-bottom: 7px; font-weight: 790; }
h2 { font-size: 16px; letter-spacing:-.015em; margin: 0; font-weight: 740; }
h3 { font-size: 13px; letter-spacing:-.01em; margin: 0; }
.subtitle { color: #8e9eaf; font-size:12px; line-height:1.6; margin:0; }
.report-state { display: inline-flex; align-items:center; gap:7px; white-space:nowrap; border: 1px solid #364153; background: #1d2633; border-radius: 30px; padding: 8px 12px; font-size: 11px; color: #afbdce; font-weight: 720; }
.report-state::before { content:''; width:6px; height:6px; background:#8795a5; border-radius:50%; }
.report-state.ready { color: #8ee1bb; border-color: #2e644d; background: #173328; }
.report-state.ready::before { background: #72dba8; }
.report-state.partial { color: #ffd297; border-color: #705237; background:#36271d; }
.report-state.partial::before { background:#fbbf76; }
.section-card { border:1px solid #303c4b; border-radius:12px; background:#171f2b; box-shadow: 0 4px 16px #0208121f; }
.report-builder { padding:16px 18px; margin-bottom: 12px; }
.toolbar { display:flex; align-items:end; justify-content:space-between; gap:14px; flex-wrap:wrap; }
.toolbar-primary { display:flex; align-items:end; flex-wrap:wrap; gap:12px; }
.field { display:flex; flex-direction:column; gap:6px; min-width:0; }
.field-label { color:#99a9bb; font-size:10px; font-weight:750; text-transform: uppercase; letter-spacing:.065em; }
.presets { display: flex; gap:5px; padding:4px; background:#101722; border:1px solid #323e4e; border-radius:9px; }
.preset { padding:9px 12px; background:transparent; color:#9cabbc; border:1px solid transparent; border-radius:6px; white-space:nowrap; font-size:11px; font-weight:730; }
.preset:hover:not(:disabled) { color:#fff; background:#253244; }
.preset.is-selected { color:#fff; background:#363f50; border-color:#4d5b71; box-shadow:0 1px 4px #0004; }
input, select { background:#101722; color:#edf2fb; border:1px solid #374457; border-radius:8px; padding:10px 11px; min-width:0; outline:none; }
input:hover, select:hover { border-color:#586a82; }
input[type=date] { width: 146px; min-height: 38px; color-scheme:dark; }
input[type=password] { width:min(390px,100%); }
input[type=checkbox] { accent-color:#d64b5f; width:15px; height:15px; margin:0; }
select { max-width: 280px; }
.btn { display:inline-flex; justify-content:center; align-items:center; gap:8px; padding:10px 13px; color:#d4dfea; background:#263141; border:1px solid #3c4d61; border-radius:8px; font-size:12px; font-weight:710; line-height:1.25; white-space:nowrap; }
.btn:hover:not(:disabled) { background:#354456; border-color:#66758a; color:#fff; }
.btn-primary { background:#bb344b; color:#fff; border-color:#dd5266; box-shadow:inset 0 1px 0 #ffffff14; }
.btn-primary:hover:not(:disabled) { background:#d04258; border-color:#f16d7f; }
.btn-outline { background:transparent; color:#b8c5d4; }
.btn-danger { color:#ffb9c1; border-color:#7d3f4d; background:#3b2530; }
.btn-danger:hover:not(:disabled) { background:#57303c; }
.btn-big { min-height:38px; }
.toolbar-caption { font-size:11px; color:#7d90a4; margin:11px 0 0; line-height:1.5; }
.filter-strip { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin: 0 0 12px; padding: 12px 15px; }
.filter-set, .export-set { display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.filter-set .field { flex-direction:row; align-items:center; gap:8px; }
.filter-set .field-label { white-space:nowrap; }
.filter-set select { padding:8px 28px 8px 11px; font-size:12px; }
.exports-label { color:#8e9eb1; font-size:10px; text-transform:uppercase; font-weight:740; letter-spacing:.09em; }
.export-set .btn { padding:8px 10px; font-size:11px; }
.status-bar { display:flex; align-items:flex-start; gap:10px; margin-bottom: 20px; padding: 11px 14px; background:#1b2533; border:1px solid #344356; border-radius:9px; color:#aab9ce; font-size:11px; line-height:1.6; }
.status-icon { display:inline-grid; place-items:center; width:17px; height:17px; flex-shrink:0; border-radius:50%; background:#334a64; color:#a9d2ff; font-size:11px; font-weight:900; }
.status-bar.bad { color:#ffb6b9; background:#351f2b; border-color:#7d3d49; }
.status-bar.bad .status-icon { background:#7b3142; color:#ffdee1; }
.section-heading { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin:2px 0 14px; }
.section-caption { margin:5px 0 0; color:#8899ad; font-size:11px; }
.section-tag { color:#aab8cb; padding:6px 10px; border-radius:7px; border:1px solid #344154; font-size:11px; font-weight:650; }
#heading { font-size:16px; font-weight:730; color:#eaf0f9; margin:0; }
#heading.bad { color:#ffb6ab; }
#period { margin: 6px 0 0; color:#899caf; font-size:11px; line-height:1.6; }
#summary { display:grid; grid-template-columns: repeat(5,minmax(0,1fr)); gap:11px; margin: 17px 0 20px; }
.metric { padding:16px; min-width:0; border:1px solid #354153; border-radius:11px; background:linear-gradient(160deg,#222d3b,#1b2431); }
.metric span { display:block; color:#9cacbe; font-size:11px; font-weight:630; line-height:1.5; }
.metric strong { display:block; color:#f7f9fe; font-size:clamp(16px,1.7vw,23px); font-weight:760; margin-top:8px; letter-spacing:-.04em; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.metric:nth-child(4) { background:linear-gradient(160deg,#382832,#25212e); border-color:#684152; }
.metric:nth-child(4) strong { color:#ffcad1; }
.metric small { display:block; color:#8194ab; font-size:10px; font-weight:500; margin-top:5px; line-height:1.45; }
.warning-box { white-space:pre-line; padding:13px 15px 13px 18px; margin: 0 0 17px; color:#ffd5a6; background:#33291e; border:1px solid #715537; border-left:3px solid #e8a966; border-radius:9px; font-size:11px; line-height:1.75; }
.overview-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; }
.info-card { padding:20px; min-width:0; }
.info-card h2 { margin-bottom:11px; }
.info-card p { margin-bottom:12px; color:#97a7b9; font-size:12px; line-height:1.8; }
.inline-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:17px; }
.info-card .btn { font-size:11px; }
.muted { color:#8394a7; }
.ownership-bar { display:flex; overflow:hidden; border-radius:9px; height:11px; background:#354252; margin:17px 0; }
.ownership-bar > span { height:100%; min-width:0; }
.ownership-faction { background:#e46678; }
.ownership-member { background:#728ddc; }
.ownership-unknown { background:#7a8796; }
.ownership-legend { display:grid; gap:10px; }
.legend-row { display:flex; justify-content:space-between; gap:10px; color:#9dacc0; font-size:12px; }
.legend-row strong { color:#ecf1fa; font-variant-numeric:tabular-nums; }
.legend-name { display:flex; align-items:center; gap:8px; }
.legend-dot { width:8px; height:8px; border-radius:3px; flex-shrink:0; }
.note { color:#94a4b8; font-size:11px; line-height:1.75; }
#price-note { margin:17px 0 0; padding:13px 15px; background:#141d29; border:1px solid #303e4e; border-radius:9px; }
.table-card { overflow:hidden; }
.table-intro { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:17px 19px; gap:10px; border-bottom:1px solid #303c4b; }
.table-intro h2 { margin-bottom:5px; }
.table-intro p { margin:0; color:#8fa0b2; font-size:11px; }
.table-scroll { max-height: min(56vh,590px); overflow:auto; scrollbar-width:thin; scrollbar-color:#4c596c transparent; }
table { width:100%; border-collapse:separate; border-spacing:0; font-size:12px; font-variant-numeric: tabular-nums; }
th { position:sticky; top:0; z-index:1; background:#212b39; border-bottom:1px solid #3c4b5e; color:#9eafc1; font-weight:730; font-size:10px; letter-spacing:.04em; text-align:left; white-space:nowrap; padding:13px 15px; }
td { padding:13px 15px; background:#171f2b; border-bottom:1px solid #2a3543; color:#cbd5e2; vertical-align:middle; line-height:1.5; }
tbody tr:hover td { background:#202b3a; }
tbody tr:last-child td { border-bottom:0; }
.t-right { text-align:right; }
.t-center { text-align:center; }
.primary-cell { display:block; font-weight:700; color:#f1f5fa; font-size:12px; }
.secondary-cell { display:block; margin-top:4px; color:#8194aa; font-size:10px; font-weight:520; }
.value-strong { color:#f0f3f9; font-weight:740; }
.value-accent { color:#ffc6ce; font-weight:750; }
.value-lost { color:#f68a97; font-weight:750; }
.value-used { color:#f0c37f; font-weight:720; }
.pill { display:inline-flex; align-items:center; justify-content:center; padding:4px 8px; border-radius:6px; font-size:10px; font-weight:720; white-space:nowrap; }
.pill-lost { background:#5b2c3a; color:#ffc0ca; }
.pill-consumed { background:#4d3a24; color:#f6d199; }
.pill-faction { background:#4b2b39; color:#f2b2c0; }
.pill-user { background:#263b5d; color:#b7d5ff; }
.pill-unknown { background:#33404b; color:#bdc7d1; }
.sort-col { cursor:pointer; user-select:none; }
.sort-col:hover { color:#fff; background:#2c394a; }
.sort-arrow { opacity:.5; padding-left:4px; font-size:10px; }
.sort-col[aria-sort=ascending] .sort-arrow, .sort-col[aria-sort=descending] .sort-arrow { opacity:1; color:#fb7b8e; }
.empty-row { padding:35px 18px; color:#91a2b5; text-align:center !important; }
.table-foot { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; border-top:1px solid #303b49; padding:13px 18px; color:#8b9caf; font-size:11px; }
.pager { display:flex; align-items:center; gap:9px; }
.pager .btn { padding:7px 11px; font-size:11px; }
.settings-grid { display:grid; gap:14px; }
.settings-card { padding:20px; }
.settings-card h2 { margin-bottom:7px; }
.settings-card p { color:#92a5ba; font-size:12px; line-height:1.8; margin:0 0 15px; }
.settings-card .row { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:12px 0 0; }
.settings-card a { color:#ff9aa6; font-size:12px; text-underline-offset:3px; }
.checkbox-label { display:flex; align-items:center; gap:9px; color:#d9e1eb; font-size:12px; }
.settings-subheading { color:#dce6f3; font-weight:720; margin-top:19px; font-size:12px; }
.empty-state { padding:65px 24px; text-align:center; border:1px dashed #405064; border-radius:12px; background:radial-gradient(ellipse at top,#2931418c,#151e2b 65%); }
.empty-symbol { display:inline-grid; place-items:center; width:58px; height:58px; margin-bottom:18px; color:#ff9caa; font-size:25px; font-weight:850; border-radius:17px; border:1px solid #894355; background:#572c3b; }
.empty-state h2 { font-size:19px; margin-bottom:8px; }
.empty-state p { max-width:470px; margin: 0 auto; color:#91a1b5; font-size:12px; line-height:1.9; }
.footer-copy { margin-top:23px; color:#6a7e92; font-size:10px; }
@media (max-width: 1190px) { #summary { grid-template-columns:repeat(3,minmax(0,1fr)); } .toolbar { align-items:stretch; } }
@media (max-width: 820px) { #panel { width:calc(100vw - 12px); height:calc(100dvh - 12px); border-radius:12px; } .shell { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } .sidebar { flex-direction:row; align-items:center; gap:4px; overflow-x:auto; padding:7px 10px; border-right:0; border-bottom:1px solid #344052; } .sidebar .nav-eyebrow,.sidebar .nav-rule,.sidebar .nav-bottom { display:none; } .nav-item { width:auto; min-width:max-content; padding:9px 11px; margin:0; gap:7px; } .nav-item svg { width:15px; height:15px; } .main-inner { padding:19px 15px 28px; } #summary { grid-template-columns:repeat(2,minmax(0,1fr)); } .overview-grid { grid-template-columns:1fr; } .table-scroll { max-height:45vh; } }
@media (max-width: 530px) { .topbar { padding:11px 13px; min-height:62px; } .brand-mark { width:33px; height:33px; } .brand-name { font-size:13px; } .version-label { display:none; } .sidebar { gap:1px; padding:7px 6px; justify-content:space-between; } .nav-item { font-size:10px; gap:4px; padding:9px 6px; } .nav-item svg { width:13px; height:13px; } .toolbar-primary:first-child { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:10px; width:100%; } .toolbar-primary:first-child > .field:first-child { grid-column:1/-1; } .toolbar-primary:first-child > .field { width:100%; min-width:0; } .toolbar-primary:last-child { width:100%; } .toolbar-primary:last-child .btn { width:100%; } input[type=date] { width:100%; } .presets { width:100%; } .presets .preset { flex:1; } .report-builder { padding:13px; } .metric { padding:12px; } .metric strong { font-size:20px; } .filter-strip { padding:11px; } .filter-set { width:100%; } .filter-set .field { width:100%; justify-content:space-between; } .filter-set select { flex:1; width:50%; max-width:none; } #summary { gap:7px; } .settings-card { padding:15px; } .settings-card input[type=password] { width:100%; } }
@media (prefers-reduced-motion:reduce) { button { transition:none; } }
</style>
<button id="launcher" aria-label="Open OC Item Audit"><span class="launcher-mark">OC</span> Item Audit</button>
<div id="backdrop" hidden></div>
<section id="panel" hidden aria-label="OC Item Audit" role="dialog" aria-modal="true">
 <div class="topbar"><div class="brand"><span class="brand-mark">OC</span><div><div class="brand-name">OC Item Audit</div><div class="brand-sub">Faction intelligence · Torn</div></div></div><div class="topbar-actions"><span class="version-label">v${VERSION}</span><button id="close" class="icon-close" aria-label="Close tracker" title="Close tracker">×</button></div></div>
 <div class="shell">
  <aside class="sidebar" aria-label="Audit navigation">
   <div class="nav-eyebrow">Workspace</div>
   <button class="nav-item is-active" data-view="overview" aria-current="page"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/></svg>Overview</button>
   <button class="nav-item" data-view="costs" disabled><svg viewBox="0 0 24 24"><path d="M3 7h18M3 12h18M3 17h18M7 4v16M17 4v16"/></svg>Item costs</button>
   <button class="nav-item" data-view="activity" disabled><svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>Activity log</button>
   <div class="nav-rule"></div>
   <button class="nav-item" data-view="settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a2 2 0 0 0 .4 2.2l-2.6 2.6a2 2 0 0 0-2.2-.4l-1.2.5-.5 2h-3.6l-.5-2L8 19.4a2 2 0 0 0-2.2.4l-2.6-2.6A2 2 0 0 0 3.6 15L3 13.8l-2-.5V9.7l2-.5L3.6 8a2 2 0 0 0-.4-2.2l2.6-2.6A2 2 0 0 0 8 3.6L9.2 3l.5-2h3.6l.5 2 1.2.6a2 2 0 0 0 2.2-.4l2.6 2.6a2 2 0 0 0-.4 2.2l.5 1.2 2 .5v3.6l-2 .5z" transform="translate(1 1) scale(.92)"/></svg>Settings</button>
   <div class="nav-bottom"><div class="connection-label"><span id="connection-dot" class="connection-dot"></span><span id="connection-text">No API key saved</span></div><div class="author">Created by Eaglewing [571041]<div>Read-only API requests · v${VERSION}</div></div></div>
  </aside>
  <main class="main" id="main-scroll"><div class="main-inner">
   <div class="workspace-head"><div><div class="eyebrow">Organized crime analytics</div><h1 id="view-title">Report overview</h1><p id="view-subtitle" class="subtitle">Understand OC item usage, losses, and estimated replacement costs.</p></div><span id="report-state" class="report-state">No report loaded</span></div>
   <div id="report-controls">
    <section class="report-builder section-card" aria-label="Report period"><div class="toolbar"><div class="toolbar-primary">
     <div class="field"><span class="field-label">Quick range</span><div class="presets"><button class="preset" data-days="7" data-lock>7 days</button><button class="preset" data-days="14" data-lock>14 days</button><button class="preset is-selected" data-days="30" data-lock>30 days</button></div></div>
     <label class="field"><span class="field-label">From (TCT)</span><input id="from" type="date" min="2025-01-15" data-lock></label>
     <label class="field"><span class="field-label">To (TCT)</span><input id="to" type="date" min="2025-01-15" data-lock></label>
    </div><div class="toolbar-primary"><button id="fetch" class="btn btn-primary btn-big" data-lock>Fetch report <span aria-hidden="true">↗</span></button><button id="cancel" class="btn btn-danger btn-big" hidden>Cancel fetch</button></div></div>
    <p class="toolbar-caption">UTC / Torn City Time · Presets include today · Each fetch reads the selected period afresh.</p>
    </section>
    <section class="filter-strip section-card" aria-label="Data filters and exports"><div class="filter-set"><label class="field"><span class="field-label">Item owner</span><select id="owner"><option value="all">All owners</option><option value="faction">Faction-owned</option><option value="user">Member-owned</option><option value="unknown">Unknown owner</option></select></label><label class="field"><span class="field-label">Crime type</span><select id="crime"><option value="all">All crimes</option></select></label></div>
    <div class="export-set" id="exports" hidden><span class="exports-label">Export</span><button id="export-summary" class="btn btn-outline" title="Export item cost totals">Items CSV</button><button id="export-details" class="btn btn-outline" title="Export slot-level details">Details CSV</button></div></section>
   </div>
   <div id="status" class="status-bar" role="status" aria-live="polite"><span class="status-icon" aria-hidden="true">i</span><span id="status-text">Save your API key, choose a date range, and fetch your first report.</span></div>
   <section id="overview-view" data-view-panel="overview">
    <div id="empty" class="empty-state"><div class="empty-symbol">OC</div><h2>Your report is ready to build</h2><p>Select a period above and choose <strong>Fetch report</strong> to review every completed OC, item losses, consumption, ownership and estimated market costs.</p><div class="footer-copy">No automated actions · Read-only Torn API access</div></div>
    <div id="report-body" hidden><div class="section-heading"><div><h2 id="heading"></h2><p id="period"></p></div><span class="section-tag">Calculated from OC outcomes</span></div>
     <div id="warnings" class="warning-box" hidden></div>
     <div id="summary"></div>
     <div class="overview-grid"><section class="info-card section-card"><h2>Ownership breakdown</h2><p>Lost and consumed items by recorded ownership. This represents item events, not the number of crimes.</p><div id="ownership"></div></section>
      <section class="info-card section-card"><h2>Explore the report</h2><p>See item-level quantities, current price estimates and faction costs, or inspect the individual OC slots behind every loss and consumption event.</p><div class="inline-actions"><button class="btn btn-primary" data-jump="costs">View item costs <span aria-hidden="true">→</span></button><button class="btn" data-jump="activity">View activity log <span aria-hidden="true">→</span></button></div></section></div>
     <p id="price-note" class="note"></p></div>
   </section>
   <section id="costs-view" data-view-panel="costs" hidden><div class="table-card section-card"><div class="table-intro"><div><h2>Item cost breakdown</h2><p>Sort any column to compare depleted items, prices and replacement cost.</p></div><span class="section-tag" id="item-count">0 item types</span></div><div class="table-scroll"><table aria-label="Item cost breakdown"><thead><tr>
    <th class="sort-col" data-sort="name" aria-sort="none" tabindex="0">Item <span class="sort-arrow">↕</span></th><th class="sort-col t-right" data-sort="lost" aria-sort="none" tabindex="0">Lost <span class="sort-arrow">↕</span></th><th class="sort-col t-right" data-sort="consumed" aria-sort="none" tabindex="0">Consumed <span class="sort-arrow">↕</span></th><th class="sort-col t-right" data-sort="price" aria-sort="none" tabindex="0">Unit value <span class="sort-arrow">↕</span></th><th class="sort-col t-right" data-sort="cost" aria-sort="descending" tabindex="0">Total cost <span class="sort-arrow">↓</span></th><th class="sort-col t-right" data-sort="factionCost" aria-sort="none" tabindex="0">Faction cost <span class="sort-arrow">↕</span></th><th class="sort-col t-right" data-sort="crimes" aria-sort="none" tabindex="0">OCs <span class="sort-arrow">↕</span></th>
    </tr></thead><tbody id="items"></tbody></table></div><div class="table-foot">Unit prices are current estimates, not historical purchase prices.</div></div></section>
   <section id="activity-view" data-view-panel="activity" hidden><div class="table-card section-card"><div class="table-intro"><div><h2>OC item activity</h2><p>Every recorded loss or non-reusable item consumption, grouped by individual slot.</p></div><span class="section-tag">100 records / page</span></div><div class="table-scroll"><table aria-label="OC item activity"><thead><tr><th>Executed (TCT)</th><th>Organized crime</th><th>Slot / member</th><th>Item</th><th>Event</th><th>Owner</th><th>Notes</th></tr></thead><tbody id="details-body"></tbody></table></div><div class="table-foot"><span id="detail-count">0 records</span><div class="pager"><button id="prev" class="btn btn-outline">← Previous</button><button id="next" class="btn btn-outline">Next →</button></div></div></div></section>
   <section id="settings" data-view-panel="settings" hidden><div class="settings-grid"><div class="settings-card section-card"><div class="eyebrow">Connection</div><h2>Torn API key</h2><p>Use your own key with <strong>faction/crimes</strong>, <strong>faction/basic</strong> and <strong>torn/items</strong> permissions. Faction access depends on your position. Your key is saved locally in your userscript manager (not in this script or on GitHub). It is not encrypted by this script, and is sent only to api.torn.com over HTTPS in the Authorization header. Use Remove key to clear it.</p><div class="row"><input id="key" type="password" autocomplete="off" spellcheck="false" placeholder="Enter your 16-character Torn API key" aria-label="Torn API key" data-lock><button id="save-key" class="btn btn-primary" data-lock>Save key</button><button id="forget-key" class="btn btn-danger" data-lock>Remove key</button><a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener noreferrer">Create a key ↗</a></div></div>
    <div class="settings-card section-card"><div class="eyebrow">Display</div><h2>Launcher position</h2><p>Move the OC Item Audit button if it covers Torn's chat or other buttons on your screen.</p><div class="row"><select id="launcher-pos" aria-label="Launcher position"><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="middle-right">Middle right</option></select></div></div>
    <div class="settings-card section-card"><div class="eyebrow">Valuation</div><h2>Item prices & TornTools</h2><p>Torn API market values are used by default. You can import item unit prices currently visible on the Items page through TornTools; those values are preferred when enabled. The tracker cannot access TornTools' private extension storage.</p><label class="checkbox-label"><input id="prefer-tt" type="checkbox" checked data-lock>Prefer imported TornTools unit prices</label><div class="settings-subheading">Price management</div><div class="row"><button id="import-tt" class="btn" data-lock>Import visible prices</button><button id="reload-tt" class="btn" data-lock>Reload imported prices</button><button id="refresh-prices" class="btn" data-lock>Refresh API prices</button><button id="clear-prices" class="btn btn-danger" data-lock>Clear price cache</button></div><p class="note" style="margin-top:13px">To import TornTools prices, open the Items page, select an inventory category with visible unit values, then use Import visible prices here. Each category must be imported separately. Imported and API price data expire after 6 hours.</p></div>
    <div class="settings-card section-card"><div class="eyebrow">Methodology</div><h2>How costs are calculated</h2><p>Only Torn's explicit <strong>lost</strong> outcomes and <strong>used</strong> outcomes for non-reusable item requirements count as depleted items. Unused items and reusable items do not contribute to the estimates. The total OC count still includes completed crimes without item losses.</p><p style="margin:0">Historical OC data is fetched through sequential, read-only API requests. Owner and crime filters change the item records and costs, but not the completed OC count.</p></div></div></section>
  </div></main>
 </div>
</section>`;
        panel = $('#panel'); launcher = $('#launcher');
        launcher.addEventListener('click', open);
        $('#close').addEventListener('click', close);
        $('#backdrop').addEventListener('click', close);
        root.addEventListener('keydown', e => {
            if (panel.hidden) return;
            if (e.key === 'Escape') return close();
            if (e.key !== 'Tab') return;
            // Keep keyboard focus inside the open dialog.
            const focusable = [...panel.querySelectorAll('button, input, select, a[href], [tabindex]:not([tabindex="-1"])')]
                .filter(el => !el.disabled && el.getClientRects().length);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1], active = root.activeElement;
            if (e.shiftKey && (active === first || !panel.contains(active))) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && (active === last || !panel.contains(active))) { e.preventDefault(); first.focus(); }
        });
        root.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => showView(el.dataset.view)));
        root.querySelectorAll('[data-jump]').forEach(el => el.addEventListener('click', () => showView(el.dataset.jump)));
        $('#fetch').addEventListener('click', runReport);
        $('#cancel').addEventListener('click', () => controller?.abort());
        root.querySelectorAll('[data-days]').forEach(el => el.addEventListener('click', () => preset(Number(el.dataset.days))));
        for (const selector of ['#owner', '#crime']) $(selector).addEventListener('change', () => { detailPage = 0; render(); });
        for (const selector of ['#from', '#to']) $(selector).addEventListener('change', () => setSelectedPreset(null));
        root.querySelectorAll('[data-sort]').forEach(th => {
            const selectSort = () => {
                if (sortBy === th.dataset.sort) sortDirection *= -1;
                else { sortBy = th.dataset.sort; sortDirection = sortBy === 'name' ? 1 : -1; }
                render();
            };
            th.addEventListener('click', selectSort);
            th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSort(); } });
        });
        $('#save-key').addEventListener('click', async () => {
            const next = $('#key').value.trim();
            if (!/^[a-zA-Z0-9]{16}$/.test(next)) return message('Enter a valid 16-character Torn API key.', true);
            try { await save('key', next); key = next; report = null; render(); updateConnection(); message('Key saved. Fetch a report to verify faction access.'); showView('overview'); }
            catch (_) { message('Could not save the API key.', true); }
        });
        $('#forget-key').addEventListener('click', async () => {
            try { await save('key', ''); key = ''; $('#key').value = ''; report = null; render(); updateConnection(); message('API key removed.'); }
            catch (_) { message('Could not remove the API key.', true); }
        });
        $('#launcher-pos').addEventListener('change', async () => {
            launcherPos = LAUNCHER_POSITIONS.includes($('#launcher-pos').value) ? $('#launcher-pos').value : 'bottom-right';
            applyLauncherPos();
            try { await save('launcherPos', launcherPos); message('Launcher position saved.'); }
            catch (_) { message('Could not save launcher position.', true); }
        });
        $('#prefer-tt').addEventListener('change', async () => {
            preferTT = $('#prefer-tt').checked;
            try { await save('preferTT', preferTT); render(); } catch (_) { message('Could not save price preference.', true); }
        });
        $('#import-tt').addEventListener('click', () => importTTPrices().catch(() => message('Could not save TornTools prices.', true)));
        $('#reload-tt').addEventListener('click', async () => { ttPrices = await read('ttPrices', {}); render(); message('Imported price cache reloaded.'); });
        $('#clear-prices').addEventListener('click', async () => {
            try { await save('catalog', { at: 0, items: {} }); await save('ttPrices', {}); catalog = { at: 0, items: {} }; ttPrices = {}; render(); message('Price cache cleared. Refresh API prices to refill it.'); }
            catch (_) { message('Could not clear all price data.', true); }
        });
        $('#refresh-prices').addEventListener('click', async () => {
            if (busy) return;
            if (!key) return message('Save a Torn API key first.', true);
            controller = new AbortController(); setBusy(true); message('Refreshing Torn API prices…');
            try { await loadPrices(true, controller.signal); if (report) report.priceWarning = ''; message('API market values refreshed.'); }
            catch (error) { message(safeError(error), true); }
            finally { controller = null; setBusy(false); render(); }
        });
        $('#prev').addEventListener('click', () => { detailPage--; render(); });
        $('#next').addEventListener('click', () => { detailPage++; render(); });
        $('#export-summary').addEventListener('click', exportSummary); $('#export-details').addEventListener('click', exportDetails);
        preset(30); $('#key').value = key; $('#prefer-tt').checked = preferTT;
        $('#launcher-pos').value = launcherPos; applyLauncherPos();
        updateConnection(); showView(key ? 'overview' : 'settings');
        if (location.pathname === '/item.php') message('TornTools import: open an inventory category, then choose Import visible prices in Settings.');
        if (typeof GM.registerMenuCommand === 'function') GM.registerMenuCommand('Open OC Item Audit', open);
    }
    async function init() {
        key = await read('key', ''); if (typeof key !== 'string') key = '';
        catalog = await read('catalog', { at: 0, items: {} });
        if (!catalog || typeof catalog.items !== 'object' || !catalog.items || typeof catalog.at !== 'number') catalog = { at: 0, items: {} };
        ttPrices = await read('ttPrices', {}); if (!ttPrices || typeof ttPrices !== 'object') ttPrices = {};
        preferTT = (await read('preferTT', true)) === true;
        const pos = await read('launcherPos', 'bottom-right');
        launcherPos = LAUNCHER_POSITIONS.includes(pos) ? pos : 'bottom-right';
        buildUI();
    }
    init().catch(() => console.error('[OC Item Audit] Could not initialize. Check userscript permissions.'));
})();

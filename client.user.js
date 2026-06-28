// ==UserScript==
// @name         AnimeSSS Cards Server Client
// @namespace    https://animesss.tv/
// @version      0.1.0
// @description  Shows server-side card authorship badges and suggestion cards.
// @author       Codex
// @match        https://animesss.tv/*
// @match        https://animesss.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      your-render-app.onrender.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://your-render-app.onrender.com';
    const CACHE_KEY = 'aca_server_client_cache_v1';
    const HOUR_MS = 60 * 60 * 1000;
    const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
    const RANKS = ['', 'sss', 'ass', 's', 'a', 'b', 'c', 'd', 'e'];

    function now() { return Date.now(); }
    function currentHourKey() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + '-' + String(d.getHours()).padStart(2, '0');
    }
    function loadCache() {
        const value = GM_getValue(CACHE_KEY, {});
        return value && typeof value === 'object' ? value : {};
    }
    function saveCache(cache) {
        GM_setValue(CACHE_KEY, cache);
    }
    function apiGet(path) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: API_BASE + path,
                timeout: 30000,
                onload: response => {
                    try {
                        resolve(JSON.parse(response.responseText || '{}'));
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: () => reject(new Error('network error')),
                ontimeout: () => reject(new Error('timeout'))
            });
        });
    }
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
    }
    function abs(url) {
        try { return new URL(url, location.origin).toString(); } catch { return String(url || ''); }
    }
    function cardImage(card) {
        const img = card.querySelector('img');
        const value = card.dataset.image || img?.dataset?.src || img?.getAttribute('data-src') || img?.getAttribute('src') || '';
        try { return new URL(value, location.origin).pathname; } catch { return value.split('?')[0]; }
    }
    function replacementKey(item) {
        const cards = [...item.querySelectorAll('.anime-cards__item[data-id]')];
        const oldCard = cards[0];
        const newCard = cards[1] || oldCard;
        if (!oldCard || !newCard) return '';
        return oldCard.dataset.id + '|' + cardImage(newCard);
    }
    function collectCardsPageKeys() {
        const keys = [];
        document.querySelectorAll('.anime-cards-center.anime-cards--full-page[data-suite-vote-block="1"] .anime-cards__item[data-id]')
            .forEach(card => keys.push(card.dataset.id));
        document.querySelectorAll('.card-replace-vote').forEach(item => {
            const key = replacementKey(item);
            if (key) keys.push(key);
        });
        return [...new Set(keys)];
    }
    function isCardsPage() {
        return /^\/cards\/?$/.test(location.pathname);
    }

    function injectStyle() {
        if (document.getElementById('aca-server-style')) return;
        const style = document.createElement('style');
        style.id = 'aca-server-style';
        style.textContent = `
            .aca-srv-button{position:fixed;right:16px;bottom:16px;z-index:99999;border:1px solid #164e63;background:#0e7490;color:#ecfeff;border-radius:8px;padding:8px 10px;font:800 13px Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer}
            .aca-srv-button[data-new]:after{content:attr(data-new);display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;margin-left:6px;padding:0 4px;border-radius:999px;background:#ef4444;color:white;font-size:11px}
            .aca-srv-modal{position:fixed;inset:5vh 4vw;z-index:100000;display:none;flex-direction:column;background:#111;border:1px solid #2d2d2d;border-radius:8px;box-shadow:0 20px 80px rgba(0,0,0,.65);color:#eee;overflow:hidden}
            .aca-srv-modal.is-open{display:flex}
            .aca-srv-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #2d2d2d;background:#171717}
            .aca-srv-title{font:800 16px Arial,sans-serif;margin-right:auto}
            .aca-srv-tabs{display:flex;gap:4px;flex-wrap:wrap}
            .aca-srv-tab,.aca-srv-refresh,.aca-srv-close{border:1px solid #334155;background:#1f2937;color:#e5e7eb;border-radius:6px;min-height:28px;padding:4px 8px;font:800 12px Arial,sans-serif;cursor:pointer}
            .aca-srv-tab.is-active{background:#0891b2;color:#ecfeff;border-color:#22d3ee}
            .aca-srv-meta{font:12px Arial,sans-serif;color:#a3a3a3}
            .aca-srv-grid{padding:12px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
            .aca-srv-card{min-width:0}
            .aca-srv-img{display:block;width:100%;border-radius:6px;border:1px solid #333;background:#181818}
            .aca-srv-author{display:flex;align-items:center;justify-content:center;box-sizing:border-box;margin-top:6px;padding:4px 6px;min-height:24px;border-radius:7px;border:1px solid #1e293b;background:linear-gradient(180deg,#0f274f,#0b1730);color:#eff6ff;font:800 12px/1.25 Arial,sans-serif;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .aca-srv-author a{color:#eff6ff;text-decoration:none;border-bottom:1px solid rgba(239,246,255,.72);overflow:hidden;text-overflow:ellipsis}
            .aca-srv-name{font:700 12px Arial,sans-serif;color:#e5e7eb;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
            .aca-author-badge{display:flex;align-items:center;justify-content:center;box-sizing:border-box;margin:8px auto 0;padding:3px 6px;min-height:24px;max-width:190px;border-radius:7px;border:1px solid #1e293b;background:linear-gradient(180deg,#0f274f,#0b1730);color:#dbeafe;font:800 12px/1.25 Arial,sans-serif;text-align:center;white-space:nowrap;overflow:hidden}
            .aca-author-badge a{color:#eff6ff;text-decoration:none;border-bottom:1px solid rgba(239,246,255,.72)}
        `;
        document.head.appendChild(style);
    }

    function ensureUi() {
        if (document.getElementById('aca-srv-button')) return;
        const button = document.createElement('button');
        button.id = 'aca-srv-button';
        button.className = 'aca-srv-button';
        button.textContent = 'Предложка';
        button.addEventListener('click', () => openModal());
        document.body.appendChild(button);

        const modal = document.createElement('div');
        modal.id = 'aca-srv-modal';
        modal.className = 'aca-srv-modal';
        modal.innerHTML = `
            <div class="aca-srv-head">
                <div class="aca-srv-title">Предложка</div>
                <div class="aca-srv-tabs">${RANKS.map(rank => `<button class="aca-srv-tab" data-rank="${rank}">${rank ? rank.toUpperCase() : 'Все'}</button>`).join('')}</div>
                <button class="aca-srv-refresh">Обновить</button>
                <button class="aca-srv-close">Закрыть</button>
            </div>
            <div class="aca-srv-head"><div class="aca-srv-meta"></div></div>
            <div class="aca-srv-grid"></div>
        `;
        modal.querySelector('.aca-srv-close').addEventListener('click', () => modal.classList.remove('is-open'));
        modal.querySelector('.aca-srv-refresh').addEventListener('click', () => refreshSuggestions(true));
        modal.querySelectorAll('.aca-srv-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const cache = loadCache();
                cache.rank = tab.dataset.rank || '';
                saveCache(cache);
                renderSuggestions();
            });
        });
        document.body.appendChild(modal);
    }

    function openModal() {
        document.getElementById('aca-srv-modal')?.classList.add('is-open');
        renderSuggestions();
        maybeRefreshSuggestions();
    }

    async function maybeRefreshSuggestions() {
        const cache = loadCache();
        if (cache.lastHourKey !== currentHourKey()) {
            await refreshSuggestions(false);
        }
    }

    async function refreshSuggestions(manual) {
        const cache = loadCache();
        if (manual && cache.lastManualRefreshAt && now() - cache.lastManualRefreshAt < MANUAL_REFRESH_COOLDOWN_MS) {
            const left = Math.ceil((MANUAL_REFRESH_COOLDOWN_MS - (now() - cache.lastManualRefreshAt)) / 1000);
            setMeta('Ручное обновление будет доступно через ' + left + ' сек.');
            return;
        }
        setMeta('Обновляю...');
        try {
            const json = await apiGet('/api/suggestions?limit=200');
            const oldIds = new Set((cache.cards || []).map(card => String(card.card_id || card.cardId)));
            const cards = (json.cards || []).sort((a, b) => Number(b.card_id) - Number(a.card_id));
            const unread = cards.filter(card => !oldIds.has(String(card.card_id))).map(card => String(card.card_id));
            cache.cards = cards;
            cache.unreadIds = [...new Set([...(cache.unreadIds || []), ...unread])];
            cache.lastFetchedAt = now();
            cache.lastHourKey = currentHourKey();
            if (manual) cache.lastManualRefreshAt = now();
            saveCache(cache);
            renderSuggestions();
        } catch (error) {
            setMeta('Сервер недоступен, показан кэш: ' + error.message);
        }
    }

    function setMeta(text) {
        const meta = document.querySelector('.aca-srv-meta');
        if (meta) meta.textContent = text;
    }

    function renderSuggestions() {
        const cache = loadCache();
        const rank = cache.rank || '';
        const modal = document.getElementById('aca-srv-modal');
        if (!modal) return;
        modal.querySelectorAll('.aca-srv-tab').forEach(tab => tab.classList.toggle('is-active', (tab.dataset.rank || '') === rank));
        const cards = (cache.cards || [])
            .filter(card => !rank || String(card.rank || '').toLowerCase() === rank)
            .sort((a, b) => Number(b.card_id) - Number(a.card_id));
        const grid = modal.querySelector('.aca-srv-grid');
        grid.innerHTML = cards.map(card => {
            const author = card.author || '';
            return `
                <div class="aca-srv-card" data-card-id="${escapeHtml(card.card_id)}">
                    <img class="aca-srv-img" loading="lazy" src="${escapeHtml(card.image_url || abs(card.image))}" alt="${escapeHtml(card.name || '')}">
                    <div class="aca-srv-author">Автор:&nbsp;<a href="${escapeHtml(abs('/user/' + encodeURIComponent(author) + '/'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(author)}</a></div>
                    <div class="aca-srv-name" title="${escapeHtml(card.name || '')}">${escapeHtml(card.name || '')}</div>
                </div>`;
        }).join('');
        const date = cache.lastFetchedAt ? new Date(cache.lastFetchedAt).toLocaleString() : 'нет данных';
        setMeta(`Карт: ${cards.length}. Обновлено: ${date}`);
        const button = document.getElementById('aca-srv-button');
        const unreadCount = (cache.unreadIds || []).length;
        if (button) {
            if (unreadCount) button.setAttribute('data-new', '+' + unreadCount);
            else button.removeAttribute('data-new');
        }
    }

    function ensureBadge(host, author) {
        if (!host || !author) return;
        let badge = host.querySelector(':scope > .aca-author-badge.aca-server-author');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'aca-author-badge aca-server-author';
            host.appendChild(badge);
        }
        badge.innerHTML = `Автор:&nbsp;<a href="${escapeHtml(abs('/user/' + encodeURIComponent(author) + '/'))}" target="_blank" rel="noopener noreferrer">${escapeHtml(author)}</a>`;
    }

    async function refreshCardsAuthors() {
        if (!isCardsPage()) return;
        const keys = collectCardsPageKeys();
        if (!keys.length) return;
        try {
            const json = await apiGet('/api/results?keys=' + encodeURIComponent(keys.join(',')));
            const byKey = new Map((json.results || []).map(row => [row.task_key, row]));
            document.querySelectorAll('.anime-cards-center.anime-cards--full-page[data-suite-vote-block="1"] .anime-cards__item[data-id]').forEach(card => {
                const result = byKey.get(card.dataset.id);
                if (result?.author) {
                    const host = card.closest('.anime-cards__item-wrapper,.anime-cards__item-wrapper-gl') || card.parentElement;
                    ensureBadge(host, result.author);
                }
            });
            document.querySelectorAll('.card-replace-vote').forEach(item => {
                const result = byKey.get(replacementKey(item));
                if (result?.author) {
                    const compare = item.querySelector('.card-replace-vote__compare,.card-replace-vote__cards');
                    ensureBadge(compare || item, result.author);
                }
            });
        } catch (_) {}
    }

    function boot() {
        injectStyle();
        ensureUi();
        renderSuggestions();
        maybeRefreshSuggestions();
        refreshCardsAuthors();
        setInterval(maybeRefreshSuggestions, HOUR_MS);
        if (isCardsPage()) setInterval(refreshCardsAuthors, 60000);
    }

    boot();
})();

// Проверка онлайн-статуса стримера (Twitch)
function isStreamerOnline() {
    try {
        const host = (location && location.hostname) ? location.hostname.toLowerCase() : '';
        const bodyText = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';

        // Специальная ветка для Kick: ищем бейдж "LIVE" рядом с аватаром или явные тексты оффлайн
        if (host.indexOf('kick.com') !== -1) {
            // Ищем явный бейдж с текстом LIVE (в разных элементах)
            const liveBadge = Array.from(document.querySelectorAll('span,div')).find(el => {
                try {
                    const t = (el.textContent || '').trim().toLowerCase();
                    return t === 'live' || t === 'live!';
                } catch (e) { return false; }
            });
            if (liveBadge) return true;

            // Частный случай: аватар с id 'channel-avatar' и соседний span с LIVE
            const avatar = document.getElementById('channel-avatar');
            if (avatar) {
                const parent = avatar.closest('button,div');
                if (parent) {
                    const span = parent.querySelector('span');
                    if (span && (span.textContent || '').toLowerCase().indexOf('live') !== -1) return true;
                }
            }

            // Если есть блок с сообщением 'Не в сети' на Kick — считаем оффлайн
            if (bodyText.indexOf('не в сети') !== -1 || bodyText.indexOf('not online') !== -1 || bodyText.indexOf('offline') !== -1) {
                return false;
            }

            // Не нашли явный LIVE, по умолчанию считаем оффлайн (чтобы не тратить время на пустые страницы)
            return false;
        }

        // Сначала проверяем явные ОФЛАЙН индикаторы в шапке канала (главная зона, не сайдбар)
        // Ищем элементы с текстом 'Не в сети' или 'offline' в основном контенте (верх страницы)
        const headerArea = document.querySelector('[data-a-target="channel-header-subscribe-button"]') || 
                          document.querySelector('[data-a-target="channel-header"]') ||
                          document.querySelector('[role="main"]') ||
                          document.querySelector('main') ||
                          document.querySelector('[data-test-id="layout-main-content"]');
        
        if (headerArea) {
            const headerText = (headerArea.innerText || '').toLowerCase();
            if (headerText.indexOf('не в сети') !== -1 || headerText.indexOf('offline') !== -1) {
                return false; // Стример офлайн
            }
        }

        // Для Twitch: проверяем наличие видеоплеера с реальным источником
        const videoElement = document.querySelector('video');
        if (videoElement) {
            const src = (videoElement.currentSrc || videoElement.src || '').trim();
            if (src && src.length > 0) {
                return true;
            }
        }

        // Если нет видео и нет явного офлайн-текста в заголовке, но видим 'не в сети' в боковом меню/нижней части
        // это НЕ показатель офлайна стримера (может быть меню категорий)
        // Игнорируем общий bodyText, fokusируемся на элементах рядом с видеоплеером или в шапке

        // Попробуем найти индикатор 'В ЭФИРЕ' рядом с видеоплеером (если плеер есть, но нет src)
        if (videoElement) {
            const playerContainer = videoElement.closest('[data-a-target="player"]') || 
                                   videoElement.closest('[class*="player"]') ||
                                   videoElement.closest('div');
            if (playerContainer) {
                const playerText = (playerContainer.innerText || '').toLowerCase();
                if (playerText.indexOf('в эфире') !== -1 || playerText.indexOf('live') !== -1) {
                    return true;
                }
            }
        }

        // Проверка aria-label статуса в шапке (может быть 'Live', 'Online' и т.д.)
        const nodesWithLabels = document.querySelectorAll('[data-a-target*="status"],[data-a-target*="live"],[aria-label*="live"],[aria-label*="online"]');
        for (let i = 0; i < nodesWithLabels.length; i++) {
            try {
                const el = nodesWithLabels[i];
                const lab = (el.getAttribute('aria-label') || el.getAttribute('data-a-target') || el.textContent || '').toLowerCase();
                if (lab.indexOf('live') !== -1 || lab.indexOf('в эфире') !== -1) return true;
                if (lab.indexOf('offline') !== -1 || lab.indexOf('не в сети') !== -1) return false;
            } catch (e) { /* ignore */ }
        }

        // КРИТИЧНО: если видим видеоплеер БЕЗ источника и нет явного 'В ЭФИРЕ' — считаем ОФФЛАЙН

        // (Twitch добавляет пустой <video> на офлайн-страницы, чтобы зарезервировать место)
        if (videoElement && !videoElement.currentSrc && !videoElement.src) {
            return false; // Пустой видеоплеер = оффлайн
        }

        // По умолчанию считаем онлайн (оптимистично), чтобы не пропускать работающие стримы
        return true;
    } catch (e) {
        console.error('Ошибка при проверке онлайн-статуса:', e);
        return true;
    }
}

// Автоматический запуск видео и предотвращение остановки Twitch Drops
function ensureStreamPlayback() {
    try {
        const isTwitch = location.hostname.includes('twitch.tv');
        const isKick = location.hostname.includes('kick.com');
        if (!isTwitch && !isKick) return;
        if (location.pathname.includes('/drops/inventory')) return;

        const video = document.querySelector('video');
        if (video) {
            // Если видео на паузе — возобновляем воспроизведение
            if (video.paused) {
                video.play().catch(() => {});
            }
            // Внутри HTML5 плеера звук должен быть активен (video.muted = false, volume >= 0.2),
            // иначе Twitch считает просмотр неактивным. Сама вкладка заглушена на уровне браузера.
            if (video.muted) {
                video.muted = false;
            }
            if (typeof video.volume === 'number' && video.volume < 0.2) {
                video.volume = 0.5;
            }
        }

        // Клик по оверлеям "Нажмите, чтобы смотреть" или "Возобновить"
        if (isTwitch) {
            const overlayBtn = document.querySelector('[data-a-target="player-overlay-click-to-unmute"], [data-a-target="content-classification-gate-overlay-start-watching-button"]');
            if (overlayBtn) {
                try { overlayBtn.click(); } catch(e) {}
            }
            const playBtn = document.querySelector('button[data-a-target="player-play-pause-button"][aria-label*="Play"], button[data-a-target="player-play-pause-button"][aria-label*="Воспроизвести"]');
            if (playBtn) {
                try { playBtn.click(); } catch(e) {}
            }
        }
    } catch(e) {}
}

setInterval(ensureStreamPlayback, 12000);
setTimeout(ensureStreamPlayback, 2000);
setTimeout(ensureStreamPlayback, 5000);


function findAndHighlightLink(searchText) {
    try {
    // Убедиться, что стиль подсветки существует
        try {
            if (!document.getElementById('tc-highlight-style')) {
                const style = document.createElement('style');
                style.id = 'tc-highlight-style';
                style.textContent = `
                .tc-highlight {
                    outline: 4px solid rgba(255,0,0,1) !important;
                    box-shadow: 0 0 12px rgba(255,0,0,0.95) !important;
                    transition: box-shadow 0.2s ease-in-out;
                    z-index: 2147483647 !important;
                }
                `;
                (document.head || document.documentElement).appendChild(style);
            }
        } catch (e) {
            // игнорируем ошибки вставки стиля
        }
        // Собираем ссылки: сначала специфичный селектор для Twitch, но если его нет — берем все ссылки на странице
            let links = Array.from(document.querySelectorAll('a[data-a-target="stream-game-link"]'));
            if (!links || links.length === 0) links = Array.from(document.querySelectorAll('a'));
            let foundLink = null;

        // Нормализуем searchText
            const rawNeedle = (typeof searchText === 'string' ? searchText.trim() : '');
            const needle = rawNeedle.toLowerCase();

        // Проверяем, является ли needle абсолютным URL (режим поиска по URL/категории платформы)
            let needleIsAbsoluteUrl = false;
            let needleUrl = null;
            try {
                if (rawNeedle.match(/^https?:\/\//i)) {
                    needleIsAbsoluteUrl = true;
                    needleUrl = new URL(rawNeedle);
                    // нормализуем путь без хвостовых слэшей
                    needleUrl.pathname = needleUrl.pathname.replace(/\/+$|^\/+/g, '/');
                }
            } catch (e) {
                needleIsAbsoluteUrl = false;
                needleUrl = null;
            }

        // Предпочтение совпадениям в верхней области; иначе принимаем любой видимый результат
            let fallbackMatch = null;
            for (let i = 0; i < links.length; i++) {
                const link = links[i];
            try {
                const href = link.href || '';
                const rect = link.getBoundingClientRect();
                const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
                const inTopArea = rect.top >= 0 && rect.top < (window.innerHeight / 2);

                if (!visible) continue;
                    // Если пустой needle — возвращаем первую видимую ссылку
                    if (needle === '') {
                        foundLink = link;
                        break;
                    }

                    // Если поисковая строка — абсолютный URL, то сравниваем origin + pathname (без query/hash)
                    if (needleIsAbsoluteUrl && needleUrl) {
                        try {
                            const urlObj = new URL(href, location.href);
                            // нормализуем пути: убираем хвостовые слэши
                            const p1 = (urlObj.pathname || '').replace(/\/+$|^\/+/g, '/').toLowerCase();
                            const p2 = (needleUrl.pathname || '').replace(/\/+$|^\/+/g, '/').toLowerCase();
                            const sameOrigin = urlObj.origin.toLowerCase() === needleUrl.origin.toLowerCase();
                            const pathMatches = p1.startsWith(p2);
                            if (sameOrigin && pathMatches) {
                                // предпочитаем совпадение в верхней области
                                if (inTopArea) { foundLink = link; break; }
                                if (!fallbackMatch) fallbackMatch = link;
                                continue;
                            }
                        } catch (e) {
                            // если парсинг упал — продолжаем к общему поиску
                        }
                    }

                    // Обычная логика: совпадение по href или по тексту ссылки (case-insensitive)
                    const text = (link.textContent || '').trim().toLowerCase();
                    const hrefLower = href.toLowerCase();
                    const hrefMatch = hrefLower.includes(needle);
                    const textMatch = text && text.includes(needle);

                    // предпочитаем совпадение в верхней области
                    if ((hrefMatch || textMatch) && inTopArea) {
                        foundLink = link;
                        break;
                    }
                    // иначе запоминаем первое видимое совпадение как запасной вариант
                    if ((hrefMatch || textMatch) && !fallbackMatch) {
                        fallbackMatch = link;
                    }
            } catch (e) {
                continue;
            }
        }

        if (!foundLink && fallbackMatch) foundLink = fallbackMatch;

        if (foundLink) {
            const rect = foundLink.getBoundingClientRect();
            const online = isStreamerOnline();
            console.log(`Ссылка найдена (content.js). href=${foundLink.href} top=${Math.round(rect.top)} visibleHeight=${Math.round(rect.height)} online=${online}`);
            // удалить предыдущие подсветки
            try {
                document.querySelectorAll('.tc-highlight').forEach(el => el.classList.remove('tc-highlight'));
                // добавить подсветку найденной ссылке
                foundLink.classList.add('tc-highlight');
            } catch (e) {
                // игнорируем ошибки модификации DOM
            }
            // Возвращаем дополнительную информацию: текущий URL страницы и текст ссылки (имя категории)
            return {
                found: true,
                href: foundLink.href,
                position: { x: rect.left, y: rect.top },
                pageUrl: location.href,
                pagePathname: location.pathname,
                pageHost: location.host,
                linkText: (foundLink.textContent || '').trim(),
                streamerOnline: online
            };
        }
        console.log("Ссылка не найдена (content.js).");
        return { found: false, streamerOnline: isStreamerOnline() };
    } catch (err) {
        console.error("Ошибка в findAndHighlightLink:", err);
        return { found: false, error: String(err) };
    }
}

// Парсинг страницы инвентаря Drops (Twitch и Kick)
async function scrapeDropsInventory() {
    try {
        const host = (location && location.hostname) ? location.hostname.toLowerCase() : '';
        const isKick = host.includes('kick.com');
        const isTwitch = host.includes('twitch.tv');
        if (!isKick && !isTwitch) {
            return { ok: false, error: 'Вкладка не относится к Twitch или Kick: ' + location.href };
        }

        // 0. Ожидание начальной отрисовки DOM инвентаря (до 9 секунд)
        if (isTwitch) {
            for (let wait = 0; wait < 30; wait++) {
                const hasHeadings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, p, span'))
                    .some(el => {
                        const t = (el.textContent || '').trim().toLowerCase();
                        return t === 'получено' || t === 'claimed' || t === 'полученные награды' || t === 'claimed drops' || t.includes('текущие');
                    });
                const hasCards = document.querySelectorAll('img[src*="jtvnw.net"], img[src*="twitch-quests-assets"], img[alt*="Drop" i], img.inventory-drop-image, [role="progressbar"]').length > 0;
                const isLoggedOut = !!document.querySelector('button[data-a-target="login-button"]');
                if ((hasHeadings && hasCards) || isLoggedOut || (hasCards && wait > 6)) {
                    break;
                }
                await new Promise(r => setTimeout(r, 300));
            }
        }

        // 1. Раскрытие свернутых секций
        try {
            document.querySelectorAll('button[aria-expanded="false"]').forEach(btn => {
                const txt = (btn.textContent || '').toLowerCase();
                if (txt.includes('drop') || txt.includes('дроп') || txt.includes('rust') || txt.includes('campaign') || txt.includes('кампани') || txt.includes('описание')) {
                    try { btn.click(); } catch(e) {}
                }
            });
        } catch(e) {}

        // 1.1. Раскрытие ВСЕХ порций наград в секции "Получено" / "Claimed" (включая вторую, третью двадцатки и т.д.)
        if (isTwitch) {
            try {
                const countClaimedCards = () => {
                    const main = document.querySelector('main, [role="main"]') || document.body;
                    const dateEls = Array.from(main.querySelectorAll('p, span, div, h4, h5, h6')).filter(el => {
                        if (el.children.length > 2) return false;
                        const t = (el.textContent || '').trim().toLowerCase();
                        return t === 'позавчера' || t === 'вчера' || t === 'сегодня' ||
                               t === 'yesterday' || t === 'today' ||
                               t.includes('назад') || t.includes('ago') ||
                               t.includes('получено') || t.includes('claimed');
                    });

                    const cardContainers = new Set();
                    dateEls.forEach(el => {
                        let card = el.parentElement;
                        for (let i = 0; i < 4 && card && card !== main; i++) {
                            const lines = (card.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
                            if (lines.length >= 2 && lines.length <= 8) {
                                cardContainers.add(card);
                                break;
                            }
                            card = card.parentElement;
                        }
                    });

                    return Math.max(cardContainers.size, dateEls.length);
                };

                const findInventoryLoadMoreButton = () => {
                    const main = document.querySelector('main, [role="main"]') || document.body;
                    const allButtons = Array.from(main.querySelectorAll('button, [role="button"]'));

                    return allButtons.find(b => {
                        // Исключаем левую боковую панель, шапку и навигацию
                        if (b.closest('nav, aside, [data-a-target="side-nav"], #side-nav, .side-nav, [role="navigation"]')) {
                            return false;
                        }
                        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;

                        const txt = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const target = (b.getAttribute('data-a-target') || '').toLowerCase();
                        const testSel = (b.getAttribute('data-test-selector') || '').toLowerCase();

                        // Исключаем кнопки боковой панели канала ("показать еще", "отслеживаемое")
                        if (txt.includes('показать') || txt.includes('отслеживаемое') || txt.includes('followed') || txt.includes('канал') || txt.includes('stream')) {
                            return false;
                        }

                        // Ищем строго кнопку "Загрузить еще" / "Load more"
                        return txt === 'загрузить еще' ||
                               txt === 'загрузить ещё' ||
                               txt === 'load more' ||
                               txt.startsWith('загрузить еще') ||
                               txt.startsWith('загрузить ещё') ||
                               txt.startsWith('load more') ||
                               (txt.includes('загрузить') && (txt.includes('еще') || txt.includes('ещё') || txt.includes('наград'))) ||
                               target.includes('load-more') ||
                               testSel.includes('load-more');
                    });
                };

                for (let iter = 0; iter < 5; iter++) {
                    window.scrollTo(0, document.body.scrollHeight);
                    await new Promise(r => setTimeout(r, 400));

                    const loadMoreBtn = findInventoryLoadMoreButton();
                    if (!loadMoreBtn) break;

                    const prevCount = countClaimedCards();

                    try {
                        loadMoreBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
                    } catch(e) {}

                    const _force = loadMoreBtn.offsetHeight;
                    const labelEl = loadMoreBtn.querySelector('[data-a-target="tw-core-button-label-text"]') || loadMoreBtn.firstElementChild || loadMoreBtn;

                    try {
                        const opts = { bubbles: true, cancelable: true, view: window, detail: 1, button: 0 };
                        loadMoreBtn.dispatchEvent(new PointerEvent('pointerdown', opts));
                        loadMoreBtn.dispatchEvent(new MouseEvent('mousedown', opts));
                        loadMoreBtn.dispatchEvent(new PointerEvent('pointerup', opts));
                        loadMoreBtn.dispatchEvent(new MouseEvent('mouseup', opts));
                        loadMoreBtn.dispatchEvent(new MouseEvent('click', opts));
                        loadMoreBtn.click();
                        if (labelEl && labelEl !== loadMoreBtn) {
                            labelEl.dispatchEvent(new MouseEvent('click', opts));
                            labelEl.click();
                        }
                    } catch(e) {
                        break;
                    }

                    // Ожидание подгрузки новых наград через GraphQL (до 7.5 секунд)
                    let loadedNew = false;
                    for (let w = 0; w < 25; w++) {
                        await new Promise(r => setTimeout(r, 300));
                        const curCount = countClaimedCards();
                        if (curCount > prevCount) {
                            loadedNew = true;
                            window.scrollTo(0, document.body.scrollHeight);
                            await new Promise(r => setTimeout(r, 400));
                            break;
                        }
                        if (!document.body.contains(loadMoreBtn) || loadMoreBtn.disabled || loadMoreBtn.getAttribute('aria-disabled') === 'true') {
                            await new Promise(r => setTimeout(r, 800));
                            if (countClaimedCards() > prevCount) loadedNew = true;
                            break;
                        }
                    }

                    if (!loadedNew) break;
                }
            } catch(e) {}
        }

        const drops = [];
        const processedKeys = new Set();

        const addDrop = (name, streamers, percentage, isClaimed, canClaim, timeAgo = '') => {
            const cleanStreamers = Array.from(new Set((streamers || []).map(s => (s || '').toLowerCase().trim()).filter(Boolean)));
            const streamerKey = cleanStreamers.slice().sort().join('_');
            const cleanName = (name || '').replace(/\s+/g, ' ').trim();
            const nameKey = cleanName.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
            const key = streamerKey ? `${streamerKey}_${nameKey}` : nameKey;
            if (!key || processedKeys.has(key)) return;
            processedKeys.add(key);

            drops.push({
                name: cleanName || (cleanStreamers[0] ? `Drop (${cleanStreamers[0]})` : 'Reward'),
                streamers: cleanStreamers,
                percentage: isClaimed ? 100 : Math.min(100, Math.max(0, percentage || 0)),
                isClaimed: !!isClaimed || percentage >= 100,
                canClaim: !!canClaim,
                timeAgo: timeAgo || ''
            });
        };

        // 2. Сбор данных из React Fiber (если доступен в памяти)
        try {
            const rootEl = document.querySelector('#root') || document.body;
            let fiber = null;
            if (rootEl) {
                for (const k in rootEl) {
                    if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
                        fiber = rootEl[k];
                        break;
                    }
                }
            }
            if (fiber) {
                const visited = new Set();
                const q = [fiber];
                while (q.length > 0 && visited.size < 4000) {
                    const node = q.shift();
                    if (!node || visited.has(node)) continue;
                    visited.add(node);

                    const p = node.memoizedProps;
                    if (p && typeof p === 'object') {
                        const campaigns = p.campaigns || p.dropCampaigns || (p.inventory && p.inventory.campaigns);
                        if (Array.isArray(campaigns)) {
                            campaigns.forEach(c => {
                                const timeDrops = c.timeBasedDrops || c.drops || [];
                                const campStreamers = [];
                                if (Array.isArray(c.channels)) c.channels.forEach(ch => ch.name && campStreamers.push(ch.name));
                                if (c.allow && Array.isArray(c.allow.channels)) c.allow.channels.forEach(ch => ch.name && campStreamers.push(ch.name));

                                timeDrops.forEach(d => {
                                    const dName = d.name || (d.benefitEdges && d.benefitEdges[0] && d.benefitEdges[0].benefit && d.benefitEdges[0].benefit.name);
                                    const reqMin = d.requiredMinutesWatched || 60;
                                    const curMin = d.currentMinutesWatched || 0;
                                    const isClaimed = !!d.isClaimed || (d.self && !!d.self.isClaimed);
                                    const pct = isClaimed ? 100 : Math.min(100, Math.round((curMin / reqMin) * 100));

                                    const dropStreamers = campStreamers.slice();
                                    if (Array.isArray(d.channels)) d.channels.forEach(ch => ch.name && dropStreamers.push(ch.name));

                                    if (dName) {
                                        addDrop(dName, dropStreamers, pct, isClaimed, !isClaimed && pct >= 100);
                                    }
                                });
                            });
                        }
                    }

                    if (node.child) q.push(node.child);
                    if (node.sibling) q.push(node.sibling);
                }
            }
        } catch(e) {}

        // 3. Парсинг DOM страниц (Twitch)
        if (isTwitch) {
            // Поиск всех блоков строк кампаний в инвентаре
            const rowMarkers = Array.from(document.querySelectorAll('a, button, p, span, div')).filter(el => {
                const t = (el.textContent || '').trim().toLowerCase();
                return t === 'описание этого drop' || t === 'about this drop' || t.startsWith('описание этого drop') || t.startsWith('about this drop');
            });

            const candidateRows = new Set();
            rowMarkers.forEach(marker => {
                let curr = marker.parentElement;
                while (curr && curr !== document.body) {
                    if (curr.querySelector('img') && (curr.querySelector('[role="progressbar"]') || (curr.innerText || '').match(/\d+%/))) {
                        candidateRows.add(curr);
                        break;
                    }
                    curr = curr.parentElement;
                }
            });

            // Также добавляем все прогресс-бары и локальные карточки наград
            const allPbs = document.querySelectorAll('[role="progressbar"], [aria-valuenow]');
            allPbs.forEach(pb => {
                let card = pb.parentElement;
                while (card && card !== document.body) {
                    if (card.querySelectorAll('[role="progressbar"]').length > 1) break;
                    if (card.querySelector('img') || (card.innerText || '').length > 5) {
                        candidateRows.add(card);
                        break;
                    }
                    card = card.parentElement;
                }
            });

            // Добавляем карточки с кнопками Claim или бейджами Получено
            document.querySelectorAll('button').forEach(btn => {
                const txt = (btn.textContent || '').toLowerCase();
                if (txt.includes('claim') || txt.includes('получить') || txt.includes('забрать')) {
                    let card = btn.parentElement;
                    while (card && card !== document.body) {
                        if (card.querySelector('img') || (card.innerText || '').length > 5) {
                            candidateRows.add(card);
                            break;
                        }
                        card = card.parentElement;
                    }
                }
            });

            // Парсим каждый блок
            candidateRows.forEach(row => {
                const rowText = row.innerText || '';

                // Извлечение стримеров из ссылок (/streamer) и текста (/streamer)
                const streamers = new Set();
                row.querySelectorAll('a[href]').forEach(a => {
                    const href = (a.getAttribute('href') || '').trim();
                    const m = href.match(/(?:twitch\.tv\/|^|\/)([a-zA-Z0-9_]{3,30})$/i);
                    if (m) {
                        const u = m[1].toLowerCase();
                        const sys = ['directory', 'drops', 'inventory', 'campaigns', 'settings', 'subscriptions', 'wallet', 'messages', 'notifications', 'login', 'signup', 'videos', 'moderator', 'friends', 'search', 'p', 'about'];
                        if (!sys.includes(u)) streamers.add(u);
                    }
                });
                const slashMatches = [...rowText.matchAll(/\/([a-zA-Z0-9_]{3,30})/g)];
                slashMatches.forEach(m => {
                    const u = m[1].toLowerCase();
                    const sys = ['directory', 'drops', 'inventory', 'campaigns', 'settings', 'subscriptions', 'wallet', 'messages', 'notifications', 'login', 'signup', 'videos', 'moderator', 'friends', 'search', 'p', 'about'];
                    if (!sys.includes(u)) streamers.add(u);
                });

                // Процент просмотра
                let percent = 0;
                const pb = row.querySelector('[role="progressbar"], [aria-valuenow]');
                if (pb) {
                    const ariaVal = pb.getAttribute('aria-valuenow');
                    if (ariaVal !== null && !isNaN(Number(ariaVal))) {
                        percent = Math.min(100, Math.max(0, Math.round(Number(ariaVal))));
                    }
                }
                const pctMatch = rowText.match(/(\d{1,3})\s*%/);
                if (pctMatch) {
                    percent = Math.max(percent, Math.min(100, parseInt(pctMatch[1], 10)));
                }

                // Завершение и Claim
                const lowerText = rowText.toLowerCase();
                const isClaimed = lowerText.includes('получено') || lowerText.includes('claimed');
                let canClaim = false;
                const claimBtn = Array.from(row.querySelectorAll('button')).find(b => {
                    const txt = (b.textContent || '').toLowerCase();
                    return txt.includes('claim') || txt.includes('получить') || txt.includes('забрать');
                });
                if (claimBtn) {
                    canClaim = true;
                    percent = 100;
                    if (!claimBtn.disabled) {
                        try { claimBtn.click(); } catch(e) {}
                    }
                }
                if (isClaimed) percent = 100;

                // Название дропа
                let dropName = '';
                const imgs = row.querySelectorAll('img[alt]');
                for (const img of imgs) {
                    const a = (img.alt || '').trim();
                    if (a && a.length > 2 && !a.toLowerCase().includes('avatar') && !a.toLowerCase().includes('logo') && a.toLowerCase() !== 'rust') {
                        dropName = a;
                        break;
                    }
                }
                if (!dropName) {
                    const lines = rowText.split('\n').map(s => s.trim()).filter(Boolean);
                    for (const line of lines) {
                        const l = line.toLowerCase();
                        if (line.length > 2 && line.length < 50 &&
                            !line.includes('%') &&
                            !line.match(/\d+:\d+/) &&
                            !l.includes('дата') && !l.includes('date') &&
                            !l.includes('описание') && !l.includes('about') &&
                            !l.includes('зарабатываете') && !l.includes('увеличить') &&
                            !l.includes('перейдите') && !l.includes('получить') &&
                            !l.includes('получено') && !l.includes('claimed') &&
                            !l.includes('drops') && !l.includes('награды') &&
                            !l.includes('gmt') && !l.includes('utc')) {
                            dropName = line;
                            break;
                        }
                    }
                }

                if (dropName || streamers.size > 0) {
                    addDrop(dropName, Array.from(streamers), percent, isClaimed, canClaim);
                }
            });

            // Парсинг уже полученных наград (секция "Получено" / "Claimed")
            const claimedCards = new Set();
            const invMain = document.querySelector('main, [role="main"]') || document.body;

            // 1. Поиск по всем карточкам с метками времени (позавчера, вчера, сегодня, назад, ago, получено)
            const dateNodes = Array.from(invMain.querySelectorAll('p, span, div, h4, h5, h6')).filter(el => {
                if (el.children.length > 2) return false;
                const t = (el.textContent || '').trim().toLowerCase();
                return t === 'позавчера' || t === 'вчера' || t === 'сегодня' ||
                       t === 'yesterday' || t === 'today' ||
                       t.includes('назад') || t.includes('ago') ||
                       t.includes('получено') || t.includes('claimed');
            });

            dateNodes.forEach(el => {
                let card = el.parentElement;
                for (let i = 0; i < 4 && card && card !== invMain; i++) {
                    const text = (card.innerText || '').trim();
                    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
                    if (lines.length >= 2 && lines.length <= 8 && text.length > 4 && text.length < 300) {
                        claimedCards.add(card);
                        break;
                    }
                    card = card.parentElement;
                }
            });

            // 2. Поиск по всем изображениям дропов
            const claimedImgs = invMain.querySelectorAll('img');
            claimedImgs.forEach(img => {
                let card = img.parentElement;
                for (let i = 0; i < 5 && card && card !== invMain; i++) {
                    const text = (card.innerText || '').trim();
                    if (text.length > 4 && text.length < 300) {
                        claimedCards.add(card);
                        break;
                    }
                    card = card.parentElement;
                }
            });

            claimedCards.forEach(card => {
                let dropName = '';
                const img = card.querySelector('img');
                const alt = img ? (img.getAttribute('alt') || '').trim() : '';
                if (alt && !alt.toLowerCase().includes('avatar') && !alt.toLowerCase().includes('logo')) {
                    dropName = alt.replace(/^(?:изображение\s+(?:drop\s+)?для|изображение\s+для|drop\s+image\s+for|reward\s+image\s+for|image\s+for)\s*/i, '').trim();
                }

                const cardText = (card.innerText || '').trim();
                const lines = cardText.split('\n').map(s => s.trim()).filter(Boolean);

                // Если нет alt или alt общий: извлекаем название из строк текста карточки!
                if (!dropName || dropName.toLowerCase() === 'drop' || dropName.toLowerCase() === 'reward' || dropName.toLowerCase() === 'rust') {
                    for (const line of lines) {
                        const l = line.toLowerCase();
                        if (line.length < 2 || line.length > 60) continue;
                        if (line === '1' || line === '✓' || line === '✔' || !isNaN(Number(line))) continue;
                        if (l === 'вчера' || l === 'позавчера' || l === 'сегодня' || l === 'yesterday' || l === 'today') continue;
                        if (l.includes('назад') || l.includes('ago') || l.includes('получено') || l.includes('claimed')) continue;
                        if (l.includes('%') || l.includes('gmt') || l.includes('utc') || l.match(/\d+:\d+/)) continue;
                        if (l === 'rust' || l === 'twitch' || l === 'drops' || l === 'награды' || l === 'значок') continue;

                        dropName = line;
                        break;
                    }
                }

                let timeAgo = '';
                const timeMatch = cardText.match(/(\d+\s*(?:час|ч|мин|м|день|дня|дней|д|hour|h|min|m|day|d|вчера|позавчера|yesterday|месяц|month|год|year)[^\n]*)/i);
                if (timeMatch) timeAgo = timeMatch[1].trim();
                if (!timeAgo) {
                    if (cardText.toLowerCase().includes('позавчера')) timeAgo = 'позавчера';
                    else if (cardText.toLowerCase().includes('вчера')) timeAgo = 'вчера';
                }

                if (dropName) {
                    addDrop(dropName, [], 100, true, false, timeAgo);
                }
            });
        } else if (isKick) {
            // Kick Drops Inventory
            const progressBars = document.querySelectorAll('[role="progressbar"], progress, [class*="progress"], [aria-valuenow]');
            progressBars.forEach(pb => {
                let card = pb.parentElement;
                while (card && card !== document.body) {
                    if (card.querySelectorAll('[role="progressbar"]').length > 1) break;
                    if (card.querySelector('img') || (card.innerText || '').length > 5) break;
                    card = card.parentElement;
                }
                if (!card) card = pb.parentElement;

                let percent = 0;
                const ariaVal = pb.getAttribute('aria-valuenow') || pb.value;
                if (ariaVal !== null && !isNaN(Number(ariaVal))) {
                    percent = Math.min(100, Math.max(0, Math.round(Number(ariaVal))));
                } else if (card) {
                    const textMatch = (card.innerText || '').match(/(\d{1,3})\s*%/);
                    if (textMatch) percent = Math.min(100, parseInt(textMatch[1], 10));
                }

                const cardText = card ? (card.innerText || '') : '';
                const isClaimed = cardText.toLowerCase().includes('claimed') || cardText.toLowerCase().includes('получено');
                const claimBtn = card ? card.querySelector('button') : null;
                if (claimBtn && claimBtn.textContent && claimBtn.textContent.toLowerCase().includes('claim')) {
                    try { claimBtn.click(); } catch(e) {}
                }

                let dropName = '';
                if (card) {
                    const titleEl = card.querySelector('h2, h3, h4, h5, [class*="title"], [class*="name"]');
                    if (titleEl) dropName = titleEl.textContent.trim();
                }

                const streamers = [];
                if (card) {
                    card.querySelectorAll('a[href]').forEach(a => {
                        const href = a.getAttribute('href') || '';
                        const m = href.match(/kick\.com\/([a-zA-Z0-9_]{3,30})$/i) || href.match(/^\/([a-zA-Z0-9_]{3,30})$/i);
                        if (m && !['drops', 'categories', 'inventory'].includes(m[1].toLowerCase())) {
                            streamers.push(m[1].toLowerCase());
                        }
                    });
                }

                addDrop(dropName, streamers, percent, isClaimed, !isClaimed && percent >= 100);
            });
        }

        const isLoggedOut = !!document.querySelector('button[data-a-target="login-button"]');

        return {
            ok: true,
            platform: isKick ? 'kick' : 'twitch',
            drops,
            totalFound: drops.length,
            isLoggedOut
        };
    } catch(err) {
        return { ok: false, error: String(err) };
    }
}

// =========================================================
// Парсинг страницы кампаний Twitch Drops (/drops/campaigns)
// =========================================================

function getCampaignButtonsInPage() {
    const buttons = Array.from(document.querySelectorAll('button[aria-expanded]'));
    return buttons.filter(btn => {
        const text = (btn.textContent || '');
        return text.includes('GMT') || text.includes('UTC') ||
               text.includes('сент') || text.includes('окт') || text.includes('нояб') || text.includes('дек') ||
               text.includes('янв') || text.includes('фев') || text.includes('мар') || text.includes('апр') ||
               text.includes('май') || text.includes('июн') || text.includes('июл') || text.includes('авг') ||
               text.includes('день') || text.includes('дней') || text.includes('час') || text.includes('минут') ||
               text.includes('day') || text.includes('hour') || text.includes('min');
    });
}

async function waitForCampaignButtons(timeoutMs = 15000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        const buttons = getCampaignButtonsInPage();
        if (buttons.length > 0) {
            return buttons;
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return getCampaignButtonsInPage();
}

function parseCampaignButtonInfo(btn, index) {
    const isExpanded = btn.getAttribute('aria-expanded') === 'true';
    const imgEl = btn.querySelector('img');
    const coverImg = imgEl ? (imgEl.src || '') : '';
    const coverAlt = imgEl ? (imgEl.alt || '') : '';

    const pTags = Array.from(btn.querySelectorAll('p')).map(p => (p.textContent || '').trim()).filter(Boolean);
    const gameName = pTags[0] || coverAlt || 'Twitch Game';
    const campaignTitle = pTags[1] || '';

    let dateStr = '';
    const dateEl = btn.querySelector('.bkUUaS, [class*="bkUUaS"]');
    if (dateEl) {
        dateStr = (dateEl.textContent || '').replace(/\s+/g, ' ').trim();
    } else {
        const allText = (btn.textContent || '');
        const dMatch = allText.match(/([а-яa-z]{2,3},\s*\d{1,2}\s+[а-яa-z]+[\s\S]*?(?:GMT|UTC)[^\s<]*)/i);
        if (dMatch) dateStr = dMatch[1].replace(/\s+/g, ' ').trim();
    }

    return {
        index,
        gameName,
        campaignTitle,
        coverImg,
        dateStr,
        isExpanded
    };
}

async function scrapeCampaignsListInPage() {
    try {
        const buttons = await waitForCampaignButtons(15000);
        const campaigns = buttons.map((b, i) => parseCampaignButtonInfo(b, i));
        return { ok: true, campaigns };
    } catch(err) {
        return { ok: false, error: String(err) };
    }
}

async function waitForExpandedContainer(targetBtn, timeoutMs = 12000) {
    const startTime = Date.now();
    let container = null;
    let prevElementsCount = 0;
    let stableChecks = 0;

    while (Date.now() - startTime < timeoutMs) {
        container = targetBtn.parentElement ? targetBtn.parentElement.nextElementSibling : null;
        if (!container) container = targetBtn.nextElementSibling;
        if (!container && targetBtn.parentElement && targetBtn.parentElement.parentElement) {
            const grand = targetBtn.parentElement.parentElement;
            const children = Array.from(grand.children);
            const idx = children.indexOf(targetBtn.parentElement);
            if (idx !== -1 && children[idx + 1]) {
                container = children[idx + 1];
            }
        }

        if (container) {
            try {
                // Прокручиваем страницу/контейнер, чтобы форсировать рендеринг ленивых секций в DOM (IntersectionObserver)
                container.scrollIntoView({ behavior: 'instant', block: 'nearest' });
                window.scrollBy(0, 400);
            } catch(e) {}

            const liCount = container.querySelectorAll('li').length;
            const linkCount = container.querySelectorAll('a[href]').length;
            const hrCount = container.querySelectorAll('hr').length;
            const currentTotal = liCount + linkCount + hrCount;

            if (currentTotal > 0) {
                if (currentTotal === prevElementsCount) {
                    stableChecks++;
                    // Завершаем ожидание, если появились ссылки на каналы и количество стабилизировалось,
                    // либо если элементов много и они не меняются
                    if ((linkCount >= 2 && stableChecks >= 2) || (currentTotal > 15 && stableChecks >= 3) || (Date.now() - startTime > 4500 && stableChecks >= 2)) {
                        break;
                    }
                } else {
                    stableChecks = 0;
                    prevElementsCount = currentTotal;
                }
            }
        }
        await new Promise(r => setTimeout(r, 400));
    }

    await new Promise(r => setTimeout(r, 300));
    return container || (targetBtn.parentElement && targetBtn.parentElement.nextElementSibling) || targetBtn.nextElementSibling || targetBtn.parentElement || document.body;
}

async function expandAndScrapeCampaignInPage(targetGameName, targetIndex) {
    try {
        const buttons = await waitForCampaignButtons(15000);
        let targetBtn = null;

        // 1. Поиск по имени игры в первую очередь
        if (targetGameName) {
            const targetLower = targetGameName.toLowerCase().trim();
            targetBtn = buttons.find(b => {
                const text = (b.textContent || '').toLowerCase();
                return text.includes(targetLower);
            });
        }

        // 2. Если по имени не найдено, поиск по индексу
        if (!targetBtn && typeof targetIndex === 'number' && targetIndex >= 0 && buttons[targetIndex]) {
            targetBtn = buttons[targetIndex];
        }

        // 3. Fallback к первому
        if (!targetBtn && buttons.length > 0) {
            targetBtn = buttons[0];
        }

        if (!targetBtn) {
            return { ok: false, error: 'Кампания не найдена на странице' };
        }

        try {
            targetBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch(e) {}

        // Если свернуто — раскрываем кликом
        if (targetBtn.getAttribute('aria-expanded') !== 'true') {
            targetBtn.click();
        }

        // Ждем отрисовку контента аккордеона со всеми секциями
        const container = await waitForExpandedContainer(targetBtn, 12000);
        const buttonInfo = parseCampaignButtonInfo(targetBtn, typeof targetIndex === 'number' ? targetIndex : 0);

        // 1. Поиск категории
        let categoryUrl = '';
        const catLinks = Array.from(container.querySelectorAll('a[href*="/directory/category/"], a[href*="/directory/game/"]'));
        if (catLinks.length > 0) {
            categoryUrl = catLinks[0].href.split('?')[0].replace(/\/+$/, '');
        }

        // 2. Поиск секций дропов (разделенных <hr> или заголовками)
        const streamerDrops = [];
        const generalDrops = [];
        const dropMedia = {};
        const allCampaignStreamers = new Set();

        const containerHtml = container.innerHTML || '';
        let dropSectionsHtml = containerHtml.split(/<hr\b[^>]*>/gi);
        if (dropSectionsHtml.length <= 1) {
            const byLabel = containerHtml.split(/(?=<div[^>]*class="[^"]*drop-details__label[^"]*")/gi);
            if (byLabel.length > 1) {
                dropSectionsHtml = byLabel;
            } else {
                const byHeader = containerHtml.split(/(?=<strong[^>]*class="[^"]*QdNyA[^"]*")/gi);
                if (byHeader.length > 1) {
                    dropSectionsHtml = byHeader;
                }
            }
        }

        dropSectionsHtml.forEach((secHtml, idx) => {
            // Пропуск платных подписочных дропов (sub / gift-sub), которые не за просмотр
            const isSubDrop = (/подпишитесь|подписку|subscribe|gift\s+sub/i.test(secHtml)) && (!/смотрите\s+в\s+течение|watch\s+for|посмотрите/i.test(secHtml));
            if (isSubDrop) return;

            // Сбор стримеров из ссылок (как относительных /streamer, так и полных)
            const sectionStreamers = new Set();
            const linkMatches = [...secHtml.matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)];
            linkMatches.forEach(m => {
                const href = m[1];
                if (!categoryUrl && (href.includes('/directory/category/') || href.includes('/directory/game/'))) {
                    categoryUrl = (href.startsWith('http') ? href : `https://www.twitch.tv${href}`).split('?')[0];
                }
                const userMatch = href.match(/(?:twitch\.tv\/|^|\/)([a-zA-Z0-9_]{3,30})$/i);
                if (userMatch) {
                    const u = userMatch[1].toLowerCase();
                    const sys = ['directory', 'drops', 'inventory', 'campaigns', 'settings', 'subscriptions', 'wallet', 'p', 'about', 'help', 'rust', 'team', 'videos', 'jobs', 'blog', 'privacy', 'security'];
                    if (!sys.includes(u)) {
                        sectionStreamers.add(u);
                        allCampaignStreamers.add(u);
                    }
                }
            });

            // Сбор картинок в секции с их alt
            const imgMatches = [...secHtml.matchAll(/<img\b([^>]*)>/gi)];
            const images = [];
            imgMatches.forEach(im => {
                const srcM = im[1].match(/src="([^"]+)"/i);
                const altM = im[1].match(/alt="([^"]*)"/i);
                if (srcM && !srcM[1].includes('partner-thumbnail')) {
                    images.push({
                        src: srcM[1],
                        alt: altM ? altM[1].trim() : ''
                    });
                }
            });

            // Сбор наград и времени просмотра из элементов списка <li>
            const liMatches = [...secHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
            const items = [];

            liMatches.forEach(li => {
                const liText = li[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                const timeMatch = liText.match(/(?:смотрите\s+в\s+течение|watch\s+(?:for\s+)?|посмотрите\s+в\s+течение)\s*(\d+)\s*(hour|hours|hr|h|час|часа|часов|minute|minutes|min|мин|минут|минуты)/i);
                if (timeMatch) {
                    const num = parseInt(timeMatch[1], 10);
                    const unit = timeMatch[2].toLowerCase();
                    let watchTime = '01:00:00';
                    if (unit.startsWith('час') || unit.startsWith('h')) {
                        watchTime = `${num.toString().padStart(2, '0')}:00:00`;
                    } else {
                        const h = Math.floor(num / 60);
                        const m = num % 60;
                        watchTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:00`;
                    }

                    let rewardName = '';
                    const nameMatch = liText.match(/(?:получите\s+награду|claim\s+(?:the\s+)?reward)\s+([^\.]+?)(?:\s*\(|$)/i);
                    if (nameMatch) {
                        rewardName = nameMatch[1].trim();
                    }

                    items.push({ rewardName, watchTime });
                }
            });

            // Fallback если <li> не найдены, но есть заголовок или время в тексте
            if (items.length === 0) {
                const timeMatch = secHtml.match(/(?:смотрите\s+в\s+течение|watch\s+(?:for\s+)?|посмотрите\s+в\s+течение)\s*(\d+)\s*(hour|hours|hr|h|час|часа|часов|minute|minutes|min|мин|минут|минуты)/i);
                if (timeMatch || images.length > 0) {
                    let watchTime = '01:00:00';
                    if (timeMatch) {
                        const num = parseInt(timeMatch[1], 10);
                        const unit = timeMatch[2].toLowerCase();
                        if (unit.startsWith('час') || unit.startsWith('h')) {
                            watchTime = `${num.toString().padStart(2, '0')}:00:00`;
                        } else {
                            const h = Math.floor(num / 60);
                            const m = num % 60;
                            watchTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:00`;
                        }
                    }

                    const strongHeader = secHtml.match(/<strong\b[^>]*>([^<]+)<\/strong>/i);
                    const rName = (strongHeader && !['награды', 'как получить drop', 'как получить награду', 'обзор'].includes(strongHeader[1].toLowerCase().trim()))
                        ? strongHeader[1].trim()
                        : (images[0] && images[0].alt ? images[0].alt : `Награда ${idx + 1}`);

                    items.push({ rewardName: rName, watchTime });
                }
            }

            // Создаем объекты наград для каждого пункта
            items.forEach((item, itemIdx) => {
                const rName = item.rewardName || `Награда ${idx + 1}_${itemIdx + 1}`;
                const safeName = rName.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '_').replace(/^_+|_+$/g, '');
                const hoursPart = parseInt(item.watchTime.split(':')[0], 10) || 1;
                const dropId = `drop_${safeName}_${hoursPart}h${itemIdx > 0 ? '_' + (itemIdx + 1) : ''}`;

                // Ищем наиболее подходящую картинку по названию
                let matchedImg = images.find(im => im.alt && (
                    im.alt.toLowerCase() === rName.toLowerCase() ||
                    im.alt.toLowerCase().includes(rName.toLowerCase()) ||
                    rName.toLowerCase().includes(im.alt.toLowerCase())
                ));
                if (!matchedImg && images[itemIdx]) matchedImg = images[itemIdx];
                if (!matchedImg && images[0]) matchedImg = images[0];
                const imageUrl = matchedImg ? matchedImg.src : '';

                const dropObj = {
                    dropId,
                    name: rName,
                    watchTime: item.watchTime,
                    channels: Array.from(sectionStreamers).map(u => `https://www.twitch.tv/${u}`),
                    imageUrl
                };

                if (dropObj.imageUrl) {
                    dropMedia[dropId] = {
                        imageUrl: dropObj.imageUrl,
                        name: dropObj.name
                    };
                }

                if (sectionStreamers.size > 0) {
                    streamerDrops.push(dropObj);
                } else {
                    generalDrops.push(dropObj);
                }
            });
        });


        // Если категория не найдена из ссылок, строим по имени игры
        if (!categoryUrl && buttonInfo.gameName) {
            categoryUrl = `https://www.twitch.tv/directory/category/${buttonInfo.gameName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        }

        return {
            ok: true,
            campaign: {
                meta: buttonInfo,
                categoryUrl,
                streamerDrops,
                generalDrops,
                dropMedia,
                allCampaignStreamers: Array.from(allCampaignStreamers)
            }
        };
    } catch(err) {
        return { ok: false, error: String(err) };
    }
}

function scrapeCategoryLiveChannelsInPage() {
    try {
        const links = Array.from(document.querySelectorAll('a[data-a-target="preview-card-channel-link"], a[data-a-target="preview-card-image-link"]'));
        const channels = new Set();
        links.forEach(a => {
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([a-zA-Z0-9_]{3,30})$/i) || href.match(/twitch\.tv\/([a-zA-Z0-9_]{3,30})$/i);
            if (m) {
                const u = m[1].toLowerCase();
                const sys = ['directory', 'drops', 'inventory', 'campaigns', 'settings', 'subscriptions', 'wallet', 'p', 'about', 'help'];
                if (!sys.includes(u)) {
                    channels.add(`https://www.twitch.tv/${m[1]}`);
                }
            }
        });
        return { ok: true, channels: Array.from(channels) };
    } catch(err) {
        return { ok: false, error: String(err) };
    }
}

// Обработчик сообщений с обработкой ошибок
try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        try {
            if (request.action === "findLink") {
                let result = findAndHighlightLink(request.text);
                sendResponse(result);
            } else if (request.action === "scrapeInventory") {
                scrapeDropsInventory().then(result => {
                    sendResponse(result);
                }).catch(err => {
                    sendResponse({ ok: false, error: String(err) });
                });
                return true;
            } else if (request.action === "scrapeCampaignsList") {
                scrapeCampaignsListInPage().then(result => {
                    sendResponse(result);
                }).catch(err => {
                    sendResponse({ ok: false, error: String(err) });
                });
                return true;
            } else if (request.action === "expandAndScrapeCampaign") {
                expandAndScrapeCampaignInPage(request.gameName, request.index).then(result => {
                    sendResponse(result);
                }).catch(err => {
                    sendResponse({ ok: false, error: String(err) });
                });
                return true;
            } else if (request.action === "scrapeCategoryChannels") {
                sendResponse(scrapeCategoryLiveChannelsInPage());
            }
        } catch (err) {
            console.error("Ошибка в content.js при обработке сообщения:", err);
            sendResponse({ found: false, error: String(err) });
            return false;
        }
        return false;
    });
} catch (err) {
    console.error("Ошибка при регистрации onMessage в content.js:", err);
}

let isAutoSendingInventory = false;
async function autoSendInventory() {
    if (location.href.includes('/drops/inventory')) {
        if (isAutoSendingInventory) return;
        isAutoSendingInventory = true;
        try {
            const inv = await scrapeDropsInventory();
            if (inv && inv.ok && Array.isArray(inv.drops) && inv.drops.length > 0) {
                chrome.runtime.sendMessage({ action: "inventoryScraped", platform: inv.platform, drops: inv.drops });
            }
        } catch(e) {
        } finally {
            isAutoSendingInventory = false;
        }
    }
}

// отправляем при load и через небольшой таймаут (DOM динамический)
try {
    window.addEventListener('load', () => {
        autoSendInventory();
        setTimeout(autoSendInventory, 2500);
    });
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(autoSendInventory, 500);
    }
} catch (e) {}



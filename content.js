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

        // 1. Раскрытие свернутых секций
        try {
            document.querySelectorAll('button[aria-expanded="false"]').forEach(btn => {
                const txt = (btn.textContent || '').toLowerCase();
                if (txt.includes('drop') || txt.includes('дроп') || txt.includes('rust') || txt.includes('campaign') || txt.includes('кампани')) {
                    btn.click();
                }
            });
        } catch(e) {}

        // 1.1. Раскрытие скрытых полученных наград в секции "Получено" / "Claimed"
        try {
            for (let iter = 0; iter < 6; iter++) {
                // Ищем заголовок секции "Получено" / "Claimed"
                const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, p, span'));
                const claimedHeading = headings.find(el => {
                    const t = (el.textContent || '').trim().toLowerCase();
                    return t === 'получено' || t === 'claimed' || t === 'полученные награды' || t === 'claimed drops';
                });

                let claimedSection = claimedHeading ? claimedHeading.parentElement : null;
                while (claimedSection && claimedSection !== document.body) {
                    if (claimedSection.querySelector('.tw-tower, [class*="tw-tower"]') || claimedSection.querySelector('img.inventory-drop-image')) {
                        break;
                    }
                    claimedSection = claimedSection.parentElement;
                }

                const scope = claimedSection || document;
                const buttons = Array.from(scope.querySelectorAll('button, [role="button"]'));
                const loadMoreBtn = buttons.find(b => {
                    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
                    const txt = (b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                    const target = (b.getAttribute('data-a-target') || '').toLowerCase();
                    const hasLabel = !!b.querySelector('[data-a-target="tw-core-button-label-text"]');

                    return txt.includes('загрузить еще') ||
                           txt.includes('загрузить ещё') ||
                           txt.includes('load more') ||
                           txt.includes('show more') ||
                           txt.includes('показать еще') ||
                           txt.includes('показать ещё') ||
                           target.includes('load-more') ||
                           (hasLabel && (txt.includes('загрузить') || txt.includes('load')));
                });

                if (!loadMoreBtn) break;

                const getCardsCount = () => scope.querySelectorAll('img.inventory-drop-image, img[src*="twitch-quests-assets/REWARD"], img[alt*="Drop"], img[alt*="drop"]').length;
                const prevCount = getCardsCount();

                const labelEl = loadMoreBtn.querySelector('[data-a-target="tw-core-button-label-text"]') || loadMoreBtn;
                try {
                    loadMoreBtn.click();
                    if (labelEl !== loadMoreBtn) labelEl.click();
                    labelEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    loadMoreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                } catch(e) {
                    break;
                }

                let loadedNew = false;
                for (let w = 0; w < 15; w++) {
                    await new Promise(r => setTimeout(r, 200));
                    if (getCardsCount() > prevCount) {
                        loadedNew = true;
                        break;
                    }
                }
                if (!loadedNew) break;
            }
        } catch(e) {}

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
            const claimedImgs = document.querySelectorAll('img.inventory-drop-image, img[src*="twitch-quests-assets/REWARD"], img[alt*="Drop"], img[alt*="drop"]');
            claimedImgs.forEach(img => {
                let card = img.parentElement;
                for (let i = 0; i < 6 && card && card !== document.body; i++) {
                    if (card.querySelector('p, span') && (card.innerText || '').length > 3) {
                        break;
                    }
                    card = card.parentElement;
                }
                if (!card) card = img.parentElement;

                let dropName = '';
                const alt = (img.getAttribute('alt') || '').trim();
                if (alt) {
                    dropName = alt.replace(/^(?:Изображение\s+Drop\s+для|Drop\s+image\s+for|Reward\s+image\s+for)\s*/i, '').trim();
                }
                if (!dropName && card) {
                    const titleEl = card.querySelector('p.tw-strong, p[class*="strong"], [class*="title"], h5, h6, strong');
                    if (titleEl) dropName = titleEl.textContent.trim();
                }
                if (!dropName && card) {
                    const lines = (card.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
                    for (const line of lines) {
                        const l = line.toLowerCase();
                        if (line.length > 2 && line.length < 50 &&
                            !line.includes('%') && !line.match(/\d+:\d+/) &&
                            !l.includes('назад') && !l.includes('ago') &&
                            !l.includes('вчера') && !l.includes('yesterday') &&
                            !l.includes('получено') && !l.includes('claimed') &&
                            !l.includes('drops')) {
                            dropName = line;
                            break;
                        }
                    }
                }

                let timeAgo = '';
                if (card) {
                    const cardText = card.innerText || '';
                    const timeMatch = cardText.match(/(\d+\s*(?:час|мин|день|дня|дней|hour|min|day|вчера|yesterday|месяц|month|год|year)[^\n]*)/i);
                    if (timeMatch) timeAgo = timeMatch[1].trim();
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



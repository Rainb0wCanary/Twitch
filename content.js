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

        // Для Twitch: КРИТИЧНО — проверяем наличие видеоплеера с реальным источником ПЕРВЫМ
        // Если видео есть и работает — почти наверняка стример онлайн (работает плеер)
        const videoElement = document.querySelector('video');
        if (videoElement) {
            const src = (videoElement.currentSrc || videoElement.src || '').trim();
            if (src && src.length > 0) {
                // Есть реальный источник в плеере — стример ОНЛАЙН
                return true;
            }
        }

        // Проверяем явные ОФЛАЙН индикаторы в шапке канала (главная зона, не сайдбар)
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

// Обработчик сообщений с обработкой ошибок
try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        try {
            if (request.action === "findLink") {
                let result = findAndHighlightLink(request.text);
                sendResponse(result);
            }
        } catch (err) {
            console.error("Ошибка в content.js при обработке сообщения:", err);
            sendResponse({ found: false, error: String(err) });
        }
        // Для поддержки асинхронных ответов (но здесь не требуется)
        return false;
    });
} catch (err) {
    console.error("Ошибка при регистрации onMessage в content.js:", err);
}

// Автоматический сбор диагностического лога при загрузке страницы
function collectAndSendDiagnostic() {
    try {
        const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
        const streamerOnline = (typeof isStreamerOnline === 'function') ? isStreamerOnline() : null;
        const hasVideo = !!document.querySelector('video');
        const liveBadge = Array.from(document.querySelectorAll('span,div,b,strong')).some(el => {
            try {
                const t = (el.textContent || '').trim().toLowerCase();
                return t === 'live' || t.indexOf('live') !== -1 || t.indexOf('в эфире') !== -1 || t.indexOf('не в сети') !== -1;
            } catch (e) { return false; }
        });
        const gameLinkEl = document.querySelector('a[data-a-target="stream-game-link"]') || document.querySelector('a[href*="/directory/"]') || document.querySelector('a');
        const gameHref = gameLinkEl ? (gameLinkEl.href || null) : null;

        const report = {
            pageUrl: location.href,
            pageHost: location.host,
            timestamp: Date.now(),
            streamerOnline: streamerOnline,
            hasVideo: hasVideo,
            liveBadge: !!liveBadge,
            gameHref: gameHref,
            bodySnippet: bodyText ? bodyText.slice(0, 800) : ''
        };

        try {
            chrome.runtime.sendMessage({ action: 'diagnosticReport', report });
        } catch (e) {
            // fallback для окружений, где sendMessage недоступен
            console.log('Diagnostic report prepared', report);
        }
    } catch (e) {
        console.error('Ошибка при сборе диагностики:', e);
    }
}

// отправляем при load и через небольшой таймаут (DOM динамический)
try {
    window.addEventListener('load', () => {
        collectAndSendDiagnostic();
        setTimeout(collectAndSendDiagnostic, 2000);
        setTimeout(collectAndSendDiagnostic, 5000);
    });
    // также отправим сразу, если скрипт подключился после загрузки
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(collectAndSendDiagnostic, 200);
    }
} catch (e) {
    console.error('Не удалось зарегистрировать отправку диагностики:', e);
}



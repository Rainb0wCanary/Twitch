let isRunning = false;
let currentChannelIndex = 0;
let timerInterval = null;
// Устаревшее имя оставлено для совместимости; дополнительно используются watchTimerInterval и watchLinkCheckInterval
let watchTimerInterval = null;
let watchLinkCheckInterval = null;
let channels = [];
let searchUrlPart = "";
let defaultWatchTime = 30;
let defaultWaitBeforeCheck = 5;
let logBuffer = [];
let activeTabId = null;
let streamTabId = null; // id вкладки, где крутятся стримы
let streamWindowId = null; // id выделенного окна, где держим вкладку со стримом
let totalWatched = {}; // { url: seconds }
let currentStreamInfo = { url: null, secondsLeft: 0 };
let userPrevTabId = null; // id вкладки пользователя до переключения на стрим
let loggingEnabled = false;
let currentRunId = 0; // маркер запуска, используется для инвалидирования устаревших таймеров/обратных вызовов
let scheduledCheckTimeout = null; // id таймаута для запланированной проверки checkChannel (в watchNextChannel/manual)
let pendingDoFindTimeout = null; // id таймаута для отложенного вызова doFindLink в checkChannel

function setLoggingEnabled(enabled) {
    loggingEnabled = enabled;
    if (!enabled) {
        logBuffer = [];
        chrome.storage.local.set({ logBuffer: [] });
    }
}

function log(msg) {
    if (!loggingEnabled) return;
    logBuffer.push(msg);
    if (logBuffer.length > 100) logBuffer.shift();
    chrome.storage.local.set({ logBuffer });
    // Для popup: если открыт, отправим обновление (безопасно)
    try {
        chrome.runtime.sendMessage({ action: "logUpdate", log: logBuffer }, () => {
                // игнорируем ошибки, когда нет получателя
            if (chrome.runtime.lastError) {
                // нет получателя (popup закрыт) — это нормально
            }
        });
    } catch (e) {
        // игнорируем
    }
}

// Вспомогательная функция для безопасной отправки runtime-сообщений из background
function safeRuntimeSendMessage(message, callback) {
    try {
        chrome.runtime.sendMessage(message, (resp) => {
            if (chrome.runtime.lastError) {
                // нет получателя или другая ошибка
                if (typeof callback === 'function') callback(undefined, chrome.runtime.lastError);
                return;
            }
            if (typeof callback === 'function') callback(resp, null);
        });
    } catch (err) {
        if (typeof callback === 'function') callback(undefined, err);
    }
}

function setActiveTabId(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            activeTabId = tabs[0].id;
            cb && cb();
        } else {
            log("Активная вкладка не найдена.");
        }
    });
}

function parseTimeToSeconds(val) {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
        // поддержка формата часы.минуты.секунды и часы.минуты,секунды
        let parts = val.split(/[.,]/).map(Number);
        let h = parts[0] || 0, m = parts[1] || 0, s = parts[2] || 0;
        return h * 3600 + m * 60 + s;
    }
    return 0;
}

function ensureStreamWindow(cb) {
    // Проверяем существующее окно; не создаём about:blank заранее — создаём окно с нужной вкладкой в setStreamTab
    if (streamWindowId !== null) {
        chrome.windows.get(streamWindowId, { populate: false }, (win) => {
            if (chrome.runtime.lastError || !win) {
                // окно закрыто
                streamWindowId = null;
            }
            cb && cb();
        });
    } else {
        // еще не создано, просто вызываем callback и позволяем setStreamTab создать окно с нужной вкладкой
        cb && cb();
    }
}

function setStreamTab(url, cb) {
    // Убедиться, что у нас есть выделенное окно для стримов и создать/обновить в нём одну вкладку
    ensureStreamWindow(() => {
    // Если окна ещё нет — создаём новое окно сразу с URL стрима (чтобы не оставлять about:blank)
        if (!streamWindowId) {
            chrome.windows.create({ url, focused: false }, (w) => {
                streamWindowId = w.id;
                // пытаемся получить id вкладки из созданного окна (первая вкладка)
                try {
                    if (w && w.tabs && w.tabs[0]) streamTabId = w.tabs[0].id;
                } catch (e) {}
                currentStreamInfo = { url, secondsLeft: 0 };
                cb && cb();
            });
            return;
        }

        if (streamTabId !== null) {
            chrome.tabs.get(streamTabId, tab => {
                if (chrome.runtime.lastError || !tab) {
                    // вкладка исчезла — создаём новую во вкладке streamWindow и делаем её активной в этом окне
                    chrome.tabs.create({ windowId: streamWindowId, url, active: true }, tab => {
                        streamTabId = tab.id;
                        currentStreamInfo = { url, secondsLeft: 0 };
                        cb && cb();
                    });
                } else {
                    // если вкладка есть, но в другом окне, перемещаем её, затем обновляем и делаем активной
                    if (tab.windowId !== streamWindowId) {
                        chrome.tabs.move(streamTabId, { windowId: streamWindowId, index: -1 }, () => {
                            chrome.tabs.update(streamTabId, { url, active: true }, () => cb && cb());
                        });
                    } else {
                        chrome.tabs.update(streamTabId, { url, active: true }, (updatedTab) => {
                            currentStreamInfo = { url, secondsLeft: 0 };
                            cb && cb();
                        });
                    }
                }
            });
        } else {
            // В streamWindow ещё нет отслеживаемой вкладки — создаём её и делаем активной
            chrome.tabs.create({ windowId: streamWindowId, url, active: true }, tab => {
                streamTabId = tab.id;
                currentStreamInfo = { url, secondsLeft: 0 };
                cb && cb();
            });
        }
    });
}

// Поддерживаем currentStreamInfo в актуальном состоянии при навигации или загрузке вкладки со стримом
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId === streamTabId) {
        try {
                if (changeInfo.url) {
                currentStreamInfo = { url: changeInfo.url, secondsLeft: currentStreamInfo.secondsLeft || 0 };
                log(`DEBUG: обновлён URL вкладки со стримом -> ${changeInfo.url}`);
            }
            if (changeInfo.status === 'complete') {
                // Обновляем информацию, чтобы popup отображал актуальные данные до любых проверок
                currentStreamInfo = { url: tab.url || currentStreamInfo.url, secondsLeft: currentStreamInfo.secondsLeft || 0 };
                log(`DEBUG: загрузка вкладки со стримом завершена -> ${currentStreamInfo.url}`);
            }
        } catch (e) {
            // игнорируем
        }
    }
});

function switchToTab(tabId, cb) {
    chrome.tabs.update(tabId, { active: true }, cb);
}

function startWatching(config) {
    if (!config.channels || !Array.isArray(config.channels) || config.channels.length === 0) {
        log("В конфиге нет каналов!");
        return;
    }
    // channels теперь НЕ фильтруем по blacklist, чтобы всегда иметь полный список для динамической проверки
    channels = config.channels
        .map(ch =>
            typeof ch === "string"
                ? { url: ch, watchTime: parseTimeToSeconds(config.watchTime), waitBeforeCheck: config.waitBeforeCheck }
                : {
                    url: ch.url,
                    watchTime: parseTimeToSeconds(ch.watchTime || config.watchTime),
                    waitBeforeCheck: ch.waitBeforeCheck !== undefined ? ch.waitBeforeCheck : config.waitBeforeCheck
                }
        );
    searchUrlPart = config.searchUrlPart || "";
    defaultWatchTime = parseTimeToSeconds(config.watchTime) || 30;
    defaultWaitBeforeCheck = config.waitBeforeCheck || 5;
    isRunning = true;
    currentChannelIndex = 0;
    log("Запуск просмотра каналов...");
    startBlacklistAutoUnlock(); // запуск авторазблокировки при старте
    watchNextChannel();
}

function cleanupBlacklist(config, cb) {
    // Удаляем из blacklist те каналы, у которых истекло время блокировки (но не "permanent")
    if (!config || typeof config.blacklist !== "object") {
        if (cb) cb(config);
        return;
    }
    const now = Date.now();
    let changed = false;
    for (const url in config.blacklist) {
        if (typeof config.blacklist[url] === "number" && config.blacklist[url] && now >= config.blacklist[url]) {
            delete config.blacklist[url];
            changed = true;
        }
        // permanent не удаляем автоматически
    }
    if (changed) {
        chrome.storage.local.set({ userConfig: config }, () => {
            if (cb) cb(config);
        });
    } else {
        if (cb) cb(config);
    }
}

function cleanupBlacklistByWatched(config, totalWatched) {
    if (!config || typeof config.blacklist !== "object") return false;
    let changed = false;
    for (const url in config.blacklist) {
        // Получаем watchTime для этого канала
        let channel = (config.channels || []).find(
            ch => (typeof ch === "string" ? ch : ch.url) === url
        );
        let watchTime = 0;
        if (channel) {
            watchTime = typeof channel === "string"
                ? parseTimeToSeconds(config.watchTime)
                : parseTimeToSeconds(channel.watchTime || config.watchTime);
        }
        const watched = totalWatched && totalWatched[url] ? totalWatched[url] : 0;
        if (watchTime > 0 && watched >= watchTime) {
            delete config.blacklist[url];
            changed = true;
            log(`Канал ${url} автоматически удалён из черного списка (достигнуто время просмотра).`);
        }
    }
    return changed;
}

function closeStreamTabIfExists(cb) {
    if (streamTabId !== null) {
        chrome.tabs.get(streamTabId, tab => {
            if (!chrome.runtime.lastError && tab) {
                chrome.tabs.remove(streamTabId, () => {
                    streamTabId = null;
                    // если в streamWindow больше нет вкладок — оставляем окно и переводим его на about:blank
                    try {
                        chrome.windows.get(streamWindowId, { populate: true }, (w) => {
                            if (!chrome.runtime.lastError && w && w.tabs && w.tabs.length === 0) {
                                // оставляем окно, но сбрасываем содержимое на about:blank
                                chrome.windows.update(streamWindowId, { focused: false }, () => {});
                            }
                        });
                    } catch (e) {}
                    cb && cb();
                });
            } else {
                streamTabId = null;
                cb && cb();
            }
        });
    } else {
        cb && cb();
    }
}

let waitForActiveInterval = null;

function waitForActiveChannels() {
    if (waitForActiveInterval) return; // уже ждем
    log("Ожидание появления активных каналов...");
    waitForActiveInterval = setInterval(() => {
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            let config = data.userConfig;
            if (!config || !Array.isArray(config.channels) || config.channels.length === 0) return;
            if (typeof config.blacklist !== "object") config.blacklist = {};
            const totalWatched = data.totalWatched || {};
            // Очищаем blacklist по времени блокировки
            cleanupBlacklist(config, (cleanedConfig) => {
                const blacklist = cleanedConfig.blacklist;
                let hasActive = false;
                for (const ch of config.channels) {
                    const url = typeof ch === "string" ? ch : ch.url;
                    if (!blacklist[url]) {
                        hasActive = true;
                        break;
                    }
                }
                if (hasActive) {
                    clearInterval(waitForActiveInterval);
                    waitForActiveInterval = null;
                    log("Появился активный канал, продолжаем просмотр.");
                    watchNextChannel();
                }
            });
        });
    }, 5000); // проверяем каждые 5 секунд
}

function watchNextChannel() {
    if (!isRunning) return;
    if (channels.length === 0) {
        log("Список каналов пуст.");
        return;
    }

    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        let config = data.userConfig;
        if (typeof config?.blacklist !== "object") config.blacklist = {};
        const totalWatched = data.totalWatched || {};

        cleanupBlacklist(config, (cleanedConfig) => {
            const blacklist = cleanedConfig.blacklist;
            let checked = 0;
            let foundActive = false;

            while (checked < channels.length) {
                if (currentChannelIndex >= channels.length) currentChannelIndex = 0;
                const { url } = channels[currentChannelIndex];
                if (!blacklist[url]) {
                    foundActive = true;
                    break;
                }
                currentChannelIndex++;
                checked++;
            }

            if (!foundActive) {
                log("Нет активных каналов для просмотра.");
                closeStreamTabIfExists(() => {
                    waitForActiveChannels();
                });
                return;
            }

            // Если был режим ожидания, выключаем его
            if (waitForActiveInterval) {
                clearInterval(waitForActiveInterval);
                waitForActiveInterval = null;
            }

            const { url, watchTime, waitBeforeCheck } = channels[currentChannelIndex];
            const maxAttempts = typeof cleanedConfig.maxAttempts === "number" ? cleanedConfig.maxAttempts : 3;
            log(`Переход на канал: ${url}`);
            setStreamTab(url, () => {
                const waitSec = waitBeforeCheck !== undefined ? waitBeforeCheck : defaultWaitBeforeCheck;
                log(`Ждем ${waitSec} сек. перед проверкой ссылки...`);
                // очищаем любые ранее запланированные проверки
                if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
                scheduledCheckTimeout = setTimeout(() => {
                    scheduledCheckTimeout = null;
                    checkChannel(streamTabId, url, watchTime || defaultWatchTime, 1, maxAttempts);
                }, waitSec * 1000);
            });
        });
    });
}

function checkChannel(tabId, url, watchTime, attempt = 1, maxAttempts = 3) {
    if (!isRunning) return;
    if (attempt === 1) {
        // Сохраняем текущую активную вкладку пользователя и переключаемся на стрим только один раз
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            userPrevTabId = tabs[0] ? tabs[0].id : null;
            switchToTab(tabId, () => {
                if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
                pendingDoFindTimeout = setTimeout(() => {
                    pendingDoFindTimeout = null;
                    doFindLink(tabId, url, watchTime, attempt, maxAttempts);
                }, 1500);
            });
        });
    } else {
        // Уже на вкладке со стримом, просто пробуем снова
        if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
        pendingDoFindTimeout = setTimeout(() => {
            pendingDoFindTimeout = null;
            doFindLink(tabId, url, watchTime, attempt, maxAttempts);
        }, 1000);
    }
}

// Заменяем вызов chrome.tabs.sendMessage на safeSendMessage в doFindLink
function doFindLink(tabId, url, watchTime, attempt, maxAttempts, onResult) {
    log(`Проверка наличия ссылки "${searchUrlPart}"... (попытка ${attempt})`);
        safeSendMessage(tabId, { action: "findLink", text: searchUrlPart }, (response) => {
            // Логируем сырой ответ для диагностики
            log(`DEBUG: doFindLink raw response -> ${response ? JSON.stringify(response) : 'undefined'}`);

            // Вычисляем pageMatches заранее, чтобы и onResult получил корректную информацию
            let pageMatches = true;
            let debugExpected = null;
            let debugActual = null;
            if (response) {
                try {
                    const expected = new URL(url);
                    const expHost = (expected.host || '').toLowerCase();
                    const normalize = (p) => (p || '').replace(/^\/+|\/+$/g, '').toLowerCase();
                    const expFirst = normalize(expected.pathname).split('/')[0] || '';

                    let actualHost = '';
                    let actualPath = '';
                    if (response.pageHost) {
                        actualHost = String(response.pageHost).toLowerCase();
                    } else if (response.pageUrl) {
                        try { actualHost = new URL(response.pageUrl).host.toLowerCase(); } catch (e) { actualHost = ''; }
                    }
                    if (response.pagePathname) {
                        actualPath = String(response.pagePathname);
                    } else if (response.pageUrl) {
                        try { actualPath = new URL(response.pageUrl).pathname; } catch (e) { actualPath = ''; }
                    }
                    const actFirst = normalize(actualPath).split('/')[0] || '';

                    debugExpected = { expHost, expFirst };
                    debugActual = { actualHost, actFirst };

                    if (expHost !== (actualHost || '').toLowerCase() || (expFirst && expFirst !== actFirst)) {
                        pageMatches = false;
                    }
                } catch (e) {
                    log(`DEBUG: doFindLink parse error -> ${e}`);
                    pageMatches = true;
                }
            }

            // Если вызван onResult (периодический чек) — отдадим расширенный ответ и вернёмся
            if (typeof onResult === "function") {
                const augmented = Object.assign({}, response || {}, { pageMatches, debugExpected, debugActual });
                log(`DEBUG: doFindLink onResult augmented -> ${JSON.stringify(augmented)}`);
                onResult(augmented);
                return;
            }

            if (!response) {
                log("Ошибка при поиске ссылки (контент-скрипт не найден).");
                if (attempt >= maxAttempts && userPrevTabId && userPrevTabId !== tabId) {
                    switchToTab(userPrevTabId);
                }
                if (attempt >= maxAttempts) {
                    addToBlacklist(url);
                }
                nextChannel();
                return;
            }

            log(`DEBUG: doFindLink check -> found=${response.found} streamerOnline=${response.streamerOnline} pageMatches=${pageMatches} expected=${JSON.stringify(debugExpected)} actual=${JSON.stringify(debugActual)}`);

            // Проверяем статус онлайна ПЕРВЫМ
            if (response && response.streamerOnline === false) {
                log(`ОШИБКА: Стример ОФЛАЙН на ${url}! Проверка не может продолжиться.`);
                if (attempt >= maxAttempts && userPrevTabId && userPrevTabId !== tabId) {
                    switchToTab(userPrevTabId);
                }
                if (attempt >= maxAttempts) {
                    addToBlacklist(url);
                }
                nextChannel();
                return;
            }

            if (response && response.found && pageMatches) {
                log(`Ссылка найдена на ${url}. Остаемся на странице ${watchTime} сек.`);
                if (userPrevTabId && userPrevTabId !== tabId) {
                    switchToTab(userPrevTabId);
                }
                startWatchTimer(tabId, url, watchTime);
            } else {
                if (response && response.found && !pageMatches) {
                    log(`Найденная ссылка относится к другой странице (${response.pageUrl}). Ожидается ${url}. Считаем попытку неудачной.`);
                    log(`DEBUG: mismatch expected=${JSON.stringify(debugExpected)} actual=${JSON.stringify(debugActual)}`);
                } else if (!response.found) {
                    log(`Ссылка не найдена (response.found === false).`);
                }

                if (attempt < maxAttempts) {
                    log(`Ссылка не найдена или неправильный стрим, повторная попытка... (попытка ${attempt + 1})`);
                    checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
                } else {
                    log(`Ссылка не найдена на ${url} после ${maxAttempts} попыток или мы на другом стриме. Канал будет добавлен в черный список. Переходим к следующему каналу.`);
                    if (userPrevTabId && userPrevTabId !== tabId) {
                        switchToTab(userPrevTabId);
                    }
                    addToBlacklist(url);
                    nextChannel();
                }
            }
        });
}

// Модифицированная функция addToBlacklist с поддержкой customDurationSeconds
function addToBlacklist(url, customDurationSeconds) {
    chrome.storage.local.get("userConfig", (data) => {
        let config = data.userConfig;
        if (!config) return;
        if (typeof config.blacklist !== "object" || Array.isArray(config.blacklist)) config.blacklist = {};
        // Получаем watchTime для этого канала
        let channel = (config.channels || []).find(
            ch => (typeof ch === "string" ? ch : ch.url) === url
        );
        let watchTime = 0;
        if (channel) {
            watchTime = typeof channel === "string"
                ? parseTimeToSeconds(config.watchTime)
                : parseTimeToSeconds(channel.watchTime || config.watchTime);
        }
        // Получаем общее время временного ЧС из конфига (часы.минуты,секунды)
        let tempBlacklistSeconds = 60;
        if (typeof config.tempBlacklistSeconds === "number") {
            tempBlacklistSeconds = config.tempBlacklistSeconds;
        } else if (typeof config.tempBlacklistSeconds === "string") {
            tempBlacklistSeconds = parseTimeToSeconds(config.tempBlacklistSeconds);
        }
        // Если передан customDurationSeconds — используем его
        if (typeof customDurationSeconds === "number" && customDurationSeconds > 0) {
            tempBlacklistSeconds = customDurationSeconds;
        }
        // Если уже просмотрено достаточно — делаем permanent
        if (totalWatched[url] && watchTime > 0 && totalWatched[url] >= watchTime) {
            config.blacklist[url] = "permanent";
            chrome.storage.local.set({ userConfig: config }, () => {
                log(`Канал ${url} навсегда добавлен в черный список (достигнуто время просмотра).`);
            });
        } else {
            // Ставим время разблокировки по customDurationSeconds или общей константе
            const until = Date.now() + tempBlacklistSeconds * 1000;
            config.blacklist[url] = until;
            chrome.storage.local.set({ userConfig: config }, () => {
                log(`Канал ${url} добавлен в черный список до ${new Date(until).toLocaleTimeString()} (блокировка на ${Math.round(tempBlacklistSeconds/60)} мин).`);
            });
        }
    });
}

function autoRemoveFromBlacklistIfWatchedEnough(url, config) {
    // Получаем watchTime для этого канала
    let channel = (config.channels || []).find(
        ch => (typeof ch === "string" ? ch : ch.url) === url
    );
    let watchTime = 0;
    if (channel) {
        watchTime = typeof channel === "string"
            ? parseTimeToSeconds(config.watchTime)
            : parseTimeToSeconds(channel.watchTime || config.watchTime);
    }
    chrome.storage.local.get("totalWatched", (data) => {
        const watched = data.totalWatched && data.totalWatched[url] ? data.totalWatched[url] : 0;
        if (watchTime > 0 && watched >= watchTime) {
            if (userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            startWatchTimer(tabId, url, watchTime);
        } else if (attempt < maxAttempts) {
            log(`Ссылка не найдена, повторная попытка...`);
            checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
        } else {
            log(`Ссылка не найдена на ${url} после ${maxAttempts} попыток. Канал будет добавлен в черный список. Переходим к следующему каналу.`);
            // После всех попыток возвращаем пользователя на его вкладку
            if (userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            addToBlacklist(url);
            nextChannel();
        }
    });
}

function startWatchTimer(tabId, url, watchTime) {
    // Инвалидируем предыдущий запуск и увеличиваем runId для этой сессии просмотра
    const myRunId = ++currentRunId;
    // вычисляем оставшиеся секунды с учётом уже просмотренного времени
    const alreadyWatched = totalWatched[url] || 0;
    let secondsLeft = Math.max(0, watchTime - alreadyWatched);
    currentStreamInfo = { url, secondsLeft };
    log(`DEBUG: startWatchTimer for ${url}, watchTime=${watchTime}, runId=${myRunId}`);
    let timerStopped = false;
    let linkCheckInterval = null;
    let checkIntervalMs = 2 * 60 * 1000; // по умолчанию 2 минуты

    // Получаем интервал из конфига
    chrome.storage.local.get("userConfig", (data) => {
        let config = data.userConfig;
        if (config && typeof config.checkIntervalMinutes === "number" && config.checkIntervalMinutes > 0) {
            checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
        }

        // Очищаем предыдущие таймеры (если были) чтобы избежать параллельных интервалов
        if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
        if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }

        // Запускаем основной таймер просмотра (каждую секунду)
        watchTimerInterval = setInterval(() => {
            // Защитная проверка: если runId изменился, этот таймер устарел — останавливаем его
            if (myRunId !== currentRunId) {
                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                return;
            }
            if (!isRunning || timerStopped) {
                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                currentStreamInfo = { url: null, secondsLeft: 0 };
                return;
            }

            // Получаем текущий URL вкладки и выполняем проверку внутри callback, чтобы избежать демонтирования try/catch вокруг асинхронного кода
            try {
                chrome.tabs.get(streamTabId, (tab) => {
                    try {
                        const actualUrl = tab && tab.url ? tab.url : '';
                        let mismatch = false;
                        try {
                            const expectedObj = new URL(url);
                            const normalize = (p) => (p || '').replace(/^\/+|\/+$/g, '').toLowerCase();
                            const expFirst = normalize(expectedObj.pathname).split('/')[0] || '';
                            let actFirst = '';
                            let actHost = '';
                            if (actualUrl) {
                                try {
                                    const actualObj = new URL(actualUrl, expectedObj.origin);
                                    actFirst = normalize(actualObj.pathname).split('/')[0] || '';
                                    actHost = (actualObj.host || '').toLowerCase();
                                } catch (e) {
                                    actFirst = '';
                                    actHost = '';
                                }
                            }
                            const expHost = (expectedObj.host || '').toLowerCase();
                            // считаем mismatch, если host или первый сегмент пути не совпадают
                            if (expHost !== actHost || (expFirst && expFirst !== actFirst)) {
                                mismatch = true;
                            }
                        } catch (e) {
                            // парсинг упал — не блокируем
                            mismatch = false;
                        }

                        if (mismatch) {
                            log(`DEBUG: tab URL mismatch during watch for ${url} -> actual=${actualUrl}. Stopping watch.`);
                            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                            timerStopped = true;
                            currentStreamInfo = { url: null, secondsLeft: 0 };
                            // Добавляем канал в ЧС на время просмотра
                            addToBlacklist(url, watchTime);
                            // невалидируем любые другие таймеры перед переходом к следующему, чтобы избежать гонок
                            currentRunId++;
                            nextChannel();
                            return;
                        }

                        // Если совпадает — продолжаем инкремент
                        secondsLeft--;
                        currentStreamInfo = { url, secondsLeft };
                        if (!totalWatched[url]) totalWatched[url] = 0;
                        totalWatched[url]++;
                        // диагностический лог для каждого увеличения
                        log(`DEBUG: incremented watched for ${url} -> ${totalWatched[url]}s (secondsLeft=${secondsLeft}) runId=${myRunId}`);
                        // Сохраняем totalWatched немедленно
                        chrome.storage.local.set({ totalWatched }, () => {
                            // После сохранения проверяем, достигли ли мы установленного времени просмотра, и помечаем как постоянный
                            if (watchTime > 0 && totalWatched[url] >= watchTime) {
                                if (config && typeof config.blacklist === 'object') {
                                    if (config.blacklist[url] !== 'permanent') {
                                        config.blacklist[url] = 'permanent';
                                        chrome.storage.local.set({ userConfig: config }, () => {
                                            log(`Канал ${url} навсегда добавлен в черный список (достигнуто время просмотра).`);
                                            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                                            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                                            timerStopped = true;
                                            currentStreamInfo = { url: null, secondsLeft: 0 };
                                            log(`Время на ${url} истекло (лимит достигнут).`);
                                            nextChannel();
                                        });
                                        return;
                                    }
                                }
                            }
                            // Если не достигнуто или уже обработано, если secondsLeft достиг нуля, то переходим к следующему
                            if (secondsLeft <= 0) {
                                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                                timerStopped = true;
                                currentStreamInfo = { url: null, secondsLeft: 0 };
                                log(`Время на ${url} истекло.`);
                                nextChannel();
                            }
                        });
                    } catch (e) {
                        // fallback внутри callback: если что-то упало при обработке tab — выполним инкремент без проверки вкладки
                        secondsLeft--;
                        currentStreamInfo = { url, secondsLeft };
                        if (!totalWatched[url]) totalWatched[url] = 0;
                        totalWatched[url]++;
                        log(`DEBUG: incremented watched for ${url} -> ${totalWatched[url]}s (secondsLeft=${secondsLeft}) runId=${myRunId} (fallback)`);
                        chrome.storage.local.set({ totalWatched }, () => {
                            if (watchTime > 0 && totalWatched[url] >= watchTime) {
                                if (config && typeof config.blacklist === 'object') {
                                    if (config.blacklist[url] !== 'permanent') {
                                        config.blacklist[url] = 'permanent';
                                        chrome.storage.local.set({ userConfig: config }, () => {
                                            log(`Канал ${url} навсегда добавлен в черный список (достигнуто время просмотра).`);
                                            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                                            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                                            timerStopped = true;
                                            currentStreamInfo = { url: null, secondsLeft: 0 };
                                            log(`Время на ${url} истекло (лимит достигнут).`);
                                            nextChannel();
                                        });
                                        return;
                                    }
                                }
                            }
                            if (secondsLeft <= 0) {
                                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                                timerStopped = true;
                                currentStreamInfo = { url: null, secondsLeft: 0 };
                                log(`Время на ${url} истекло.`);
                                nextChannel();
                            }
                        });
                    }
                });
            } catch (e) {
                // если chrome.tabs.get вызов упал синхронно (маловероятно) — просто выполним инкремент как fallback
                secondsLeft--;
                currentStreamInfo = { url, secondsLeft };
                if (!totalWatched[url]) totalWatched[url] = 0;
                totalWatched[url]++;
                log(`DEBUG: incremented watched for ${url} -> ${totalWatched[url]}s (secondsLeft=${secondsLeft}) runId=${myRunId} (sync-fallback)`);
                chrome.storage.local.set({ totalWatched }, () => {
                    if (watchTime > 0 && totalWatched[url] >= watchTime) {
                        if (config && typeof config.blacklist === 'object') {
                            if (config.blacklist[url] !== 'permanent') {
                                config.blacklist[url] = 'permanent';
                                chrome.storage.local.set({ userConfig: config }, () => {
                                    log(`Канал ${url} навсегда добавлен в черный список (достигнуто время просмотра).`);
                                    if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                                    if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                                    timerStopped = true;
                                    currentStreamInfo = { url: null, secondsLeft: 0 };
                                    log(`Время на ${url} истекло (лимит достигнут).`);
                                    nextChannel();
                                });
                                return;
                            }
                        }
                    }
                    if (secondsLeft <= 0) {
                        if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                        if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                        timerStopped = true;
                        currentStreamInfo = { url: null, secondsLeft: 0 };
                        log(`Время на ${url} истекло.`);
                        nextChannel();
                    }
                });
            }
        }, 1000);

        // Запускаем периодическую проверку наличия ссылки
        watchLinkCheckInterval = setInterval(() => {
            // защита: остановить, если выполнение недействительно
            if (myRunId !== currentRunId) {
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                return;
            }
            if (!isRunning || timerStopped) {
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                return;
            }
            // Получаем searchUrlPart из конфига
            chrome.storage.local.get("userConfig", (data) => {
                let config = data.userConfig;
                let searchUrlPart = config && config.searchUrlPart ? config.searchUrlPart : "";
                // Используем doFindLink для проверки
                doFindLink(tabId, url, watchTime, 1, 1, (response) => {
                    // now response is augmented with pageMatches/debugExpected/debugActual when available
                    log(`DEBUG: periodic doFindLink -> ${response ? JSON.stringify(response) : 'undefined'}`);
                    
                    // КРИТИЧНО: проверяем статус онлайна стримера
                    const isOnline = response && response.streamerOnline !== false;
                    const linkFound = response && response.found;
                    const pageMatchesOk = response && response.pageMatches !== false;
                    
                    if (!isOnline) {
                        log(`ОШИБКА: Стример ОФЛАЙН! Досрочно завершаем просмотр ${url}.`);
                        if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                        if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                        timerStopped = true;
                        currentStreamInfo = { url: null, secondsLeft: 0 };
                        // Добавляем канал в ЧС на время просмотра (стример был офлайн)
                        addToBlacklist(url, watchTime);
                        // невалидируем любые другие таймеры перед переходом к следующему, чтобы избежать гонок
                        currentRunId++;
                        nextChannel();
                        return;
                    }
                    
                    if (!linkFound || !pageMatchesOk) {
                        log(`Ссылка '${searchUrlPart}' пропала или мы на другом стриме (${!pageMatchesOk ? 'mismatch' : 'not found'}). Досрочно завершаем просмотр ${url}.`);
                        if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                        if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                        timerStopped = true;
                        currentStreamInfo = { url: null, secondsLeft: 0 };
                        // Добавляем канал в ЧС на время просмотра
                        addToBlacklist(url, watchTime);
                        // невалидируем любые другие таймеры перед переходом к следующему, чтобы избежать гонок
                        currentRunId++;
                        nextChannel();
                    }
                });
            });
        }, checkIntervalMs);
    });
}

function nextChannel() {
    // невалидируем текущий запуск, чтобы любые устаревшие таймеры немедленно завершились
    currentRunId++;
    if (timerInterval) clearInterval(timerInterval);
    log(`DEBUG: nextChannel called (from index ${currentChannelIndex}) runId=${currentRunId}`);
    currentChannelIndex++;
    log(`DEBUG: new currentChannelIndex = ${currentChannelIndex}`);
    if (isRunning) watchNextChannel();
}

function stopWatching() {
    // Остановить весь процесс просмотра: таймеры, планировщики и состояние
    isRunning = false;
    // невалидируем текущий запуск — это заставит устаревшие таймеры корректно завершиться
    currentRunId++;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
    if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
    if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
    if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
    if (waitForActiveInterval) { clearInterval(waitForActiveInterval); waitForActiveInterval = null; }
    if (blacklistAutoUnlockInterval) { clearInterval(blacklistAutoUnlockInterval); blacklistAutoUnlockInterval = null; }
    // Сбрасываем state, чтобы последующие операции не считали, что вкладка/окно все ещё открыты
    streamTabId = null;
    streamWindowId = null;
    userPrevTabId = null;
    currentStreamInfo = { url: null, secondsLeft: 0 };
    log("Просмотр остановлен.");
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startWatching") {
        // Получаем config только из userConfig (только вручную загруженный)
        chrome.storage.local.get("userConfig", (data) => {
            let config = data.userConfig;
            if (!config) {
                log("Сначала загрузите конфиг вручную через интерфейс!");
                return;
            }
            setActiveTabId(() => startWatching(config));
        });
    }
    if (request.action === "stopWatching") {
        stopWatching();
    }
    if (request.action === "getLog") {
        sendResponse({ log: logBuffer });
    }
    if (request.action === "getIsRunning") {
        sendResponse({ isRunning });
    }
    if (request.action === "saveSearch") {
        chrome.storage.local.set({ lastSearch: request.text });
    }
    // Приём диагностических отчётов из content scripts
    if (request.action === 'diagnosticReport' && request.report) {
        try {
            const rpt = request.report;
            // Сохраняем в storage diagnostics (ограничим до 50 записей)
            chrome.storage.local.get('diagnostics', (data) => {
                const arr = Array.isArray(data.diagnostics) ? data.diagnostics : [];
                arr.push(rpt);
                while (arr.length > 50) arr.shift();
                chrome.storage.local.set({ diagnostics: arr });
            });
            log(`DIAG: ${rpt.pageHost} ${rpt.pageUrl} online=${rpt.streamerOnline} hasVideo=${rpt.hasVideo} liveBadge=${rpt.liveBadge}`);
        } catch (e) {
            log('Ошибка при обработке diagnosticReport: ' + String(e));
        }
    }
    if (request.action === "getStats") {
        sendResponse({ stats: totalWatched });
    }
    if (request.action === "getCurrentStreamInfo") {
        // возвращаем актуальную информацию о текущем потоке, вычисляя оставшиеся секунды из сохраненного totalWatched
        const cur = currentStreamInfo && currentStreamInfo.url ? currentStreamInfo : null;
        if (!cur || !cur.url) {
            sendResponse({ url: null, secondsLeft: 0 });
            return;
        }
        // Читаем сохраненный totalWatched и userConfig, чтобы вычислить точное оставшееся время
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const cfg = data.userConfig || {};
            const persisted = data.totalWatched || {};
            const url = cur.url;
            // ищем целевое время просмотра для этого url
            let targetSec = 0;
            const channel = (cfg.channels || []).find(ch => (typeof ch === 'string' ? ch : ch.url) === url);
            if (channel) {
                targetSec = typeof channel === 'string' ? parseTimeToSeconds(cfg.watchTime) : parseTimeToSeconds(channel.watchTime || cfg.watchTime);
            } else {
                targetSec = parseTimeToSeconds(cfg.watchTime) || defaultWatchTime;
            }
            const watched = persisted[url] || 0;
            const remaining = Math.max(0, targetSec - watched);
            sendResponse({ url, secondsLeft: remaining, watched, targetSec });
        });
        return true;
    }
    if (request.action === "switchToChannel" && request.url) {
        // немедленно переключаем вкладку потока на предоставленный url и, если запущено, начинаем его проверку
        chrome.storage.local.get("userConfig", (data) => {
            const cfg = data.userConfig || {};
            const ch = (cfg.channels || []).find(c => (typeof c === 'string' ? c : c.url) === request.url);
            const wt = ch ? (typeof ch === 'string' ? parseTimeToSeconds(cfg.watchTime) : parseTimeToSeconds((typeof ch === 'string' ? {} : ch).watchTime || cfg.watchTime)) : defaultWatchTime;
            const waitSec = (ch && typeof ch === 'object' && ch.waitBeforeCheck !== undefined) ? ch.waitBeforeCheck : (cfg.waitBeforeCheck !== undefined ? cfg.waitBeforeCheck : defaultWaitBeforeCheck);
            const maxAttempts = (cfg && typeof cfg.maxAttempts === 'number') ? cfg.maxAttempts : 3;
            setStreamTab(request.url, () => {
                // невалидируем текущий запуск и очищаем предыдущие таймеры/временные интервалы, чтобы избежать неправильной атрибуции
                currentRunId++;
                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
                if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
                // вычисляем оставшиеся секунды, чтобы всплывающее окно показывало точное оставшееся время
                const watchedForSwitch = totalWatched[request.url] || 0;
                const remainingForSwitch = Math.max(0, wt - watchedForSwitch);
                currentStreamInfo = { url: request.url, secondsLeft: remainingForSwitch };
                if (isRunning) {
                    // выполняем тот же поток проверки, что и watchNextChannel для этого канала
                    setTimeout(() => {
                        checkChannel(streamTabId, request.url, wt, 1, maxAttempts);
                    }, (waitSec || defaultWaitBeforeCheck) * 1000);
                }
                sendResponse({ ok: true });
            });
        });
        return true; // async
    }
    if (request.action === "getWatchPercent" && request.url) {
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const config = data.userConfig || {};
            const totalWatched = data.totalWatched || {};
            const url = request.url;
            let targetSec = 0;
            const channel = (config.channels || []).find(ch => (typeof ch === 'string' ? ch : ch.url) === url);
            if (channel) {
                targetSec = typeof channel === 'string' ? parseTimeToSeconds(config.watchTime) : parseTimeToSeconds(channel.watchTime || config.watchTime);
            } else {
                targetSec = parseTimeToSeconds(config.watchTime) || defaultWatchTime;
            }
            const watched = totalWatched[url] || 0;
            const percent = targetSec > 0 ? Math.min(100, Math.round((watched / targetSec) * 100)) : 0;
            sendResponse({ percent, watched, targetSec });
        });
        return true;
    }
    if (request.action === "openStreamWindow") {
        ensureStreamWindow(() => sendResponse({ ok: true, windowId: streamWindowId }));
        return true;
    }
    if (request.action === "manualNext") {
        // переключиться на следующий активный канал
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const config = data.userConfig || {};
            const cfgChannels = Array.isArray(config.channels) ? config.channels : [];
            if (cfgChannels.length === 0) { sendResponse({ ok: false, reason: 'no channels' }); return; }
            // нормализуем каналы в объекты
            const chs = cfgChannels.map(ch => typeof ch === 'string' ? { url: ch } : ch);
            // находим следующий, который не в черном списке
            let start = currentChannelIndex + 1;
            let found = -1;
            for (let i = 0; i < chs.length; i++) {
                const idx = (start + i) % chs.length;
                const url = chs[idx].url;
                const black = config.blacklist && config.blacklist[url];
                if (!black) { found = idx; break; }
            }
            if (found === -1) { sendResponse({ ok: false, reason: 'no active channels' }); return; }
            currentChannelIndex = found;
            const sel = chs[found];
            const wt = sel.watchTime ? parseTimeToSeconds(sel.watchTime) : (config.watchTime ? parseTimeToSeconds(config.watchTime) : defaultWatchTime);
            const waitSec = sel.waitBeforeCheck !== undefined ? sel.waitBeforeCheck : (config.waitBeforeCheck !== undefined ? config.waitBeforeCheck : defaultWaitBeforeCheck);
            const maxAttempts = (config && typeof config.maxAttempts === 'number') ? config.maxAttempts : 3;
            // невалидируем текущий запуск и очищаем предыдущие таймеры/временные интервалы, чтобы избежать неправильной атрибуции
            currentRunId++;
            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
            if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
            if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
            setStreamTab(sel.url, () => {
                // выполняем ту же проверку, что и watchNextChannel для этого канала
                // Обновляем currentStreamInfo немедленно, чтобы всплывающее окно показывало новое выделение (оставшееся время)
                const watchedForSel = totalWatched[sel.url] || 0;
                const remainingForSel = Math.max(0, wt - watchedForSel);
                currentStreamInfo = { url: sel.url, secondsLeft: remainingForSel };
                scheduledCheckTimeout = setTimeout(() => {
                    scheduledCheckTimeout = null;
                    checkChannel(streamTabId, sel.url, wt, 1, maxAttempts);
                }, (waitSec || defaultWaitBeforeCheck) * 1000);
                sendResponse({ ok: true, url: sel.url });
            });
        });
        return true;
    }
    if (request.action === "manualPrev") {
        // переключиться на предыдущий активный канал
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const config = data.userConfig || {};
            const cfgChannels = Array.isArray(config.channels) ? config.channels : [];
            if (cfgChannels.length === 0) { sendResponse({ ok: false, reason: 'no channels' }); return; }
            const chs = cfgChannels.map(ch => typeof ch === 'string' ? { url: ch } : ch);
            let start = currentChannelIndex - 1;
            if (start < 0) start = chs.length - 1;
            let found = -1;
            for (let i = 0; i < chs.length; i++) {
                const idx = (start - i + chs.length) % chs.length;
                const url = chs[idx].url;
                const black = config.blacklist && config.blacklist[url];
                if (!black) { found = idx; break; }
            }
            if (found === -1) { sendResponse({ ok: false, reason: 'no active channels' }); return; }
            currentChannelIndex = found;
            const sel = chs[found];
            const wt = sel.watchTime ? parseTimeToSeconds(sel.watchTime) : (config.watchTime ? parseTimeToSeconds(config.watchTime) : defaultWatchTime);
            const waitSec = sel.waitBeforeCheck !== undefined ? sel.waitBeforeCheck : (config.waitBeforeCheck !== undefined ? config.waitBeforeCheck : defaultWaitBeforeCheck);
            const maxAttempts = (config && typeof config.maxAttempts === 'number') ? config.maxAttempts : 3;
            // невалидируем текущий запуск и очищаем предыдущие таймеры/временные интервалы, чтобы избежать неправильной атрибуции
            currentRunId++;
            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
            if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
            if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
            setStreamTab(sel.url, () => {
                // Обновляем currentStreamInfo немедленно, чтобы всплывающее окно показывало новое выделение (оставшееся время)
                const watchedForSelPrev = totalWatched[sel.url] || 0;
                const remainingForSelPrev = Math.max(0, wt - watchedForSelPrev);
                currentStreamInfo = { url: sel.url, secondsLeft: remainingForSelPrev };
                scheduledCheckTimeout = setTimeout(() => {
                    scheduledCheckTimeout = null;
                    checkChannel(streamTabId, sel.url, wt, 1, maxAttempts);
                }, (waitSec || defaultWaitBeforeCheck) * 1000);
                sendResponse({ ok: true, url: sel.url });
            });
        });
        return true;
    }
    if (request.action === "clearLogs") {
        logBuffer = [];
        chrome.storage.local.set({ logBuffer }, () => {
            sendResponse && sendResponse();
        });
        return true; // асинхронный ответ
    }
    if (request.action === "resetWatchTime" && request.url) {
        // Сбрасываем время и сохраняем даже если оно было 0
        totalWatched[request.url] = 0;
        chrome.storage.local.set({ totalWatched }, () => {
            log(`Суммарное время просмотра для ${request.url} сброшено.`);
            if (typeof sendResponse === "function") sendResponse();
        });
        return true; // асинхронный ответ
    }
    if (request.action === "setLoggingEnabled") {
        setLoggingEnabled(!!request.enabled);
        sendResponse && sendResponse({ loggingEnabled });
        return true;
    }
});

// Новый интервал для авторазблокировки каналов по времени
let blacklistAutoUnlockInterval = null;

function startBlacklistAutoUnlock() {
    if (blacklistAutoUnlockInterval) return;
    blacklistAutoUnlockInterval = setInterval(() => {
        chrome.storage.local.get("userConfig", (data) => {
            let config = data.userConfig;
            if (!config || typeof config.blacklist !== "object") return;
            const now = Date.now();
            let changed = false;
            for (const url in config.blacklist) {
                if (typeof config.blacklist[url] === "number" && config.blacklist[url] && now >= config.blacklist[url]) {
                    delete config.blacklist[url];
                    changed = true;
                    log(`Канал ${url} автоматически разблокирован по истечении времени блокировки.`);
                }
            }
            if (changed) {
                chrome.storage.local.set({ userConfig: config }, () => {
                    // Если мы ждали появления активных каналов, сразу пробуем продолжить просмотр
                    if (waitForActiveInterval) {
                        chrome.storage.local.get(["userConfig", "totalWatched"], (data2) => {
                            let config2 = data2.userConfig;
                            if (!config2 || !Array.isArray(config2.channels) || config2.channels.length === 0) return;
                            const blacklist2 = typeof config2.blacklist === "object" ? config2.blacklist : {};
                            let hasActive = false;
                            for (const ch of config2.channels) {
                                const url = typeof ch === "string" ? ch : ch.url;
                                if (!blacklist2[url]) {
                                    hasActive = true;
                                    break;
                                }
                            }
                            if (hasActive) {
                                clearInterval(waitForActiveInterval);
                                waitForActiveInterval = null;
                                log("Появился активный канал, продолжаем просмотр.");
                                watchNextChannel();
                            }
                        });
                    }
                });
            }
        });
    }, 1000); // проверяем каждую секунду
}

// Безопасная отправка сообщений в контент-скрипт
function safeSendMessage(tabId, message, callback) {
    try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                // Не спамим консоль, только если нужно — раскомментировать строку ниже
                // console.warn('Контент-скрипт не найден на вкладке', tabId, chrome.runtime.lastError.message);
                if (callback) callback(undefined);
                return;
            }
            if (callback) callback(response);
        });
    } catch (err) {
        // Не спамим консоль
        if (callback) callback(undefined);
    }
}

// Очистка state при закрытии вкладки/окна
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (tabId === streamTabId) {
        // если была закрыта вкладка со стримом — останавливаем просмотр
        if (isRunning) {
            log(`Stream tab ${tabId} was closed -> stopping watch.`);
            stopWatching();
        } else {
            streamTabId = null;
        }
    }
    if (tabId === activeTabId) {
        activeTabId = null;
    }
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === streamWindowId) {
        // окно со стримом закрыто — прекращаем просмотр
        if (isRunning) {
            log(`Stream window ${windowId} was closed -> stopping watch.`);
            stopWatching();
        } else {
            streamWindowId = null;
            streamTabId = null;
        }
    }
});

let isRunning = false;
let currentChannelIndex = 0;
let timerInterval = null;
let watchTimerInterval = null;
let watchLinkCheckInterval = null;
let channels = [];
let searchUrlPart = "";
let defaultWatchTime = 30;
let defaultWaitBeforeCheck = 5;
let logBuffer = [];
let streamTabId = null; // id вкладки, где крутятся стримы
let streamWindowId = null; // id выделенного окна, где держим вкладку со стримом
let totalWatched = {}; // { url: seconds }
let currentStreamInfo = { url: null, secondsLeft: 0 };
let loggingEnabled = false;
let currentRunId = 0; // маркер запуска
let scheduledCheckTimeout = null;
let pendingDoFindTimeout = null;
let waitForActiveInterval = null;
let blacklistAutoUnlockInterval = null;

// Инициализация и синхронизация состояния из chrome.storage.local
chrome.storage.local.get(["totalWatched", "loggingEnabled", "userConfig", "isRunning", "logBuffer"], (data) => {
    if (data.totalWatched && typeof data.totalWatched === 'object') {
        totalWatched = data.totalWatched;
    }
    if (typeof data.loggingEnabled === 'boolean') {
        loggingEnabled = data.loggingEnabled;
    }
    if (Array.isArray(data.logBuffer)) {
        logBuffer = data.logBuffer;
    }
    if (data.userConfig) {
        syncConfigState(data.userConfig);
    }
    if (data.isRunning) {
        log("Восстановление процесса просмотра после пробуждения Service Worker...");
        if (data.userConfig) {
            startWatching(data.userConfig, true);
        }
    }
});

// Слушатель внешних изменений хранилища (например, из stats.html)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
        if (changes.userConfig && changes.userConfig.newValue) {
            syncConfigState(changes.userConfig.newValue);
            handleUserConfigChanged(changes.userConfig.newValue);
        }
        if (changes.loggingEnabled) {
            loggingEnabled = !!changes.loggingEnabled.newValue;
        }
        if (changes.totalWatched && changes.totalWatched.newValue) {
            totalWatched = changes.totalWatched.newValue;
            handleTotalWatchedChanged(changes.totalWatched.newValue);
        }
    }
});

function syncConfigState(config) {
    if (!config || !Array.isArray(config.channels)) return;
    const mappedChannels = config.channels.map(ch =>
        typeof ch === "string"
            ? { url: ch, watchTime: parseTimeToSeconds(config.watchTime), waitBeforeCheck: config.waitBeforeCheck }
            : {
                url: ch.url,
                watchTime: parseTimeToSeconds(ch.watchTime || config.watchTime),
                waitBeforeCheck: ch.waitBeforeCheck !== undefined ? ch.waitBeforeCheck : config.waitBeforeCheck,
                dropId: ch.dropId || null
            }
    );
    const order = Array.isArray(config.groupOrder) ? config.groupOrder : [];
    channels = applyGroupOrder(mappedChannels, order);
    searchUrlPart = config.searchUrlPart || "";
    defaultWatchTime = parseTimeToSeconds(config.watchTime) || 30;
    defaultWaitBeforeCheck = config.waitBeforeCheck !== undefined ? config.waitBeforeCheck : 5;
}

function setLoggingEnabled(enabled) {
    loggingEnabled = enabled;
    chrome.storage.local.set({ loggingEnabled: enabled });
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
    try {
        chrome.runtime.sendMessage({ action: "logUpdate", log: logBuffer }, () => {
            if (chrome.runtime.lastError) {}
        });
    } catch (e) {}
}

function parseTimeToSeconds(val) {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
        let trimmed = val.trim();
        if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
        let parts = trimmed.split(/[:.,]/).map(Number);
        if (parts.length === 3) {
            return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
        } else if (parts.length === 2) {
            return (parts[0] || 0) * 60 + (parts[1] || 0);
        }
        return parts[0] || 0;
    }
    return 0;
}

function resolveTempBlacklistSeconds(config, customDurationSeconds) {
    if (typeof customDurationSeconds === 'number' && customDurationSeconds > 0) return customDurationSeconds;
    let tempSeconds = 60;
    if (config && typeof config.tempBlacklistSeconds === 'number') {
        tempSeconds = config.tempBlacklistSeconds;
    } else if (config && typeof config.tempBlacklistSeconds === 'string') {
        tempSeconds = parseTimeToSeconds(config.tempBlacklistSeconds);
    }
    return tempSeconds > 0 ? tempSeconds : 60;
}

function applyGroupOrder(items, groupOrder) {
    if (!Array.isArray(items)) return [];
    if (!Array.isArray(groupOrder) || groupOrder.length === 0) return items;
    const byGroup = {};
    const noGroup = [];
    items.forEach(ch => {
        if (ch.dropId) {
            if (!byGroup[ch.dropId]) byGroup[ch.dropId] = [];
            byGroup[ch.dropId].push(ch);
        } else {
            noGroup.push(ch);
        }
    });
    const ordered = [];
    groupOrder.forEach(id => {
        if (byGroup[id]) {
            ordered.push(...byGroup[id]);
            delete byGroup[id];
        }
    });
    Object.values(byGroup).forEach(arr => ordered.push(...arr));
    ordered.push(...noGroup);
    return ordered;
}

function getDropId(url, config) {
    if (!config || !Array.isArray(config.channels)) return null;
    const channel = config.channels.find(ch => {
        const chUrl = typeof ch === 'string' ? ch : ch.url;
        return chUrl === url;
    });
    if (!channel || typeof channel === 'string') return null;
    return channel.dropId || null;
}

function getDropGroupUrls(dropId, config) {
    if (!dropId || !config || !Array.isArray(config.channels)) return [];
    return config.channels
        .filter(ch => {
            if (typeof ch === 'string') return false;
            return ch.dropId === dropId;
        })
        .map(ch => ch.url);
}

function getDropGroupWatchedTime(dropId, config, watchedMap) {
    const urls = getDropGroupUrls(dropId, config);
    let sum = 0;
    const map = watchedMap || totalWatched || {};
    for (const url of urls) {
        sum += (map[url] || 0);
    }
    return sum;
}

function secondsToHMS(sec) {
    if (typeof sec !== "number" || isNaN(sec) || sec <= 0) return "0:00:00";
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function getChannelTargetWatchTime(url, config) {
    if (!config) return defaultWatchTime;
    const dropId = getDropId(url, config);
    if (dropId && Array.isArray(config.channels)) {
        const groupCh = config.channels.find(ch => typeof ch === 'object' && ch.dropId === dropId && ch.watchTime);
        if (groupCh && groupCh.watchTime) {
            return parseTimeToSeconds(groupCh.watchTime);
        }
    }
    const channel = (config.channels || []).find(ch => (typeof ch === 'string' ? ch : ch.url) === url);
    if (channel) {
        const wt = typeof channel === 'string' ? config.watchTime : (channel.watchTime || config.watchTime);
        return parseTimeToSeconds(wt) || defaultWatchTime;
    }
    return parseTimeToSeconds(config.watchTime) || defaultWatchTime;
}

function isChannelOrGroupFinished(url, config, watchedMap) {
    if (!config) return false;
    const dropId = getDropId(url, config);
    const targetSec = getChannelTargetWatchTime(url, config);
    if (targetSec <= 0) return false;
    const map = watchedMap || totalWatched || {};
    const watchedSec = dropId
        ? getDropGroupWatchedTime(dropId, config, map)
        : (map[url] || 0);
    return watchedSec >= targetSec;
}

function stopCurrentStreamSession() {
    currentRunId++;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
    if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
    if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
    if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
    currentStreamInfo = { url: null, secondsLeft: 0 };
}

function handleUserConfigChanged(newConfig) {
    if (!isRunning) return;
    const curUrl = (currentStreamInfo && currentStreamInfo.url) || (channels[currentChannelIndex] && channels[currentChannelIndex].url);
    if (!curUrl) {
        if (waitForActiveInterval) {
            checkAndResumeIfActiveChannelsAvailable(newConfig);
        }
        return;
    }

    // 1. Проверяем, существует ли текущий канал в обновленном конфиге
    const channelExists = (newConfig.channels || []).some(ch => (typeof ch === 'string' ? ch : ch.url) === curUrl);
    if (!channelExists) {
        log(`Текущий канал ${curUrl} удален из настроек. Переход к следующему каналу.`);
        stopCurrentStreamSession();
        nextChannel();
        return;
    }

    // 2. Проверяем блокировку в ЧС
    const blacklist = newConfig.blacklist || {};
    const now = Date.now();
    const isBlocked = blacklist[curUrl] === 'permanent' || (typeof blacklist[curUrl] === 'number' && blacklist[curUrl] > now);
    if (isBlocked) {
        log(`Текущий канал ${curUrl} заблокирован в черном списке. Переход к следующему каналу.`);
        stopCurrentStreamSession();
        nextChannel();
        return;
    }

    // 3. Проверяем, достигнута ли цель для группы или канала
    const dropId = getDropId(curUrl, newConfig);
    const targetSec = getChannelTargetWatchTime(curUrl, newConfig);
    const watchedSec = dropId
        ? getDropGroupWatchedTime(dropId, newConfig, totalWatched)
        : (totalWatched[curUrl] || 0);

    if (targetSec > 0 && watchedSec >= targetSec) {
        log(`Цель для ${dropId ? `группы '${dropId}'` : `канала ${curUrl}`} достигнута (${secondsToHMS(watchedSec)} / ${secondsToHMS(targetSec)}). Переход к следующему каналу.`);
        if (typeof newConfig.blacklist !== 'object' || Array.isArray(newConfig.blacklist)) newConfig.blacklist = {};
        const groupUrls = dropId ? getDropGroupUrls(dropId, newConfig) : [curUrl];
        let needSave = false;
        for (const gUrl of groupUrls) {
            if (newConfig.blacklist[gUrl] !== 'permanent') {
                newConfig.blacklist[gUrl] = 'permanent';
                needSave = true;
            }
        }
        if (needSave) {
            chrome.storage.local.set({ userConfig: newConfig });
        }
        stopCurrentStreamSession();
        nextChannel();
        return;
    }

    // 4. Если цель не достигнута, динамически обновляем оставшееся время
    const remaining = Math.max(0, targetSec - watchedSec);
    currentStreamInfo = { url: curUrl, secondsLeft: remaining };
}

function handleTotalWatchedChanged(newWatched) {
    if (!isRunning) return;
    const curUrl = (currentStreamInfo && currentStreamInfo.url) || (channels[currentChannelIndex] && channels[currentChannelIndex].url);
    if (!curUrl) {
        chrome.storage.local.get("userConfig", (data) => {
            if (data.userConfig && waitForActiveInterval) {
                checkAndResumeIfActiveChannelsAvailable(data.userConfig, newWatched);
            }
        });
        return;
    }

    chrome.storage.local.get("userConfig", (data) => {
        const config = data.userConfig;
        if (!config) return;
        const dropId = getDropId(curUrl, config);
        const targetSec = getChannelTargetWatchTime(curUrl, config);
        const watchedSec = dropId
            ? getDropGroupWatchedTime(dropId, config, newWatched)
            : (newWatched[curUrl] || 0);

        if (targetSec > 0 && watchedSec >= targetSec) {
            handleUserConfigChanged(config);
        } else {
            const remaining = Math.max(0, targetSec - watchedSec);
            currentStreamInfo = { url: curUrl, secondsLeft: remaining };
        }
    });
}

function checkAndResumeIfActiveChannelsAvailable(config, watchedMap) {
    if (!isRunning || !waitForActiveInterval) return;
    const blacklist = config.blacklist || {};
    const map = watchedMap || totalWatched || {};
    const hasActive = (config.channels || []).some(ch => {
        const url = typeof ch === 'string' ? ch : ch.url;
        return !blacklist[url] && !isChannelOrGroupFinished(url, config, map);
    });
    if (hasActive) {
        clearInterval(waitForActiveInterval);
        waitForActiveInterval = null;
        log("Появился активный канал, возобновляем просмотр.");
        currentChannelIndex = 0;
        watchNextChannel();
    }
}

function ensureStreamWindow(cb) {
    if (streamWindowId !== null) {
        chrome.windows.get(streamWindowId, { populate: false }, (win) => {
            if (chrome.runtime.lastError || !win) {
                streamWindowId = null;
                streamTabId = null;
            }
            cb && cb();
        });
    } else {
        cb && cb();
    }
}

function setStreamTab(url, cb) {
    ensureStreamWindow(() => {
        if (!streamWindowId) {
            chrome.windows.create({ url, focused: false }, (w) => {
                if (chrome.runtime.lastError || !w) {
                    cb && cb();
                    return;
                }
                streamWindowId = w.id;
                chrome.tabs.query({ windowId: w.id }, (tabs) => {
                    if (tabs && tabs[0]) streamTabId = tabs[0].id;
                    currentStreamInfo = { url, secondsLeft: 0 };
                    cb && cb();
                });
            });
            return;
        }

        if (streamTabId !== null) {
            chrome.tabs.get(streamTabId, tab => {
                if (chrome.runtime.lastError || !tab) {
                    chrome.tabs.create({ windowId: streamWindowId, url, active: true }, newTab => {
                        if (newTab) streamTabId = newTab.id;
                        currentStreamInfo = { url, secondsLeft: 0 };
                        cb && cb();
                    });
                } else {
                    if (tab.windowId !== streamWindowId) {
                        chrome.tabs.move(streamTabId, { windowId: streamWindowId, index: -1 }, () => {
                            chrome.tabs.update(streamTabId, { url, active: true }, () => cb && cb());
                        });
                    } else {
                        chrome.tabs.update(streamTabId, { url, active: true }, () => {
                            currentStreamInfo = { url, secondsLeft: 0 };
                            cb && cb();
                        });
                    }
                }
            });
        } else {
            chrome.tabs.create({ windowId: streamWindowId, url, active: true }, newTab => {
                if (newTab) streamTabId = newTab.id;
                currentStreamInfo = { url, secondsLeft: 0 };
                cb && cb();
            });
        }
    });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId === streamTabId) {
        try {
            if (changeInfo.url) {
                currentStreamInfo = { url: changeInfo.url, secondsLeft: currentStreamInfo.secondsLeft || 0 };
                log(`DEBUG: обновлён URL вкладки со стримом -> ${changeInfo.url}`);
            }
            if (changeInfo.status === 'complete') {
                currentStreamInfo = { url: tab.url || currentStreamInfo.url, secondsLeft: currentStreamInfo.secondsLeft || 0 };
                log(`DEBUG: загрузка вкладки со стримом завершена -> ${currentStreamInfo.url}`);
            }
        } catch (e) {}
    }
});

function startWatching(config, isResume = false) {
    if (isRunning && !isResume) {
        log("Просмотр уже запущен.");
        return;
    }
    if (!config.channels || !Array.isArray(config.channels) || config.channels.length === 0) {
        log("В конфиге нет каналов!");
        return;
    }
    syncConfigState(config);
    isRunning = true;
    chrome.storage.local.set({ isRunning: true });

    try {
        chrome.alarms.create("watchHeartbeat", { periodInMinutes: 1 });
    } catch (e) {}

    if (!isResume) {
        currentChannelIndex = 0;
    }
    log("Запуск просмотра каналов...");
    startBlacklistAutoUnlock();
    watchNextChannel();
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "watchHeartbeat") {
        if (isRunning) {
            chrome.storage.local.get(["isRunning", "userConfig"], (data) => {
                if (data.isRunning && isRunning) {
                    if (!watchTimerInterval && !scheduledCheckTimeout && !waitForActiveInterval) {
                        log("Heartbeat: возобновление цикла просмотра...");
                        watchNextChannel();
                    }
                }
            });
        }
    }
});

function cleanupBlacklist(config, cb) {
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
    }
    if (changed) {
        chrome.storage.local.set({ userConfig: config }, () => {
            if (cb) cb(config);
        });
    } else {
        if (cb) cb(config);
    }
}

function closeStreamTabIfExists(cb) {
    if (streamWindowId !== null) {
        chrome.windows.remove(streamWindowId, () => {
            if (chrome.runtime.lastError) {}
            streamWindowId = null;
            streamTabId = null;
            cb && cb();
        });
    } else if (streamTabId !== null) {
        chrome.tabs.remove(streamTabId, () => {
            if (chrome.runtime.lastError) {}
            streamTabId = null;
            cb && cb();
        });
    } else {
        cb && cb();
    }
}

function waitForActiveChannels() {
    if (waitForActiveInterval) return;
    log("Ожидание появления активных каналов...");
    waitForActiveInterval = setInterval(() => {
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            let config = data.userConfig;
            if (!config || !Array.isArray(config.channels) || config.channels.length === 0) return;
            if (typeof config.blacklist !== "object" || Array.isArray(config.blacklist)) config.blacklist = {};
            cleanupBlacklist(config, (cleanedConfig) => {
                const blacklist = cleanedConfig.blacklist || {};
                const map = data.totalWatched || totalWatched || {};
                let hasActive = false;
                for (const ch of config.channels) {
                    const url = typeof ch === "string" ? ch : ch.url;
                    if (!blacklist[url] && !isChannelOrGroupFinished(url, cleanedConfig, map)) {
                        hasActive = true;
                        break;
                    }
                }
                if (hasActive) {
                    clearInterval(waitForActiveInterval);
                    waitForActiveInterval = null;
                    log("Появился активный канал, возобновляем просмотр.");
                    currentChannelIndex = 0;
                    watchNextChannel();
                }
            });
        });
    }, 5000);
}

function watchNextChannel() {
    if (!isRunning) return;
    if (channels.length === 0) {
        log("Список каналов пуст.");
        return;
    }

    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        let config = data.userConfig || {};
        if (typeof config.blacklist !== "object" || Array.isArray(config.blacklist)) config.blacklist = {};

        cleanupBlacklist(config, (cleanedConfig) => {
            const blacklist = cleanedConfig.blacklist || {};
            const map = data.totalWatched || totalWatched || {};
            let checked = 0;
            let foundActive = false;
            let blacklistUpdated = false;

            while (checked < channels.length) {
                if (currentChannelIndex >= channels.length) currentChannelIndex = 0;
                const ch = channels[currentChannelIndex];
                const url = ch.url;

                // 1. Проверяем черный список
                if (blacklist[url]) {
                    currentChannelIndex++;
                    checked++;
                    continue;
                }

                // 2. Проверяем, не достигнута ли уже цель группы или канала
                if (isChannelOrGroupFinished(url, cleanedConfig, map)) {
                    const dropId = ch.dropId || getDropId(url, cleanedConfig);
                    const groupUrls = dropId ? getDropGroupUrls(dropId, cleanedConfig) : [url];
                    for (const gUrl of groupUrls) {
                        if (blacklist[gUrl] !== 'permanent') {
                            blacklist[gUrl] = 'permanent';
                            blacklistUpdated = true;
                        }
                    }
                    currentChannelIndex++;
                    checked++;
                    continue;
                }

                foundActive = true;
                break;
            }

            if (blacklistUpdated) {
                chrome.storage.local.set({ userConfig: cleanedConfig });
            }

            if (!foundActive) {
                log("Нет активных каналов для просмотра (все выполнены или в ЧС).");
                closeStreamTabIfExists(() => {
                    waitForActiveChannels();
                });
                return;
            }

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
    if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
    const delay = attempt === 1 ? 1500 : 2500;
    pendingDoFindTimeout = setTimeout(() => {
        pendingDoFindTimeout = null;
        doFindLink(tabId, url, watchTime, attempt, maxAttempts);
    }, delay);
}

function doFindLink(tabId, url, watchTime, attempt, maxAttempts, onResult) {
    log(`Проверка наличия ссылки "${searchUrlPart}"... (попытка ${attempt})`);
    safeSendMessage(tabId, { action: "findLink", text: searchUrlPart }, (response) => {
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
                pageMatches = true;
            }
        }

        if (typeof onResult === "function") {
            const augmented = Object.assign({}, response || {}, { pageMatches, debugExpected, debugActual });
            onResult(augmented);
            return;
        }

        if (!response) {
            log("Контент-скрипт не ответил.");
            if (attempt < maxAttempts) {
                checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
                return;
            }
            addToBlacklist(url);
            nextChannel();
            return;
        }

        if (response && response.streamerOnline === false) {
            log(`Стример ОФЛАЙН на ${url}!`);
            if (attempt < maxAttempts) {
                checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
                return;
            }
            addToBlacklist(url);
            nextChannel();
            return;
        }

        if (response && response.found && pageMatches) {
            log(`Ссылка найдена на ${url}. Начинаем отсчет времени.`);
            startWatchTimer(tabId, url, watchTime);
        } else {
            if (attempt < maxAttempts) {
                log(`Ссылка не найдена, повторная попытка... (${attempt + 1}/${maxAttempts})`);
                checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
            } else {
                log(`Ссылка не найдена на ${url} после ${maxAttempts} попыток. Канал отправлен в ЧС.`);
                addToBlacklist(url);
                nextChannel();
            }
        }
    });
}

function addToBlacklist(url, customDurationSeconds) {
    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        let config = data.userConfig;
        if (!config) return;
        if (typeof config.blacklist !== "object" || Array.isArray(config.blacklist)) config.blacklist = {};
        
        const dropId = getDropId(url, config);
        const groupUrls = dropId ? getDropGroupUrls(dropId, config) : [url];
        const watchTime = getChannelTargetWatchTime(url, config);
        const totalGroupWatched = dropId ? getDropGroupWatchedTime(dropId, config, data.totalWatched || {}) : (totalWatched[url] || 0);
        const tempBlacklistSeconds = resolveTempBlacklistSeconds(config, customDurationSeconds);
        
        if (watchTime > 0 && totalGroupWatched >= watchTime) {
            for (const groupUrl of groupUrls) {
                config.blacklist[groupUrl] = "permanent";
            }
            chrome.storage.local.set({ userConfig: config }, () => {
                if (dropId) {
                    log(`Группа дропа '${dropId}' навсегда добавлена в черный список (достигнуто время ${secondsToHMS(totalGroupWatched)}/${secondsToHMS(watchTime)}).`);
                } else {
                    log(`Канал ${url} навсегда добавлен в черный список (достигнуто время просмотра: ${secondsToHMS(totalGroupWatched)}/${secondsToHMS(watchTime)}).`);
                }
            });
        } else {
            const until = Date.now() + tempBlacklistSeconds * 1000;
            config.blacklist[url] = until;
            chrome.storage.local.set({ userConfig: config }, () => {
                log(`Канал ${url} добавлен в черный список до ${new Date(until).toLocaleTimeString()} (${Math.round(tempBlacklistSeconds/60)} мин).`);
            });
        }
    });
}

function startWatchTimer(tabId, url, initialWatchTime) {
    const myRunId = ++currentRunId;
    
    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        let config = data.userConfig || {};
        if (data.totalWatched) totalWatched = data.totalWatched;
        const dropId = getDropId(url, config);
        const liveWatchTime = getChannelTargetWatchTime(url, config) || initialWatchTime || defaultWatchTime;
        
        const alreadyWatched = dropId 
            ? getDropGroupWatchedTime(dropId, config, totalWatched)
            : (totalWatched[url] || 0);
        
        // Сразу проверяем: возможно, цель уже была достигнута
        if (liveWatchTime > 0 && alreadyWatched >= liveWatchTime) {
            log(`Цель для ${dropId ? `группы '${dropId}'` : `канала ${url}`} уже достигнута (${secondsToHMS(alreadyWatched)} / ${secondsToHMS(liveWatchTime)}).`);
            if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};
            const groupUrls = dropId ? getDropGroupUrls(dropId, config) : [url];
            for (const gUrl of groupUrls) {
                config.blacklist[gUrl] = 'permanent';
            }
            chrome.storage.local.set({ userConfig: config, totalWatched });
            currentStreamInfo = { url: null, secondsLeft: 0 };
            nextChannel();
            return;
        }

        let secondsLeft = Math.max(0, liveWatchTime - alreadyWatched);
        currentStreamInfo = { url, secondsLeft };
        log(`DEBUG: startWatchTimer for ${url}${dropId ? ` (group: ${dropId})` : ''}, watchTime=${liveWatchTime}, alreadyWatched=${alreadyWatched}, runId=${myRunId}`);
        
        let timerStopped = false;
        let checkIntervalMs = 2 * 60 * 1000;
        if (config && typeof config.checkIntervalMinutes === "number" && config.checkIntervalMinutes > 0) {
            checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
        }

        if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
        if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }

        let saveCounter = 0;

        watchTimerInterval = setInterval(() => {
            if (myRunId !== currentRunId || !isRunning || timerStopped) {
                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                currentStreamInfo = { url: null, secondsLeft: 0 };
                return;
            }

            if (!totalWatched[url]) totalWatched[url] = 0;
            totalWatched[url]++;

            chrome.storage.local.get("userConfig", (cfgData) => {
                const liveConfig = cfgData.userConfig || config;
                const liveDropId = getDropId(url, liveConfig);
                const currentTargetTime = getChannelTargetWatchTime(url, liveConfig) || liveWatchTime;
                const currentGroupWatched = liveDropId 
                    ? getDropGroupWatchedTime(liveDropId, liveConfig, totalWatched)
                    : (totalWatched[url] || 0);

                secondsLeft = Math.max(0, currentTargetTime - currentGroupWatched);
                currentStreamInfo = { url, secondsLeft };

                saveCounter++;
                const isFinished = (currentTargetTime > 0 && currentGroupWatched >= currentTargetTime) || (currentTargetTime > 0 && secondsLeft <= 0);
                if (saveCounter % 10 === 0 || isFinished) {
                    chrome.storage.local.set({ totalWatched });
                }

                if (isFinished) {
                    if (liveConfig && typeof liveConfig.blacklist === 'object' && !Array.isArray(liveConfig.blacklist)) {
                        const groupUrls = liveDropId ? getDropGroupUrls(liveDropId, liveConfig) : [url];
                        let needUpdate = false;
                        for (const groupUrl of groupUrls) {
                            if (liveConfig.blacklist[groupUrl] !== 'permanent') {
                                liveConfig.blacklist[groupUrl] = 'permanent';
                                needUpdate = true;
                            }
                        }
                        if (needUpdate) {
                            chrome.storage.local.set({ userConfig: liveConfig });
                        }
                    }
                    if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                    if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                    timerStopped = true;
                    currentStreamInfo = { url: null, secondsLeft: 0 };
                    log(`Время на ${url} истекло (лимит группы/канала достигнут: ${secondsToHMS(currentGroupWatched)} / ${secondsToHMS(currentTargetTime)}).`);
                    nextChannel();
                    return;
                }
            });
        }, 1000);

        let failedCheckCount = 0;
        watchLinkCheckInterval = setInterval(() => {
            if (myRunId !== currentRunId || !isRunning || timerStopped) {
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                return;
            }

            chrome.storage.local.get("userConfig", (dataCfg) => {
                let liveCfg = dataCfg.userConfig || config;
                const liveWatch = getChannelTargetWatchTime(url, liveCfg) || initialWatchTime || defaultWatchTime;
                doFindLink(tabId, url, liveWatch, 1, 1, (response) => {
                    const isOnline = response && response.streamerOnline !== false;
                    const linkFound = response && response.found;
                    const pageMatchesOk = response && response.pageMatches !== false;

                    if (!isOnline || !linkFound || !pageMatchesOk) {
                        failedCheckCount++;
                        log(`Периодическая проверка не удалась (${failedCheckCount}/3) на ${url}`);
                        if (failedCheckCount < 3) return;

                        log(`Стример оффлайн или ссылка пропала на ${url}. Завершаем просмотр.`);
                        if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                        if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                        timerStopped = true;
                        currentStreamInfo = { url: null, secondsLeft: 0 };

                        const tempSeconds = resolveTempBlacklistSeconds(liveCfg);
                        addToBlacklist(url, tempSeconds);
                        currentRunId++;
                        nextChannel();
                    } else {
                        failedCheckCount = 0;
                    }
                });
            });
        }, checkIntervalMs);
    });
}

function nextChannel() {
    currentRunId++;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
    if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
    if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
    if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
    
    currentChannelIndex++;
    if (isRunning) watchNextChannel();
}

function stopWatching() {
    isRunning = false;
    chrome.storage.local.set({ isRunning: false });
    currentRunId++;
    try {
        chrome.alarms.clear("watchHeartbeat");
    } catch (e) {}
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
    if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
    if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
    if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }
    if (waitForActiveInterval) { clearInterval(waitForActiveInterval); waitForActiveInterval = null; }
    if (blacklistAutoUnlockInterval) { clearInterval(blacklistAutoUnlockInterval); blacklistAutoUnlockInterval = null; }

    closeStreamTabIfExists();
    currentStreamInfo = { url: null, secondsLeft: 0 };
    log("Просмотр остановлен.");
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "startWatching") {
        chrome.storage.local.get("userConfig", (data) => {
            let config = data.userConfig;
            if (!config) {
                log("Сначала загрузите конфиг вручную через интерфейс!");
                return;
            }
            startWatching(config);
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
    if (request.action === "getLoggingEnabled") {
        sendResponse({ loggingEnabled });
        return true;
    }
    if (request.action === "setLoggingEnabled") {
        setLoggingEnabled(!!request.enabled);
        sendResponse({ loggingEnabled });
        return true;
    }
    if (request.action === "clearLogs") {
        logBuffer = [];
        chrome.storage.local.set({ logBuffer }, () => {
            sendResponse && sendResponse();
        });
        return true;
    }
    if (request.action === "getStats") {
        chrome.storage.local.get("totalWatched", (data) => {
            sendResponse({ stats: data.totalWatched || totalWatched });
        });
        return true;
    }
    if (request.action === "getCurrentStreamInfo") {
        const cur = currentStreamInfo && currentStreamInfo.url ? currentStreamInfo : null;
        if (!cur || !cur.url) {
            sendResponse({ url: null, secondsLeft: 0 });
            return;
        }
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const cfg = data.userConfig || {};
            const persisted = data.totalWatched || totalWatched || {};
            const url = cur.url;
            const dropId = getDropId(url, cfg);

            let targetSec = 0;
            const channel = (cfg.channels || []).find(ch => (typeof ch === 'string' ? ch : ch.url) === url);
            if (channel) {
                targetSec = typeof channel === 'string' ? parseTimeToSeconds(cfg.watchTime) : parseTimeToSeconds(channel.watchTime || cfg.watchTime);
            } else {
                targetSec = parseTimeToSeconds(cfg.watchTime) || defaultWatchTime;
            }

            const watched = dropId
                ? getDropGroupWatchedTime(dropId, cfg, persisted)
                : (persisted[url] || 0);

            const remaining = Math.max(0, targetSec - watched);
            sendResponse({ url, secondsLeft: remaining, watched, targetSec, dropId });
        });
        return true;
    }
    if (request.action === "switchToChannel" && request.url) {
        chrome.storage.local.get("userConfig", (data) => {
            const cfg = data.userConfig || {};
            const ch = (cfg.channels || []).find(c => (typeof c === 'string' ? c : c.url) === request.url);
            const wt = ch ? (typeof ch === 'string' ? parseTimeToSeconds(cfg.watchTime) : parseTimeToSeconds(ch.watchTime || cfg.watchTime)) : defaultWatchTime;
            const waitSec = (ch && typeof ch === 'object' && ch.waitBeforeCheck !== undefined) ? ch.waitBeforeCheck : (cfg.waitBeforeCheck !== undefined ? cfg.waitBeforeCheck : defaultWaitBeforeCheck);
            const maxAttempts = (cfg && typeof cfg.maxAttempts === 'number') ? cfg.maxAttempts : 3;
            setStreamTab(request.url, () => {
                currentRunId++;
                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
                if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }

                const watchedForSwitch = totalWatched[request.url] || 0;
                const remainingForSwitch = Math.max(0, wt - watchedForSwitch);
                currentStreamInfo = { url: request.url, secondsLeft: remainingForSwitch };
                if (isRunning) {
                    scheduledCheckTimeout = setTimeout(() => {
                        scheduledCheckTimeout = null;
                        checkChannel(streamTabId, request.url, wt, 1, maxAttempts);
                    }, (waitSec || defaultWaitBeforeCheck) * 1000);
                }
                sendResponse({ ok: true });
            });
        });
        return true;
    }
    if (request.action === "manualNext") {
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const config = data.userConfig || {};
            const cfgChannels = channels.length > 0 ? channels : (Array.isArray(config.channels) ? config.channels : []);
            if (cfgChannels.length === 0) { sendResponse({ ok: false, reason: 'no channels' }); return; }

            const blacklist = config.blacklist || {};
            let start = currentChannelIndex + 1;
            let found = -1;
            for (let i = 0; i < cfgChannels.length; i++) {
                const idx = (start + i) % cfgChannels.length;
                const url = typeof cfgChannels[idx] === 'string' ? cfgChannels[idx] : cfgChannels[idx].url;
                if (!blacklist[url]) { found = idx; break; }
            }
            if (found === -1) { sendResponse({ ok: false, reason: 'no active channels' }); return; }
            currentChannelIndex = found;
            const sel = typeof cfgChannels[found] === 'string' ? { url: cfgChannels[found] } : cfgChannels[found];
            const wt = sel.watchTime ? parseTimeToSeconds(sel.watchTime) : (config.watchTime ? parseTimeToSeconds(config.watchTime) : defaultWatchTime);
            const waitSec = sel.waitBeforeCheck !== undefined ? sel.waitBeforeCheck : (config.waitBeforeCheck !== undefined ? config.waitBeforeCheck : defaultWaitBeforeCheck);
            const maxAttempts = (config && typeof config.maxAttempts === 'number') ? config.maxAttempts : 3;

            currentRunId++;
            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
            if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
            if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }

            setStreamTab(sel.url, () => {
                const watchedForSel = totalWatched[sel.url] || 0;
                const remainingForSel = Math.max(0, wt - watchedForSel);
                currentStreamInfo = { url: sel.url, secondsLeft: remainingForSel };
                if (isRunning) {
                    scheduledCheckTimeout = setTimeout(() => {
                        scheduledCheckTimeout = null;
                        checkChannel(streamTabId, sel.url, wt, 1, maxAttempts);
                    }, (waitSec || defaultWaitBeforeCheck) * 1000);
                }
                sendResponse({ ok: true, url: sel.url });
            });
        });
        return true;
    }
    if (request.action === "manualPrev") {
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const config = data.userConfig || {};
            const cfgChannels = channels.length > 0 ? channels : (Array.isArray(config.channels) ? config.channels : []);
            if (cfgChannels.length === 0) { sendResponse({ ok: false, reason: 'no channels' }); return; }

            const blacklist = config.blacklist || {};
            let start = currentChannelIndex - 1;
            if (start < 0) start = cfgChannels.length - 1;
            let found = -1;
            for (let i = 0; i < cfgChannels.length; i++) {
                const idx = (start - i + cfgChannels.length) % cfgChannels.length;
                const url = typeof cfgChannels[idx] === 'string' ? cfgChannels[idx] : cfgChannels[idx].url;
                if (!blacklist[url]) { found = idx; break; }
            }
            if (found === -1) { sendResponse({ ok: false, reason: 'no active channels' }); return; }
            currentChannelIndex = found;
            const sel = typeof cfgChannels[found] === 'string' ? { url: cfgChannels[found] } : cfgChannels[found];
            const wt = sel.watchTime ? parseTimeToSeconds(sel.watchTime) : (config.watchTime ? parseTimeToSeconds(config.watchTime) : defaultWatchTime);
            const waitSec = sel.waitBeforeCheck !== undefined ? sel.waitBeforeCheck : (config.waitBeforeCheck !== undefined ? config.waitBeforeCheck : defaultWaitBeforeCheck);
            const maxAttempts = (config && typeof config.maxAttempts === 'number') ? config.maxAttempts : 3;

            currentRunId++;
            if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
            if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
            if (scheduledCheckTimeout) { clearTimeout(scheduledCheckTimeout); scheduledCheckTimeout = null; }
            if (pendingDoFindTimeout) { clearTimeout(pendingDoFindTimeout); pendingDoFindTimeout = null; }

            setStreamTab(sel.url, () => {
                const watchedForSelPrev = totalWatched[sel.url] || 0;
                const remainingForSelPrev = Math.max(0, wt - watchedForSelPrev);
                currentStreamInfo = { url: sel.url, secondsLeft: remainingForSelPrev };
                if (isRunning) {
                    scheduledCheckTimeout = setTimeout(() => {
                        scheduledCheckTimeout = null;
                        checkChannel(streamTabId, sel.url, wt, 1, maxAttempts);
                    }, (waitSec || defaultWaitBeforeCheck) * 1000);
                }
                sendResponse({ ok: true, url: sel.url });
            });
        });
        return true;
    }
    if (request.action === "resetWatchTime" && request.url) {
        chrome.storage.local.get("totalWatched", (data) => {
            const fresh = data.totalWatched || totalWatched || {};
            fresh[request.url] = 0;
            totalWatched[request.url] = 0;
            chrome.storage.local.set({ totalWatched: fresh }, () => {
                log(`Суммарное время просмотра для ${request.url} сброшено.`);
                if (typeof sendResponse === "function") sendResponse();
            });
        });
        return true;
    }
});

function startBlacklistAutoUnlock() {
    if (blacklistAutoUnlockInterval) return;
    blacklistAutoUnlockInterval = setInterval(() => {
        chrome.storage.local.get("userConfig", (data) => {
            let config = data.userConfig;
            if (!config || typeof config.blacklist !== "object" || Array.isArray(config.blacklist)) return;
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
                    if (waitForActiveInterval) {
                        clearInterval(waitForActiveInterval);
                        waitForActiveInterval = null;
                        log("Появился активный канал, продолжаем просмотр.");
                        watchNextChannel();
                    }
                });
            }
        });
    }, 1000);
}

function safeSendMessage(tabId, message, callback) {
    if (!tabId) {
        if (callback) callback(undefined);
        return;
    }
    try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
            if (chrome.runtime.lastError) {
                if (callback) callback(undefined);
                return;
            }
            if (callback) callback(response);
        });
    } catch (err) {
        if (callback) callback(undefined);
    }
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === streamTabId) {
        if (isRunning) {
            log(`Вкладка стрима ${tabId} была закрыта -> останавливаем просмотр.`);
            stopWatching();
        } else {
            streamTabId = null;
        }
    }
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === streamWindowId) {
        if (isRunning) {
            log(`Окно стрима ${windowId} было закрыто -> останавливаем просмотр.`);
            stopWatching();
        } else {
            streamWindowId = null;
            streamTabId = null;
        }
    }
});

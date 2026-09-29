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
let inventorySyncInterval = null;

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

function getDropGroupProgressPercent(dropId, config, watchedMap) {
    if (!dropId || !config || !Array.isArray(config.channels)) return 0;
    const groupCh = config.channels.find(ch => typeof ch === 'object' && ch.dropId === dropId && ch.watchTime);
    const targetSec = groupCh ? parseTimeToSeconds(groupCh.watchTime) : parseTimeToSeconds(config.watchTime || '1:00:00');
    if (targetSec <= 0) return 0;

    const watchedSec = getDropGroupWatchedTime(dropId, config, watchedMap);
    return Math.min(100, Math.round((watchedSec / targetSec) * 100));
}

function sortGroupIdsByProgress(groupIds, config, watchedMap) {
    if (!Array.isArray(groupIds)) return [];
    const ids = [...groupIds];
    const map = watchedMap || totalWatched || {};

    ids.sort((a, b) => {
        const pA = getDropGroupProgressPercent(a, config, map);
        const pB = getDropGroupProgressPercent(b, config, map);

        const isDoneA = pA >= 100;
        const isDoneB = pB >= 100;

        // 1. Завершенные (100%) всегда идут в самый низ
        if (isDoneA && !isDoneB) return 1;
        if (!isDoneA && isDoneB) return -1;
        if (isDoneA && isDoneB) return 0;

        // 2. Частично начатые (>0% и <100%) идут выше не начатых (0%)
        const hasStartedA = pA > 0;
        const hasStartedB = pB > 0;

        if (hasStartedA && !hasStartedB) return -1;
        if (!hasStartedA && hasStartedB) return 1;

        // 3. Среди частично начатых: чем ближе к концу (выше процент), тем выше приоритет (по убыванию: 80% выше 77%)
        if (hasStartedA && hasStartedB) {
            if (pB !== pA) return pB - pA;
        }

        // 4. Если оба 0% или равны, сохраняем исходный порядок
        return 0;
    });

    return ids;
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

function findHighestPriorityChannelIndex(config, watchedMap) {
    if (!config || !Array.isArray(channels) || channels.length === 0) return -1;
    const blacklist = (config && config.blacklist) || {};
    const now = Date.now();
    const map = watchedMap || totalWatched || {};
    for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const url = typeof ch === 'string' ? ch : ch.url;
        const isBlocked = blacklist[url] === 'permanent' || (typeof blacklist[url] === 'number' && blacklist[url] > now);
        if (isBlocked) continue;
        if (isChannelOrGroupFinished(url, config, map)) continue;
        return i;
    }
    return -1;
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

    // 4. Важно: Если разблокировался канал выше по приоритету или изменился порядок приоритетов,
    // мы НЕ прерываем текущий просмотр. Продолжаем смотреть текущий дроп до естественного завершения
    // (пока не выполнится цель 100%, либо стрим оффлайн, либо смена категории, либо ручной переход).
    // Только когда мы естественным образом уйдем с текущего стрима, watchNextChannel выберет разблокированный приоритетный канал.
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
                        if (newTab) {
                            streamTabId = newTab.id;
                            try { chrome.tabs.update(streamTabId, { muted: true }); } catch (e) {}
                        }
                        currentStreamInfo = { url, secondsLeft: 0 };
                        cb && cb();
                    });
                } else {
                    if (tab.windowId !== streamWindowId) {
                        chrome.tabs.move(streamTabId, { windowId: streamWindowId, index: -1 }, () => {
                            chrome.tabs.update(streamTabId, { url, active: true, muted: true }, () => cb && cb());
                        });
                    } else {
                        chrome.tabs.update(streamTabId, { url, active: true, muted: true }, () => {
                            currentStreamInfo = { url, secondsLeft: 0 };
                            cb && cb();
                        });
                    }
                }
            });
        } else {
            chrome.tabs.create({ windowId: streamWindowId, url, active: true }, newTab => {
                if (newTab) {
                    streamTabId = newTab.id;
                    try { chrome.tabs.update(streamTabId, { muted: true }); } catch (e) {}
                }
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
            }
            if (changeInfo.status === 'complete') {
                currentStreamInfo = { url: tab.url || currentStreamInfo.url, secondsLeft: currentStreamInfo.secondsLeft || 0 };
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
    startInventoryAutoSync();
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
            let blacklistUpdated = false;

            // 1. Проверяем все каналы на завершение целей, чтобы пометить их в ЧС
            for (let i = 0; i < channels.length; i++) {
                const ch = channels[i];
                const url = typeof ch === 'string' ? ch : ch.url;
                if (isChannelOrGroupFinished(url, cleanedConfig, map)) {
                    const dropId = (typeof ch === 'object' && ch.dropId) || getDropId(url, cleanedConfig);
                    const groupUrls = dropId ? getDropGroupUrls(dropId, cleanedConfig) : [url];
                    for (const gUrl of groupUrls) {
                        if (blacklist[gUrl] !== 'permanent') {
                            blacklist[gUrl] = 'permanent';
                            blacklistUpdated = true;
                        }
                    }
                }
            }

            if (blacklistUpdated) {
                chrome.storage.local.set({ userConfig: cleanedConfig });
            }

            // 2. Ищем первый доступный канал строго с наивысшим приоритетом (начиная с индекса 0)
            const bestIndex = findHighestPriorityChannelIndex(cleanedConfig, map);
            if (bestIndex === -1) {
                log("Нет активных каналов для просмотра (все выполнены или в ЧС).");
                closeStreamTabIfExists(() => {
                    waitForActiveChannels();
                });
                return;
            }

            currentChannelIndex = bestIndex;

            if (waitForActiveInterval) {
                clearInterval(waitForActiveInterval);
                waitForActiveInterval = null;
            }

            const { url, watchTime, waitBeforeCheck, dropId } = channels[currentChannelIndex];
            const maxAttempts = typeof cleanedConfig.maxAttempts === "number" ? cleanedConfig.maxAttempts : 3;
            const priorityNum = (cleanedConfig.groupOrder && dropId) ? (cleanedConfig.groupOrder.indexOf(dropId) + 1) : 1;
            log(`Переход на канал: ${url}${dropId ? ` (группа '${dropId}', приоритет #${priorityNum})` : ''}`);
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
            if (dropId && Array.isArray(config.groupOrder)) {
                config.groupOrder = sortGroupIdsByProgress(config.groupOrder, config, totalWatched);
                syncConfigState(config);
            }
            chrome.storage.local.set({ userConfig: config, totalWatched });
            currentStreamInfo = { url: null, secondsLeft: 0 };
            nextChannel();
            return;
        }

        let secondsLeft = Math.max(0, liveWatchTime - alreadyWatched);
        currentStreamInfo = { url, secondsLeft };
        
        let timerStopped = false;
        let verifyingTwitchCompletion = false;
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

                // Обновляем totalWatched в storage.local каждую секунду для отображения в реальном времени
                chrome.storage.local.set({ totalWatched });

                const isFinished = (currentTargetTime > 0 && currentGroupWatched >= currentTargetTime) || (currentTargetTime > 0 && secondsLeft <= 0);
                if (isFinished) {
                    if (timerStopped || verifyingTwitchCompletion) return;
                    verifyingTwitchCompletion = true;

                    log(`[Таймер] Расчётное время на ${url} подошло к концу (${secondsToHMS(currentGroupWatched)} / ${secondsToHMS(currentTargetTime)}). Проверяем подтверждение 100% на Twitch...`);

                    performInventorySync('auto', () => {
                        chrome.storage.local.get(['userConfig', 'totalWatched'], (vData) => {
                            verifyingTwitchCompletion = false;
                            const vCfg = vData.userConfig || liveConfig;
                            const vWatched = vData.totalWatched || totalWatched;
                            const vGroupWatched = liveDropId ? getDropGroupWatchedTime(liveDropId, vCfg, vWatched) : (vWatched[url] || 0);
                            const vTarget = getChannelTargetWatchTime(url, vCfg) || currentTargetTime;
                            const groupUrls = liveDropId ? getDropGroupUrls(liveDropId, vCfg) : [url];

                            const isPermanentlyDone = groupUrls.every(u => vCfg.blacklist && vCfg.blacklist[u] === 'permanent');
                            const isTwitch100 = (vTarget > 0 && vGroupWatched >= vTarget);

                            if (isPermanentlyDone || isTwitch100) {
                                let needUpdate = false;
                                for (const groupUrl of groupUrls) {
                                    if (!vCfg.blacklist) vCfg.blacklist = {};
                                    if (vCfg.blacklist[groupUrl] !== 'permanent') {
                                        vCfg.blacklist[groupUrl] = 'permanent';
                                        needUpdate = true;
                                    }
                                }
                                if (liveDropId && Array.isArray(vCfg.groupOrder)) {
                                    vCfg.groupOrder = sortGroupIdsByProgress(vCfg.groupOrder, vCfg, vWatched);
                                    needUpdate = true;
                                }
                                if (needUpdate) {
                                    syncConfigState(vCfg);
                                    chrome.storage.local.set({ userConfig: vCfg });
                                }
                                if (watchTimerInterval) { clearInterval(watchTimerInterval); watchTimerInterval = null; }
                                if (watchLinkCheckInterval) { clearInterval(watchLinkCheckInterval); watchLinkCheckInterval = null; }
                                timerStopped = true;
                                currentStreamInfo = { url: null, secondsLeft: 0 };
                                log(`[100% Готово] Дроп '${liveDropId || url}' подтверждён Twitch на 100%! Переход к следующему каналу.`);
                                nextChannel();
                            } else {
                                const pct = vTarget > 0 ? Math.round((vGroupWatched / vTarget) * 100) : 0;
                                log(`[Ожидание Twitch] На Twitch зафиксировано ${pct}% (${secondsToHMS(vGroupWatched)} из ${secondsToHMS(vTarget)}). Продолжаем досмотр до честных 100% на сервере...`);
                            }
                        });
                    });
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
    if (inventorySyncInterval) { clearInterval(inventorySyncInterval); inventorySyncInterval = null; }

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
                ? getDropGroupWatchedTime(dropId, cfg, totalWatched)
                : (totalWatched[url] || 0);

            const remaining = (cur.secondsLeft !== undefined && cur.secondsLeft !== null) ? cur.secondsLeft : Math.max(0, targetSec - watched);

            // Получаем медиа дропа (видео-анимацию и постер)
            const dropMedia = (cfg && typeof cfg.dropMedia === 'object') ? cfg.dropMedia : {};
            const media = (dropId && dropMedia[dropId]) || {};
            const groupChannels = dropId ? (cfg.channels || []).filter(c => typeof c === 'object' && c.dropId === dropId) : [channel].filter(Boolean);
            const chWithMedia = groupChannels.find(c => c && (c.videoUrl || c.imageUrl || (c.ch && (c.ch.videoUrl || c.ch.imageUrl))));
            const videoUrl = media.videoUrl || (chWithMedia && (chWithMedia.videoUrl || (chWithMedia.ch && chWithMedia.ch.videoUrl))) || '';
            const imageUrl = media.imageUrl || (chWithMedia && (chWithMedia.imageUrl || (chWithMedia.ch && chWithMedia.ch.imageUrl))) || '';
            const dropName = media.dropName || (chWithMedia && (chWithMedia.dropName || (chWithMedia.ch && chWithMedia.ch.dropName))) || dropId || '';

            let campaignInfo = null;
            if (cfg && cfg.campaign) {
                const refreshedDates = TwitchCampaignParser.parseDates(cfg.campaign.dateStr);
                campaignInfo = Object.assign({}, cfg.campaign, {
                    timeLeftStr: refreshedDates.timeLeftStr || cfg.campaign.timeLeftStr,
                    isEnded: refreshedDates.isEnded
                });
            }

            sendResponse({
                url: cur.url,
                secondsLeft: remaining,
                watched,
                targetSec,
                dropId,
                videoUrl,
                imageUrl,
                dropName,
                campaign: campaignInfo
            });
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
    if (request.action === "importFacepunchDrops") {
        importFacepunchDrops(request.url, request.platform || 'twitch', (result) => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === "syncDropMedia") {
        syncFacepunchMedia((result) => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === "autoSortPriority") {
        chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
            const config = data.userConfig;
            if (!config || !Array.isArray(config.groupOrder)) {
                sendResponse({ ok: false, reason: "no config" });
                return;
            }
            const map = data.totalWatched || totalWatched || {};
            config.groupOrder = sortGroupIdsByProgress(config.groupOrder, config, map);
            syncConfigState(config);
            chrome.storage.local.set({ userConfig: config }, () => {
                log(`Приоритеты групп автоматически отсортированы по прогрессу (частично начатые -> не начатые -> 100% внизу).`);
                handleUserConfigChanged(config);
                sendResponse({ ok: true, groupOrder: config.groupOrder });
            });
        });
        return true;
    }
    if (request.action === "syncInventory") {
        performInventorySync(request.platform || 'auto', (result) => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === "inventoryScraped" && Array.isArray(request.drops)) {
        applyInventoryData(request.platform || 'twitch', request.drops, (result) => {
            if (typeof sendResponse === "function") sendResponse(result);
        });
        return true;
    }
    if (request.action === "getTwitchCampaigns") {
        getTwitchCampaignsList(request.html, (result) => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === "importTwitchCampaign") {
        importTwitchCampaignAction(request, (result) => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === "fetchCategoryLiveChannels") {
        fetchCategoryLiveChannelsAction(request.categoryUrl, (result) => {
            sendResponse(result);
        });
        return true;
    }
    if (request.action === "getCampaignTimeLeft") {
        chrome.storage.local.get("userConfig", (data) => {
            const cfg = data.userConfig || {};
            if (cfg && cfg.campaign) {
                const refreshed = TwitchCampaignParser.parseDates(cfg.campaign.dateStr);
                cfg.campaign.timeLeftStr = refreshed.timeLeftStr;
                cfg.campaign.isEnded = refreshed.isEnded;
                sendResponse({ ok: true, campaign: cfg.campaign });
            } else {
                sendResponse({ ok: false, campaign: null });
            }
        });
        return true;
    }
});

// =========================================================
// Универсальный парсер и менеджер кампаний Twitch Drops
// =========================================================

const TwitchCampaignParser = {
    months: {
        'янв': 0, 'января': 0, 'янв.': 0, 'jan': 0, 'january': 0,
        'фев': 1, 'февраля': 1, 'фев.': 1, 'feb': 1, 'february': 1,
        'мар': 2, 'марта': 2, 'мар.': 2, 'mar': 2, 'march': 2,
        'апр': 3, 'апреля': 3, 'апр.': 3, 'apr': 3, 'april': 3,
        'май': 4, 'мая': 4, 'may': 4,
        'июн': 5, 'июня': 5, 'июн.': 5, 'jun': 5, 'june': 5,
        'июл': 6, 'июля': 6, 'июл.': 6, 'jul': 6, 'july': 6,
        'авг': 7, 'августа': 7, 'авг.': 7, 'aug': 7, 'august': 7,
        'сен': 8, 'сент': 8, 'сент.': 8, 'сентября': 8, 'sep': 8, 'sept': 8, 'september': 8,
        'окт': 9, 'окт.': 9, 'октября': 9, 'oct': 9, 'october': 9,
        'ноя': 10, 'нояб': 10, 'нояб.': 10, 'ноября': 10, 'nov': 10, 'november': 10,
        'дек': 11, 'дек.': 11, 'декабря': 11, 'dec': 11, 'december': 11
    },

    parseDates(dateStr) {
        if (!dateStr) return { raw: '', endDate: null, timeLeftStr: 'Неизвестно', isEnded: false };
        let endDate = null;
        let timeLeftStr = 'Активна';
        let isEnded = false;

        try {
            const parts = dateStr.split(/\s*[-–—]\s*/);
            const endPart = (parts.length > 1 ? parts[1] : parts[0]).trim();

            let gmtOffsetHours = 0;
            const gmtMatch = dateStr.match(/(?:GMT|UTC)\s*([+-]\d+)?/i);
            if (gmtMatch && gmtMatch[1]) {
                gmtOffsetHours = parseInt(gmtMatch[1], 10);
            }

            let m = endPart.match(/(\d{1,2})\s+([а-яёa-z.]+)[,\s]+(\d{1,2}):(\d{2})/i);
            if (!m) {
                m = endPart.match(/([a-z]+)\s+(\d{1,2})[,\s]+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i);
                if (m) {
                    const mMonth = m[1];
                    const mDay = m[2];
                    let mHour = parseInt(m[3], 10);
                    const mMins = m[4];
                    const ampm = (m[5] || '').toLowerCase();
                    if (ampm === 'pm' && mHour < 12) mHour += 12;
                    if (ampm === 'am' && mHour === 12) mHour = 0;
                    m = [m[0], mDay, mMonth, String(mHour), mMins];
                }
            }

            if (m) {
                const day = parseInt(m[1], 10);
                const mStr = m[2].toLowerCase().replace(/\.$/, '');
                const month = this.months[mStr] !== undefined ? this.months[mStr] : -1;
                const hour = parseInt(m[3], 10);
                const min = parseInt(m[4], 10);

                if (month !== -1) {
                    const now = new Date();
                    let year = now.getFullYear();
                    const targetUtc = Date.UTC(year, month, day, hour - gmtOffsetHours, min, 0);
                    endDate = new Date(targetUtc);

                    const diffMs = endDate.getTime() - now.getTime();
                    if (diffMs <= 0) {
                        timeLeftStr = 'Кампания завершена';
                        isEnded = true;
                    } else {
                        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
                        const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

                        if (diffDays > 0) {
                            timeLeftStr = `Осталось: ${diffDays} д. ${diffHours} ч.`;
                        } else if (diffHours > 0) {
                            timeLeftStr = `Осталось: ${diffHours} ч. ${diffMins} мин.`;
                        } else {
                            timeLeftStr = `Осталось: ${diffMins} мин.`;
                        }
                    }
                }
            }
        } catch (e) {
            timeLeftStr = dateStr;
        }

        return { raw: dateStr.trim(), endDate: endDate ? endDate.getTime() : null, timeLeftStr, isEnded };
    },

    parseWatchTimeToHMS(text) {
        if (!text) return '01:00:00';
        const hMatch = text.match(/(\d+)\s*(?:hour|hours|hr|h|час|часа|часов)/i);
        const mMatch = text.match(/(\d+)\s*(?:minute|minutes|min|мин|минут|минуты)/i);

        let hours = hMatch ? parseInt(hMatch[1], 10) : 0;
        let mins = mMatch ? parseInt(mMatch[1], 10) : 0;

        if (hours === 0 && mins === 0) return '01:00:00';
        if (mins >= 60) {
            hours += Math.floor(mins / 60);
            mins = mins % 60;
        }
        return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:00`;
    },

    parseCampaignHeaders(fullHtml) {
        const list = [];
        const btnRegex = /<button\b[^>]*aria-expanded="([^"]*)"[^>]*>([\s\S]*?)<\/button>/gi;
        let m;

        while ((m = btnRegex.exec(fullHtml)) !== null) {
            const inner = m[2];
            if (!inner.includes('GMT') && !inner.includes('UTC')) continue;

            const isExpanded = m[1] === 'true';
            const imgM = inner.match(/<img\b[^>]*src="([^"]*)"[^>]*>/i);
            const altM = inner.match(/<img\b[^>]*alt="([^"]*)"[^>]*>/i);
            const coverImg = imgM ? imgM[1] : '';
            const coverAlt = altM ? altM[1] : '';

            const pTags = [...inner.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(x => x[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
            const gameName = pTags[0] || coverAlt || 'Twitch Game';
            const campaignTitle = pTags[1] || '';

            const dateMatch = inner.match(/<div\b[^>]*class="[^"]*bkUUaS[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
                || inner.match(/([а-яa-z]{2,3},\s*\d{1,2}\s+[а-яa-z]+[\s\S]*?(?:GMT|UTC)[^\s<]*)/i);
            const dateStr = dateMatch ? dateMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';

            const dateInfo = this.parseDates(dateStr);

            list.push({
                index: list.length,
                pos: m.index,
                buttonLength: m[0].length,
                gameName,
                campaignTitle,
                coverImg,
                dateStr,
                endDate: dateInfo.endDate,
                timeLeftStr: dateInfo.timeLeftStr,
                isEnded: dateInfo.isEnded,
                isExpanded
            });
        }
        return list;
    },

    extractCampaignChunk(fullHtml, campaignIndex, headersList) {
        const list = headersList || this.parseCampaignHeaders(fullHtml);
        if (campaignIndex < 0 || campaignIndex >= list.length) return null;
        const cur = list[campaignIndex];
        const next = list[campaignIndex + 1];
        const endPos = next ? next.pos : fullHtml.lastIndexOf('</main>');
        return fullHtml.substring(cur.pos, endPos > cur.pos ? endPos : fullHtml.length);
    },

    parseCampaignChunk(chunk) {
        let categoryUrl = '';
        const catMatch = chunk.match(/href="(https:\/\/(?:www\.)?twitch\.tv\/directory\/category\/[^"?]+)/i)
            || chunk.match(/href="(\/directory\/category\/[^"?]+)/i);
        if (catMatch) {
            categoryUrl = (catMatch[1].startsWith('http') ? catMatch[1] : `https://www.twitch.tv${catMatch[1]}`).replace(/\/+$/, '');
        }

        const dropItemSections = chunk.split(/<hr\b[^>]*>/gi);
        const streamerDrops = [];
        const generalDrops = [];
        const dropMedia = {};

        dropItemSections.forEach((sec, idx) => {
            const isSubDrop = (/подпишитесь|подписку|subscribe|gift\s+sub/i.test(sec)) && (!/смотрите\s+в\s+течение|watch\s+for|посмотрите/i.test(sec));
            if (isSubDrop) return;

            const channels = new Set();
            const linkMatches = [...sec.matchAll(/href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)];
            linkMatches.forEach(m => {
                const href = m[1];
                const userMatch = href.match(/(?:twitch\.tv\/|^|\/)([a-zA-Z0-9_]{3,30})$/i);
                if (userMatch) {
                    const u = userMatch[1].toLowerCase();
                    const sys = ['directory', 'drops', 'inventory', 'campaigns', 'settings', 'subscriptions', 'wallet', 'p', 'about', 'help', 'rust', 'team', 'videos', 'jobs', 'blog'];
                    if (!sys.includes(u)) {
                        channels.add(`https://www.twitch.tv/${u}`);
                    }
                }
            });

            // Картинки
            const imgMatches = [...sec.matchAll(/<img\b([^>]*)>/gi)];
            const images = [];
            imgMatches.forEach(im => {
                const srcM = im[1].match(/src="([^"]+)"/i);
                const altM = im[1].match(/alt="([^"]*)"/i);
                if (srcM && !srcM[1].includes('partner-thumbnail')) {
                    images.push({ src: srcM[1], alt: altM ? altM[1].trim() : '' });
                }
            });

            // Награды в li
            const liMatches = [...sec.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)];
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

            if (items.length === 0) {
                const timeMatch = sec.match(/(?:смотрите\s+в\s+течение|watch\s+(?:for\s+)?|посмотрите\s+в\s+течение)\s*(\d+)\s*(hour|hours|hr|h|час|часа|часов|minute|minutes|min|мин|минут|минуты)/i);
                if (timeMatch || images.length > 0) {
                    const watchTime = timeMatch ? this.parseWatchTimeToHMS(timeMatch[0]) : '01:00:00';
                    const strongHeader = sec.match(/<strong\b[^>]*>([^<]+)<\/strong>/i);
                    const rName = (strongHeader && !['награды', 'как получить drop', 'как получить награду', 'обзор'].includes(strongHeader[1].toLowerCase().trim()))
                        ? strongHeader[1].trim()
                        : (images[0] && images[0].alt ? images[0].alt : `Награда ${idx + 1}`);
                    items.push({ rewardName: rName, watchTime });
                }
            }

            items.forEach((item, itemIdx) => {
                const rName = item.rewardName || `Награда ${idx + 1}_${itemIdx + 1}`;
                const safeName = rName.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '_').replace(/^_+|_+$/g, '');
                const hoursPart = parseInt(item.watchTime.split(':')[0], 10) || 1;
                const dropId = `drop_${safeName}_${hoursPart}h${itemIdx > 0 ? '_' + (itemIdx + 1) : ''}`;

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
                    channels: Array.from(channels),
                    imageUrl
                };

                if (dropObj.imageUrl) {
                    dropMedia[dropId] = {
                        imageUrl: dropObj.imageUrl,
                        name: dropObj.name
                    };
                }

                if (channels.size > 0) {
                    streamerDrops.push(dropObj);
                } else {
                    generalDrops.push(dropObj);
                }
            });
        });

        return { categoryUrl, streamerDrops, generalDrops, dropMedia };
    },

    buildConfig(campaignMeta, parsedDetails, existingConfig = {}) {
        const categoryUrl = parsedDetails.categoryUrl || (campaignMeta.gameName ? `https://www.twitch.tv/directory/category/${campaignMeta.gameName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'https://www.twitch.tv/directory');

        const config = {
            searchUrlPart: categoryUrl,
            checkIntervalMinutes: existingConfig.checkIntervalMinutes || 1,
            waitBeforeCheck: existingConfig.waitBeforeCheck !== undefined ? existingConfig.waitBeforeCheck : 20,
            maxAttempts: existingConfig.maxAttempts || 5,
            tempBlacklistSeconds: existingConfig.tempBlacklistSeconds || "0.05.00",
            channels: [],
            groupOrder: [],
            blacklist: {},
            dropMedia: Object.assign({}, existingConfig.dropMedia || {}, parsedDetails.dropMedia || {}),
            campaign: {
                gameName: campaignMeta.gameName,
                title: campaignMeta.campaignTitle || '',
                dateStr: campaignMeta.dateStr || '',
                endDate: campaignMeta.endDate || null,
                timeLeftStr: campaignMeta.timeLeftStr || 'Активна',
                categoryUrl,
                coverImg: campaignMeta.coverImg || ''
            }
        };

        const hasStreamerDrops = parsedDetails.streamerDrops && parsedDetails.streamerDrops.length > 0;
        // Если в кампании есть дропы конкретных стримеров — добавляем ТОЛЬКО их!
        // Категорийные (общие) дропы фармятся фоном на твиче параллельно.
        // Если же стримерских дропов в кампании нет — берем generalDrops.
        const activeDrops = hasStreamerDrops ? parsedDetails.streamerDrops : (parsedDetails.generalDrops || []);

        activeDrops.forEach(d => {
            if (!config.groupOrder.includes(d.dropId)) {
                config.groupOrder.push(d.dropId);
            }
            if (d.channels && d.channels.length > 0) {
                d.channels.forEach(url => {
                    config.channels.push({
                        url,
                        watchTime: d.watchTime,
                        dropId: d.dropId,
                        dropName: d.name,
                        imageUrl: d.imageUrl || ''
                    });
                });
            }
        });

        return config;
    }
};

let cachedCampaignsTabId = null;
let campaignsTabCloseTimeout = null;

function resetCampaignsTabTimeout() {
    if (campaignsTabCloseTimeout) {
        clearTimeout(campaignsTabCloseTimeout);
        campaignsTabCloseTimeout = null;
    }
    // Держим вкладку открытой 3 минуты для быстрых повторных выборов без перезагрузки страницы
    campaignsTabCloseTimeout = setTimeout(() => {
        if (cachedCampaignsTabId !== null) {
            chrome.tabs.remove(cachedCampaignsTabId, () => {
                if (chrome.runtime.lastError) {}
                cachedCampaignsTabId = null;
            });
        }
    }, 180000);
}

function openOrUseBackgroundTab(targetUrl, queryPattern, onReady) {
    resetCampaignsTabTimeout();

    function proceedWithTab(tab, wasCreated) {
        cachedCampaignsTabId = tab.id;
        onReady(tab, wasCreated);
    }

    if (cachedCampaignsTabId !== null) {
        chrome.tabs.get(cachedCampaignsTabId, (tab) => {
            if (!chrome.runtime.lastError && tab && tab.id) {
                proceedWithTab(tab, false);
                return;
            }
            cachedCampaignsTabId = null;
            queryOrOpenTab();
        });
    } else {
        queryOrOpenTab();
    }

    function queryOrOpenTab() {
        chrome.tabs.query({ url: queryPattern }, (tabs) => {
            if (tabs && tabs.length > 0) {
                proceedWithTab(tabs[0], false);
            } else {
                chrome.tabs.create({ url: targetUrl, active: false }, (newTab) => {
                    cachedCampaignsTabId = newTab.id;
                    let loadAttempts = 0;
                    const MAX_LOAD_WAIT_MS = 15000;
                    const CHECK_INTERVAL_MS = 400;

                    function waitForLoad() {
                        chrome.tabs.get(newTab.id, (tab) => {
                            if (chrome.runtime.lastError || !tab) return;
                            if (tab.status === 'complete') {
                                setTimeout(() => proceedWithTab(tab, true), 1000);
                            } else if (loadAttempts * CHECK_INTERVAL_MS < MAX_LOAD_WAIT_MS) {
                                loadAttempts++;
                                setTimeout(waitForLoad, CHECK_INTERVAL_MS);
                            } else {
                                proceedWithTab(tab, true);
                            }
                        });
                    }
                    setTimeout(waitForLoad, 300);
                });
            }
        });
    }
}

function getTwitchCampaignsList(rawHtml, callback) {
    if (typeof rawHtml === 'string' && rawHtml.length > 500) {
        try {
            const list = TwitchCampaignParser.parseCampaignHeaders(rawHtml);
            callback && callback({ ok: true, campaigns: list, fromHtml: true });
        } catch(err) {
            callback && callback({ ok: false, error: 'Ошибка парсинга HTML: ' + err.message });
        }
        return;
    }

    const targetUrl = 'https://www.twitch.tv/drops/campaigns';
    const queryPattern = '*://*.twitch.tv/drops/campaigns*';

    log(`Запрос списка кампаний со страницы ${targetUrl}...`);

    openOrUseBackgroundTab(targetUrl, queryPattern, (tab, wasCreated) => {
        if (!tab || !tab.id) {
            callback && callback({ ok: false, error: 'Не удалось открыть вкладку Twitch Drops' });
            return;
        }

        chrome.tabs.sendMessage(tab.id, { action: "scrapeCampaignsList" }, (resp) => {
            if (resp && resp.ok && Array.isArray(resp.campaigns)) {
                resp.campaigns.forEach(c => {
                    const parsedDates = TwitchCampaignParser.parseDates(c.dateStr);
                    c.timeLeftStr = parsedDates.timeLeftStr;
                    c.isEnded = parsedDates.isEnded;
                    c.endDate = parsedDates.endDate;
                });
                callback && callback({ ok: true, campaigns: resp.campaigns });
            } else {
                callback && callback({ ok: false, error: (resp && resp.error) || 'Не удалось считать список кампаний с вкладки' });
            }
        });
    });
}

function importTwitchCampaignAction(request, callback) {
    const rawHtml = request.html;
    const gameName = request.gameName || '';
    const index = (typeof request.index === 'number') ? request.index : -1;

    if (typeof rawHtml === 'string' && rawHtml.length > 500) {
        try {
            const headers = TwitchCampaignParser.parseCampaignHeaders(rawHtml);
            let targetHeader = null;
            let targetIdx = index;
            if (targetIdx >= 0 && targetIdx < headers.length) {
                targetHeader = headers[targetIdx];
            } else if (gameName) {
                const gnLower = gameName.toLowerCase().trim();
                targetIdx = headers.findIndex(h => h.gameName.toLowerCase().includes(gnLower));
                if (targetIdx !== -1) targetHeader = headers[targetIdx];
            }

            if (!targetHeader) {
                targetHeader = headers[0];
                targetIdx = 0;
            }

            if (!targetHeader) {
                callback && callback({ ok: false, error: 'Кампания не найдена в переданном HTML' });
                return;
            }

            const chunk = TwitchCampaignParser.extractCampaignChunk(rawHtml, targetIdx, headers);
            const parsedDetails = TwitchCampaignParser.parseCampaignChunk(chunk);

            chrome.storage.local.get("userConfig", (data) => {
                const existingConfig = data.userConfig || {};
                const newConfig = TwitchCampaignParser.buildConfig(targetHeader, parsedDetails, existingConfig);

                chrome.storage.local.set({ userConfig: newConfig }, () => {
                    log(`[Кампания] Успешно импортирована кампания "${targetHeader.gameName}" из HTML: каналов ${newConfig.channels.length}, групп наград ${newConfig.groupOrder.length}.`);
                    handleUserConfigChanged(newConfig);
                    callback && callback({
                        ok: true,
                        gameName: targetHeader.gameName,
                        campaign: newConfig.campaign,
                        channelsCount: newConfig.channels.length,
                        groupsCount: newConfig.groupOrder.length,
                        config: newConfig
                    });
                });
            });
        } catch(err) {
            callback && callback({ ok: false, error: 'Ошибка импорта из HTML: ' + err.message });
        }
        return;
    }

    const targetUrl = 'https://www.twitch.tv/drops/campaigns';
    const queryPattern = '*://*.twitch.tv/drops/campaigns*';

    log(`[Кампания] Раскрытие и импорт кампании "${gameName}" с ${targetUrl}...`);

    openOrUseBackgroundTab(targetUrl, queryPattern, (tab, wasCreated) => {
        if (!tab || !tab.id) {
            callback && callback({ ok: false, error: 'Не удалось подключиться к вкладке кампаний Twitch' });
            return;
        }

        chrome.tabs.sendMessage(tab.id, {
            action: "expandAndScrapeCampaign",
            gameName,
            index
        }, (resp) => {
            if (resp && resp.ok && resp.campaign) {
                const cData = resp.campaign;
                const meta = cData.meta || {};
                const parsedDates = TwitchCampaignParser.parseDates(meta.dateStr);

                const campaignMeta = {
                    gameName: meta.gameName || gameName,
                    campaignTitle: meta.campaignTitle || '',
                    coverImg: meta.coverImg || '',
                    dateStr: meta.dateStr || '',
                    endDate: parsedDates.endDate,
                    timeLeftStr: parsedDates.timeLeftStr,
                    categoryUrl: cData.categoryUrl || ''
                };

                chrome.storage.local.get("userConfig", (data) => {
                    const existingConfig = data.userConfig || {};
                    const newConfig = TwitchCampaignParser.buildConfig(campaignMeta, cData, existingConfig);

                    function finishSaveAndRespond() {
                        chrome.storage.local.set({ userConfig: newConfig }, () => {
                            log(`[Кампания] Успешно импортирована кампания "${campaignMeta.gameName}": каналов ${newConfig.channels.length}, групп наград ${newConfig.groupOrder.length}. До конца: ${campaignMeta.timeLeftStr}`);
                            handleUserConfigChanged(newConfig);
                            callback && callback({
                                ok: true,
                                gameName: campaignMeta.gameName,
                                campaign: newConfig.campaign,
                                channelsCount: newConfig.channels.length,
                                groupsCount: newConfig.groupOrder.length,
                                categoryUrl: newConfig.campaign.categoryUrl,
                                config: newConfig
                            });
                        });
                    }

                    // Если в кампании нет каналов (чисто общие дропы категории),
                    // сразу автоматически подтягиваем активные каналы из категории Twitch!
                    if (newConfig.channels.length === 0 && newConfig.campaign && newConfig.campaign.categoryUrl) {
                        log(`[Кампания] В кампании "${campaignMeta.gameName}" нет привязанных стримеров. Автоматический сбор активных стримов из категории ${newConfig.campaign.categoryUrl}...`);
                        fetchCategoryLiveChannelsAction(newConfig.campaign.categoryUrl, (catResp) => {
                            if (catResp && catResp.ok && Array.isArray(catResp.channels) && catResp.channels.length > 0) {
                                const liveChannels = catResp.channels.slice(0, 10);
                                const allDropIds = (newConfig.groupOrder && newConfig.groupOrder.length > 0) ? newConfig.groupOrder : ['drop_general'];
                                allDropIds.forEach(dropId => {
                                    liveChannels.forEach(chUrl => {
                                        newConfig.channels.push({
                                            url: chUrl,
                                            watchTime: '01:00:00',
                                            dropId: dropId,
                                            dropName: campaignMeta.gameName || 'Общий дроп',
                                            imageUrl: (newConfig.dropMedia && newConfig.dropMedia[dropId] && newConfig.dropMedia[dropId].imageUrl) || campaignMeta.coverImg || ''
                                        });
                                    });
                                });
                                log(`[Кампания] Автоматически добавлено ${newConfig.channels.length} стримеров из категории.`);
                            }
                            finishSaveAndRespond();
                        });
                    } else {
                        finishSaveAndRespond();
                    }
                });
            } else {
                callback && callback({ ok: false, error: (resp && resp.error) || 'Не удалось извлечь данные кампании со страницы Twitch' });
            }
        });
    });
}

function fetchCategoryLiveChannelsAction(categoryUrl, callback) {
    if (!categoryUrl) {
        callback && callback({ ok: false, error: 'Не указан URL категории' });
        return;
    }

    const cleanCat = categoryUrl.split('?')[0].replace(/\/+$/, '');
    const url = cleanCat.includes('filter=drops') ? cleanCat : `${cleanCat}?filter=drops`;
    const queryPattern = `*://*.twitch.tv/directory/category/*`;

    log(`[Категория] Сбор активных стримеров с ${url}...`);

    openOrUseBackgroundTab(url, queryPattern, (tab, wasCreated) => {
        if (!tab || !tab.id) {
            callback && callback({ ok: false, error: 'Не удалось открыть категорию' });
            return;
        }

        chrome.tabs.sendMessage(tab.id, { action: "scrapeCategoryChannels" }, (resp) => {
            if (wasCreated) {
                setTimeout(() => {
                    chrome.tabs.remove(tab.id, () => { if (chrome.runtime.lastError) {} });
                }, 10000);
            }

            if (resp && resp.ok && Array.isArray(resp.channels) && resp.channels.length > 0) {
                callback && callback({ ok: true, channels: resp.channels });
            } else {
                callback && callback({ ok: false, error: 'На странице категории не найдено активных стримов' });
            }
        });
    });
}

// =========================================================
// Импорт дропов с Facepunch (Twitch и Kick)
// =========================================================

function parseFacepunchDropsHtml(html, platform = 'twitch') {
    const isKick = platform === 'kick' || html.includes('kick.com/category/rust') || html.includes('kick-logo');
    let detectedCategory = isKick ? 'https://kick.com/category/rust' : 'https://www.twitch.tv/directory/category/rust';

    // Поиск прямой ссылки на категорию игры на странице
    const catMatch = html.match(/href="(https:\/\/(?:www\.)?(?:twitch\.tv\/directory\/category\/|kick\.com\/category\/)[^"]+)"/i);
    if (catMatch) {
        detectedCategory = catMatch[1].split('?')[0].replace(/\/+$/, '');
    }

    // Поиск блоков drop-box (только внешние контейнеры, исключая header/body)
    const boxMatches = [...html.matchAll(/(<(?:div|a)[^>]*class="(?:[^"]*\s)?drop-box(?:\s[^"]*)?"[^>]*>[\s\S]*?)(?=(?:<(?:div|a)[^>]*class="(?:[^"]*\s)?drop-box(?:\s[^"]*)?"[^>]*>)|(?:<\/div>\s*<\/div>\s*<\/section>)|(?:<section)|$)/gi)];

    const streamerDrops = [];
    const generalDropNames = new Set();
    let generalDropsCount = 0;

    boxMatches.forEach((m, idx) => {
        const block = m[1];
        const isLive = block.includes('is-live');

        // 1. Название предмета
        const typeMatch = block.match(/class="drop-type">([^<]+)<\/span>/i) || block.match(/class="drop-type">([^<]+)<\/div>/i);
        const dropName = typeMatch ? typeMatch[1].trim() : `Drop ${idx + 1}`;

        // 2. Время просмотра
        const timeMatch = block.match(/class="drop-time"[\s\S]*?<span>([^<]+)<\/span>/i);
        const rawTime = timeMatch ? timeMatch[1].trim() : '';
        let watchTime = '01:00:00';
        if (rawTime) {
            const hMatch = rawTime.match(/(\d+)\s*(?:hour|h|ч)/i);
            const mMatch = rawTime.match(/(\d+)\s*(?:minute|min|m|м)/i);
            const h = hMatch ? parseInt(hMatch[1], 10) : 0;
            const min = mMatch ? parseInt(mMatch[1], 10) : 0;
            if (h > 0 || min > 0) {
                watchTime = `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:00`;
            }
        }

        // 3. Ссылки на конкретных стримеров
        const streamerLinks = [...block.matchAll(/class="streamer-info"[^>]*href="([^"]+)"/gi)].map(x => x[1])
            .concat([...block.matchAll(/href="([^"]+)"[^>]*class="streamer-info"/gi)].map(x => x[1]));

        const streamerNames = [...block.matchAll(/class="streamer-name">([^<]+)<\/span>/gi)].map(x => x[1].trim());

        const channels = new Set();
        streamerLinks.forEach(l => {
            let clean = l.split('?')[0].replace(/\/+$/, '');
            if (!clean.startsWith('http')) clean = 'https://' + clean;
            if (!clean.includes('/directory/category/') && !clean.includes('/category/')) {
                channels.add(clean);
            }
        });

        // 4. Определение Общих (General) Дропсов:
        // Если стримеров нет, это общий дроп (выдается за просмотр любого стримера категории).
        // Мы не добавляем его в список каналов для просмотра, но берем категорию для searchUrlPart!
        if (channels.size === 0) {
            generalDropsCount++;
            const normName = dropName.toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
            if (normName) generalDropNames.add(normName);

            const boxCat = [...block.matchAll(/href="([^"]+)"/gi)].map(x => x[1]).find(l => l.includes('/directory/category/') || l.includes('/category/'));
            if (boxCat) {
                let cleanCat = boxCat.split('?')[0].replace(/\/+$/, '');
                if (!cleanCat.startsWith('http')) cleanCat = 'https://' + cleanCat;
                detectedCategory = cleanCat;
            }
            return; // Пропускаем общий дроп, в каналы не добавляем
        }

        // 5. Медиа дропа (видео анимация и постер/изображение)
        const videoMatch = block.match(/<source[^>]+src="([^"]+\.mp4[^"]*)"/i) || block.match(/<video[^>]+src="([^"]+\.mp4[^"]*)"/i);
        const videoUrl = videoMatch ? videoMatch[1].trim() : '';

        const imgMatch = block.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"[^>]*title="[^"]*video/i)
            || block.match(/<video[^>]+poster="([^"]+)"/i)
            || block.match(/<source[^>]+src="[^"]+"[\s\S]*?<img[^>]+src="([^"]+)"/i)
            || block.match(/class="drop-box-body"[\s\S]*?<img[^>]+src="([^"]+)"/i)
            || block.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
        const imageUrl = imgMatch ? (imgMatch[1] || imgMatch[2] || '').trim() : '';

        const avatarMatch = block.match(/class="db-avatar"[\s\S]*?<img[^>]+src="([^"]+)"/i);
        const avatarUrl = avatarMatch ? avatarMatch[1].trim() : '';

        const safeStreamerPart = streamerNames.map(s => s.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '')).filter(Boolean).join('_');
        const safeName = dropName.toLowerCase().replace(/[^a-z0-9а-яё]+/g, '_').replace(/^_+|_+$/g, '');
        const dropId = safeStreamerPart ? `${safeStreamerPart}_${safeName}` : `drop_${idx + 1}_${safeName}`;

        streamerDrops.push({
            dropId,
            name: dropName,
            watchTime,
            channels: Array.from(channels),
            streamerNames,
            isLive,
            videoUrl,
            imageUrl,
            avatarUrl
        });
    });

    return {
        categoryUrl: detectedCategory,
        drops: streamerDrops,
        generalDropsCount,
        generalDropNames: Array.from(generalDropNames)
    };
}

function buildConfigFromDrops(drops, platform = 'twitch', existingConfig = {}, categoryUrl = null, generalDropNames = []) {
    const isKick = platform === 'kick';
    const searchUrlPart = categoryUrl || (isKick ? "https://kick.com/category/rust" : "https://www.twitch.tv/directory/category/rust");

    const config = {
        searchUrlPart,
        checkIntervalMinutes: existingConfig.checkIntervalMinutes || 1,
        waitBeforeCheck: (existingConfig.waitBeforeCheck !== undefined) ? existingConfig.waitBeforeCheck : 20,
        maxAttempts: existingConfig.maxAttempts || 5,
        tempBlacklistSeconds: existingConfig.tempBlacklistSeconds || "0.05.00",
        channels: [],
        groupOrder: [],
        blacklist: {},
        generalDropNames: generalDropNames || [],
        dropMedia: Object.assign({}, existingConfig.dropMedia || {})
    };

    // Сначала активные (Live), затем остальные
    const liveDrops = drops.filter(d => d.isLive);
    const nonLiveDrops = drops.filter(d => !d.isLive);
    const orderedDrops = liveDrops.concat(nonLiveDrops);

    orderedDrops.forEach(d => {
        config.groupOrder.push(d.dropId);
        if (d.videoUrl || d.imageUrl) {
            config.dropMedia[d.dropId] = {
                videoUrl: d.videoUrl || '',
                imageUrl: d.imageUrl || '',
                avatarUrl: d.avatarUrl || '',
                name: d.name
            };
        }
        d.channels.forEach(url => {
            config.channels.push({
                url,
                watchTime: d.watchTime,
                dropId: d.dropId,
                dropName: d.name,
                streamerNames: d.streamerNames || [],
                videoUrl: d.videoUrl || '',
                imageUrl: d.imageUrl || '',
                avatarUrl: d.avatarUrl || ''
            });
        });
    });

    return config;
}

function importFacepunchDrops(sourceUrl, platform = 'twitch', callback) {
    const url = sourceUrl || (platform === 'kick' ? 'https://kick.facepunch.com/' : 'https://twitch.facepunch.com/');
    const actualPlatform = url.includes('kick') ? 'kick' : 'twitch';
    log(`Загрузка дропов с ${url}...`);

    fetch(url)
        .then(r => {
            if (!r.ok) throw new Error(`HTTP error ${r.status}`);
            return r.text();
        })
        .then(html => {
            const parsed = parseFacepunchDropsHtml(html, actualPlatform);
            const streamerDrops = parsed.drops;
            if (!streamerDrops || streamerDrops.length === 0) {
                log(`На ${url} не найдено активных стример-дропов (возможно, кампания завершена).`);
                callback && callback({ ok: false, error: 'На странице не найдено доступных стример-дропов' });
                return;
            }

            chrome.storage.local.get("userConfig", (data) => {
                const existingConfig = data.userConfig || {};
                const newConfig = buildConfigFromDrops(streamerDrops, actualPlatform, existingConfig, parsed.categoryUrl, parsed.generalDropNames);
                chrome.storage.local.set({ userConfig: newConfig }, () => {
                    log(`Успешно импортировано ${streamerDrops.length} стример-дропов (${actualPlatform.toUpperCase()}). Пропущено общих дропов: ${parsed.generalDropsCount}. Категория: ${parsed.categoryUrl}`);
                    callback && callback({
                        ok: true,
                        dropsCount: streamerDrops.length,
                        generalDropsCount: parsed.generalDropsCount,
                        categoryUrl: parsed.categoryUrl,
                        platform: actualPlatform
                    });
                });
            });
        })
        .catch(err => {
            log(`Ошибка загрузки с ${url}: ${err.message}`);
            callback && callback({ ok: false, error: err.message });
        });
}

function syncFacepunchMedia(callback) {
    chrome.storage.local.get("userConfig", (data) => {
        let config = data.userConfig;
        if (!config || !Array.isArray(config.channels) || config.channels.length === 0) {
            callback && callback({ ok: false, reason: "no channels in config" });
            return;
        }

        const isKick = (config.searchUrlPart && config.searchUrlPart.includes('kick')) || false;
        const url = isKick ? 'https://kick.facepunch.com/' : 'https://twitch.facepunch.com/';
        const platform = isKick ? 'kick' : 'twitch';

        fetch(url)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP error ${r.status}`);
                return r.text();
            })
            .then(html => {
                const parsed = parseFacepunchDropsHtml(html, platform);
                if (!config.dropMedia) config.dropMedia = {};
                let updated = false;

                parsed.drops.forEach(d => {
                    if (d.videoUrl || d.imageUrl) {
                        config.dropMedia[d.dropId] = {
                            videoUrl: d.videoUrl || '',
                            imageUrl: d.imageUrl || '',
                            avatarUrl: d.avatarUrl || '',
                            name: d.name
                        };
                        updated = true;

                        config.channels.forEach(ch => {
                            if (typeof ch === 'object') {
                                const chDropId = ch.dropId;
                                const chName = ch.dropName || '';
                                if (chDropId === d.dropId || (chName && chName.toLowerCase() === d.name.toLowerCase())) {
                                    ch.videoUrl = d.videoUrl || ch.videoUrl || '';
                                    ch.imageUrl = d.imageUrl || ch.imageUrl || '';
                                    ch.avatarUrl = d.avatarUrl || ch.avatarUrl || '';
                                    if (chDropId && !config.dropMedia[chDropId]) {
                                        config.dropMedia[chDropId] = config.dropMedia[d.dropId];
                                    }
                                }
                            }
                        });
                    }
                });

                if (updated) {
                    chrome.storage.local.set({ userConfig: config }, () => {
                        log(`Синхронизированы анимации и медиа дропов (${Object.keys(config.dropMedia).length} шт.) с ${url}.`);
                        callback && callback({ ok: true, updated: true, mediaCount: Object.keys(config.dropMedia).length });
                    });
                } else {
                    callback && callback({ ok: true, updated: false });
                }
            })
            .catch(err => {
                log(`Ошибка подгрузки медиа с ${url}: ${err.message}`);
                callback && callback({ ok: false, error: err.message });
            });
    });
}

// =========================================================
// Синхронизация прогресса с инвентарём Drops (Twitch и Kick)
// =========================================================

// Функция для прямого выполнения внутри вкладки инвентаря
async function scrapeDropsInventoryInPage() {
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

        // 1. Раскрытие свернутых секций кампаний
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
            // Поиск всех блоков строк текущих кампаний в инвентаре
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

            // Парсим каждый блок текущих кампаний
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

// Поиск соответствия дропа из инвентаря с группами в конфиге (с приоритетом стримеров и поддержкой синонимов)
function findMatchingDropGroup(invDrop, config, knownGeneralDropNames = new Set()) {
    const invDropObj = (typeof invDrop === 'object' && invDrop) ? invDrop : { name: String(invDrop || '') };
    const invName = invDropObj.name || '';
    const lowerName = invName.toLowerCase();

    // 1. Пропуск эмодзи, наград сабскрайбера и сторонних квестов
    if (lowerName.includes('emote') || lowerName.includes('badge') || lowerName.includes('mouseathon')) {
        return null;
    }

    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9а-яё]/gi, '');
    const invStreamers = (invDropObj.streamers || []).map(norm).filter(Boolean);

    // Синонимы и сокращения предметов Rust
    const ALIASES = [
        { from: /\b(db)\b/gi, to: "double barrel" },
        { from: /\b(sar)\b/gi, to: "semi automatic rifle" },
        { from: /\b(ar)\b/gi, to: "assault rifle" },
        { from: /\b(tac\s*gloves)\b/gi, to: "tactical gloves" },
        { from: /\b(wood\s*door)\b/gi, to: "wooden door" },
        { from: /\b(lg\s*box)\b/gi, to: "large wood box" },
        { from: /\b(sm\s*box)\b/gi, to: "small box" },
        { from: /\b(jacket)\b/gi, to: "vagabond jacket" },
        { from: /\b(facemask)\b/gi, to: "metal facemask" },
        { from: /\b(chestplate)\b/gi, to: "metal chestplate" },
        { from: /\b(launcher)\b/gi, to: "rocket launcher" },
        { from: /\b(boonie)\b/gi, to: "boonie hat" },
        { from: /\b(backpack)\b/gi, to: "small backpack" }
    ];

    const expandAliases = (str) => {
        let s = (str || '').toLowerCase();
        for (const a of ALIASES) {
            s = s.replace(a.from, a.to);
        }
        return s;
    };

    const cleanCampaignPrefix = (str) => {
        return (str || '')
            .replace(/^(rust\s*isles|rustoria|global\s*warfare\s*\d+|twitch\s*rivals\s*\d*)\s*/i, '')
            .trim();
    };

    const normInvFull = norm(invName);
    const expandedInvFull = norm(expandAliases(invName));
    const cleanedInvName = cleanCampaignPrefix(invName);
    const expandedInv = expandAliases(cleanedInvName);
    const expandedInvNorm = norm(expandedInv);

    // 2. Построение карты групп из конфига
    const groupMap = {};
    (config.channels || []).forEach(ch => {
        if (!ch.dropId) return;
        if (!groupMap[ch.dropId]) {
            const rawName = ch.dropName || '';
            const cleanedDropName = cleanCampaignPrefix(rawName);
            groupMap[ch.dropId] = {
                dropId: ch.dropId,
                channels: [],
                dropName: rawName,
                dropNameNorm: norm(rawName),
                dropExpandedNorm: norm(expandAliases(rawName)),
                cleanedDropNameNorm: norm(cleanedDropName),
                cleanedDropExpandedNorm: norm(expandAliases(cleanedDropName)),
                streamers: new Set()
            };
        }
        groupMap[ch.dropId].channels.push(ch);

        const user = norm((ch.url || '').split('/').filter(Boolean).pop());
        if (user) groupMap[ch.dropId].streamers.add(user);
        if (Array.isArray(ch.streamerNames)) {
            ch.streamerNames.forEach(s => groupMap[ch.dropId].streamers.add(norm(s)));
        }
    });

    let bestGroup = null;
    let bestScore = 0;

    for (const [dropId, data] of Object.entries(groupMap)) {
        let score = 0;

        // Точное совпадение полного названия (например, "Rust Isles SAR" === "Rust Isles SAR")
        if (normInvFull && (normInvFull === data.dropNameNorm || expandedInvFull === data.dropExpandedNorm)) {
            score += 150;
        } else if (normInvFull.length > 3 && data.dropNameNorm && (data.dropNameNorm.includes(normInvFull) || normInvFull.includes(data.dropNameNorm))) {
            score += 110;
        }

        // Совпадение без префикса кампании и с синонимами (например, "SAR" === "SAR" или "semi automatic rifle")
        if (expandedInvNorm && (expandedInvNorm === data.cleanedDropExpandedNorm || expandedInvNorm === data.cleanedDropNameNorm)) {
            score += 90;
        } else if (expandedInvNorm.length > 3 && data.cleanedDropExpandedNorm && (data.cleanedDropExpandedNorm.includes(expandedInvNorm) || expandedInvNorm.includes(data.cleanedDropExpandedNorm))) {
            score += 70;
        } else {
            // Пословное совпадение значимых токенов
            const invTokens = expandedInv.split(/\s+/).filter(t => t.length > 2);
            const dropTokens = expandAliases(data.dropName).split(/\s+/).filter(t => t.length > 2);
            let matches = 0;
            for (const t of invTokens) {
                if (dropTokens.includes(t)) matches++;
            }
            if (matches > 0) score += matches * 25;
        }

        // 1. Прямое совпадение стримера из инвентаря (+50 очков)
        for (const st of invStreamers) {
            if (data.streamers.has(st) || (st.length > 3 && Array.from(data.streamers).some(ds => ds.includes(st) || st.includes(ds)))) {
                score += 50;
                break;
            }
        }

        // 2. Совпадение имени стримера в названии предмета инвентаря (+30 очков)
        for (const st of data.streamers) {
            if (st.length > 2 && (normInvFull.includes(st) || expandedInvNorm.includes(st))) {
                score += 30;
                break;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestGroup = dropId;
        }
    }

    // 3. Защита от общих/старых не относящихся к делу дропов
    const generalKeywords = ['hoodie', 'pants', 'work boots', 'boots', 'small box', 'sm box', 'large wood box', 'auto turret', 'turret', 'med box'];
    const isGeneral = generalKeywords.some(g => cleanedInvName.toLowerCase() === g || cleanedInvName.toLowerCase().startsWith(g) || g.startsWith(cleanedInvName.toLowerCase()));
    if (isGeneral && invStreamers.length === 0 && bestScore < 80) {
        return null;
    }

    // Пропуск старых дропов прошлых месяцев/лет, ЕСЛИ нет уверенного совпадения по названию или стримеру
    const isOld = invDropObj.timeAgo && (invDropObj.timeAgo.includes('месяц') || invDropObj.timeAgo.includes('month') || invDropObj.timeAgo.includes('год') || invDropObj.timeAgo.includes('year'));
    if (isOld && bestScore < 70) {
        return null;
    }

    return bestScore >= 30 ? bestGroup : null;
}

let lastInventoryApplyTime = 0;
let lastInventoryPayloadHash = '';
let lastInventorySyncResult = { completedCount: 0, syncedCount: 0, untouchedCount: 0, totalScraped: 0 };
let activeStreamProgressTracker = { url: null, dropId: null, lastPercentage: null, stuckSince: 0 };

function applyInventoryData(platform, scrapedDrops, callback) {
    if (!Array.isArray(scrapedDrops) || scrapedDrops.length === 0) {
        log(`[Инвентарь ${platform}] Данные инвентаря пусты или не найдены.`);
        callback && callback({ ok: false, error: 'В инвентаре не найдено активных дропов (возможно, вы не авторизованы)' });
        return;
    }

    // Дедупликация: если точь-в-точь те же данные пришли в течение 4 секунд — не дублируем обработку и логи
    const payloadHash = platform + ':' + scrapedDrops.map(d => `${d.name}:${d.percentage}:${d.isClaimed}`).join('|');
    const now = Date.now();
    if (now - lastInventoryApplyTime < 4000 && lastInventoryPayloadHash === payloadHash) {
        callback && callback({
            ok: true,
            synced: true,
            skippedDuplicate: true,
            completedCount: lastInventorySyncResult.completedCount,
            syncedCount: lastInventorySyncResult.syncedCount,
            untouchedCount: lastInventorySyncResult.untouchedCount,
            totalScraped: lastInventorySyncResult.totalScraped || scrapedDrops.length
        });
        return;
    }
    lastInventoryApplyTime = now;
    lastInventoryPayloadHash = payloadHash;

    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        const config = data.userConfig || { channels: [] };
        let watched = data.totalWatched || totalWatched || {};
        if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

        // Множество известных общих дропов для защиты от ошибочной блокировки
        const defaultGeneral = ['largewoodbox', 'autoturret', 'smallbox', 'pants', 'workboots', 'hoodie'];
        const generalDropNames = new Set((config.generalDropNames || []).concat(defaultGeneral));

        let updatedAny = false;
        let completedCount = 0;
        let syncedCount = 0;
        let untouchedCount = 0;

        const processedGroupIds = new Set();

        scrapedDrops.forEach(invDrop => {
            const matchedDropId = findMatchingDropGroup(invDrop, config, generalDropNames);
            if (!matchedDropId || processedGroupIds.has(matchedDropId)) return;
            processedGroupIds.add(matchedDropId);

            const groupChannels = (config.channels || []).filter(ch => typeof ch === 'object' && ch.dropId === matchedDropId);
            if (groupChannels.length === 0) return;

            const firstUrl = groupChannels[0].url;
            const targetSec = getChannelTargetWatchTime(firstUrl, config);

            if (invDrop.isClaimed || invDrop.percentage >= 100) {
                let needBlacklist = false;
                groupChannels.forEach(ch => {
                    if (config.blacklist[ch.url] !== 'permanent') {
                        config.blacklist[ch.url] = 'permanent';
                        needBlacklist = true;
                    }
                });
                if (targetSec > 0 && (watched[firstUrl] || 0) < targetSec) {
                    watched[firstUrl] = targetSec;
                    updatedAny = true;
                }
                completedCount++;
                if (needBlacklist) {
                    updatedAny = true;
                    log(`[Инвентарь] Дроп "${matchedDropId}" (${invDrop.name}) завершён на 100%! Добавлен в ЧС.`);
                }

                // Если сейчас идет просмотр этого канала, переключаемся
                const curUrl = (currentStreamInfo && currentStreamInfo.url) || (channels[currentChannelIndex] && channels[currentChannelIndex].url);
                const curDropId = curUrl ? getDropId(curUrl, config) : null;
                if (curDropId === matchedDropId && isRunning) {
                    log(`[Синхронизация] Текущий дроп "${matchedDropId}" выполнен на сервере. Переключение на следующий канал.`);
                    stopCurrentStreamSession();
                    nextChannel();
                }
            } else if (invDrop.percentage > 0) {
                const calculatedWatched = Math.floor(targetSec * (invDrop.percentage / 100));
                watched[firstUrl] = calculatedWatched;
                
                // Twitch — высший авторитет. Если на Twitch < 100%, а канал был в permanent ЧС,
                // снимаем постоянный ЧС, чтобы бот мог честно досмотреть его до конца
                let unbannedAny = false;
                groupChannels.forEach(ch => {
                    if (config.blacklist[ch.url] === 'permanent') {
                        delete config.blacklist[ch.url];
                        unbannedAny = true;
                        updatedAny = true;
                    }
                });
                if (unbannedAny) {
                    log(`[Синхронизация] Дроп "${matchedDropId}" снят с постоянного ЧС: на Twitch ${invDrop.percentage}%, требуется досмотреть.`);
                }

                updatedAny = true;
                syncedCount++;
                log(`[Инвентарь] Дроп "${matchedDropId}" (${invDrop.name}) синхронизирован: ${invDrop.percentage}% (${secondsToHMS(calculatedWatched)}).`);
            } else {
                untouchedCount++;
                // 0% - не тронут
                let changedUntouched = false;
                if ((watched[firstUrl] || 0) > 0) {
                    watched[firstUrl] = 0;
                    changedUntouched = true;
                }
                groupChannels.forEach(ch => {
                    if (config.blacklist[ch.url] === 'permanent') {
                        delete config.blacklist[ch.url];
                        changedUntouched = true;
                    }
                });
                if (changedUntouched) updatedAny = true;
            }
        });

        // Сторожевой таймер: проверка, начисляется ли прогресс на текущем активном стриме
        const currentUrl = (currentStreamInfo && currentStreamInfo.url);
        if (currentUrl && isRunning) {
            const currentDropId = getDropId(currentUrl, config);
            if (currentDropId) {
                const activeInvDrop = scrapedDrops.find(d => {
                    const mId = findMatchingDropGroup(d, config, generalDropNames);
                    return mId === currentDropId;
                });

                if (activeInvDrop && activeInvDrop.percentage < 100 && !activeInvDrop.isClaimed) {
                    const curPct = activeInvDrop.percentage;
                    const now = Date.now();

                    if (activeStreamProgressTracker.url !== currentUrl || activeStreamProgressTracker.dropId !== currentDropId) {
                        activeStreamProgressTracker = {
                            url: currentUrl,
                            dropId: currentDropId,
                            lastPercentage: curPct,
                            stuckSince: now
                        };
                    } else {
                        if (curPct > activeStreamProgressTracker.lastPercentage) {
                            activeStreamProgressTracker.lastPercentage = curPct;
                            activeStreamProgressTracker.stuckSince = now;
                        } else {
                            const stuckMinutes = Math.round((now - activeStreamProgressTracker.stuckSince) / 60000);
                            // Если смотрим канал >= 9 минут (3 цикла сверки), а процент на Twitch не сдвинулся:
                            if (stuckMinutes >= 9) {
                                log(`[Внимание] Канал ${currentUrl} не начисляет Drops на Twitch (прогресс застрял на ${curPct}% более ${stuckMinutes} мин). Возможно, стример отключил дропсы или стрим заморожен. Отправляем в ЧС на 15 мин.`);
                                activeStreamProgressTracker = { url: null, dropId: null, lastPercentage: null, stuckSince: 0 };
                                addToBlacklist(currentUrl, 15 * 60);
                                nextChannel();
                            }
                        }
                    }
                }
            }
        }

        if (updatedAny) {
            // Применяем умную сортировку приоритетов:
            // 1. Частично начатые (>0% и <100%) по убыванию % (например, 80% -> #1, 77% -> #2)
            // 2. 0% следом
            // 3. 100% (завершённые) в самый низ
            if (Array.isArray(config.groupOrder) && config.groupOrder.length > 0) {
                config.groupOrder = sortGroupIdsByProgress(config.groupOrder, config, watched);
                syncConfigState(config);
            }
            totalWatched = watched;
            lastInventorySyncResult = { completedCount, syncedCount, untouchedCount, totalScraped: scrapedDrops.length };
            chrome.storage.local.set({ userConfig: config, totalWatched: watched }, () => {
                handleUserConfigChanged(config);
                callback && callback({ ok: true, completedCount, syncedCount, untouchedCount, totalScraped: scrapedDrops.length });
            });
        } else {
            lastInventorySyncResult = { completedCount, syncedCount, untouchedCount, totalScraped: scrapedDrops.length };
            callback && callback({ ok: true, completedCount, syncedCount, untouchedCount, totalScraped: scrapedDrops.length });
        }
    });
}

function performInventorySync(requestedPlatform = 'auto', callback) {
    chrome.storage.local.get("userConfig", (data) => {
        const config = data.userConfig || {};
        let platform = requestedPlatform;
        if (platform === 'auto') {
            platform = (config.searchUrlPart && config.searchUrlPart.includes('kick')) ? 'kick' : 'twitch';
        }

        const invUrl = platform === 'kick' ? 'https://kick.com/drops/inventory' : 'https://www.twitch.tv/drops/inventory';
        const queryUrlPattern = platform === 'kick' ? '*://*.kick.com/drops/inventory*' : '*://*.twitch.tv/drops/inventory*';

        log(`Сверка прогресса с инвентарём ${platform.toUpperCase()} (${invUrl})...`);

        chrome.tabs.query({ url: queryUrlPattern }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const targetTab = tabs[0];

                let attempts = 0;
                let reloaded = false;

                function reloadAndScrape() {
                    if (reloaded) {
                        callback && callback({ ok: false, error: 'Не удалось считать данные из инвентаря после перезагрузки' });
                        return;
                    }
                    reloaded = true;
                    log(`[Инвентарь] Перезагружаем вкладку ${targetTab.id}...`);
                    chrome.tabs.reload(targetTab.id, { bypassCache: true }, () => {
                        let loadAttempts = 0;
                        function waitForLoad() {
                            chrome.tabs.get(targetTab.id, (tab) => {
                                if (chrome.runtime.lastError || !tab) {
                                    callback && callback({ ok: false, error: 'Вкладка инвентаря была закрыта во время обновления' });
                                    return;
                                }
                                if (tab.status === 'complete') {
                                    setTimeout(executeScrape, 2000);
                                } else if (loadAttempts < 16) {
                                    loadAttempts++;
                                    setTimeout(waitForLoad, 500);
                                } else {
                                    executeScrape();
                                }
                            });
                        }
                        setTimeout(waitForLoad, 500);
                    });
                }

                function executeScrape() {
                    attempts++;
                    try {
                        chrome.scripting.executeScript({
                            target: { tabId: targetTab.id },
                            func: scrapeDropsInventoryInPage
                        }, (results) => {
                            let resp = (results && results[0] && results[0].result) ? results[0].result : null;

                            if (!resp || !resp.ok) {
                                safeSendMessage(targetTab.id, { action: "scrapeInventory" }, (msgResp) => {
                                    if (msgResp && msgResp.ok && Array.isArray(msgResp.drops) && msgResp.drops.length > 0) {
                                        applyInventoryData(msgResp.platform || platform, msgResp.drops, callback);
                                    } else if (!reloaded) {
                                        reloadAndScrape();
                                    } else if (attempts < 3) {
                                        setTimeout(executeScrape, 1500);
                                    } else {
                                        const err = (resp && resp.error) || (msgResp && msgResp.error) || 'Не удалось считать данные из открытой вкладки инвентаря';
                                        log(`[Инвентарь] Ошибка считывания: ${err}`);
                                        callback && callback({ ok: false, error: err });
                                    }
                                });
                                return;
                            }

                            if (Array.isArray(resp.drops) && resp.drops.length > 0) {
                                applyInventoryData(resp.platform || platform, resp.drops, callback);
                            } else if (!reloaded) {
                                reloadAndScrape();
                            } else if (attempts < 3) {
                                setTimeout(executeScrape, 1500);
                            } else {
                                if (resp.isLoggedOut) {
                                    callback && callback({ ok: false, error: `Вы не авторизованы на ${platform.toUpperCase()}. Войдите на странице инвентаря.` });
                                } else {
                                    applyInventoryData(resp.platform || platform, resp.drops, callback);
                                }
                            }
                        });
                    } catch (e) {
                        if (!reloaded) {
                            reloadAndScrape();
                        } else {
                            safeSendMessage(targetTab.id, { action: "scrapeInventory" }, (msgResp) => {
                                if (msgResp && msgResp.ok && Array.isArray(msgResp.drops)) {
                                    applyInventoryData(msgResp.platform || platform, msgResp.drops, callback);
                                } else {
                                    callback && callback({ ok: false, error: e.message });
                                }
                            });
                        }
                    }
                }

                // Если вкладка уже загружена (status complete), парсим сразу без лишней перезагрузки!
                if (targetTab.status === 'complete') {
                    executeScrape();
                } else {
                    reloadAndScrape();
                }

                // Запуск парсинга происходит внутри waitForLoad() после полной перезагрузки страницы
            } else {
                chrome.tabs.create({ url: invUrl, active: false }, (tempTab) => {
                    if (!tempTab || !tempTab.id) {
                        callback && callback({ ok: false, error: 'could not create inventory tab' });
                        return;
                    }

                    let finished = false;
                    const cleanup = () => {
                        if (!finished) {
                            finished = true;
                            try { chrome.tabs.remove(tempTab.id); } catch(e) {}
                        }
                    };

                    setTimeout(() => {
                        try {
                            chrome.scripting.executeScript({
                                target: { tabId: tempTab.id },
                                func: scrapeDropsInventoryInPage
                            }, (results) => {
                                cleanup();
                                const resp = (results && results[0] && results[0].result) ? results[0].result : null;
                                if (resp && resp.ok && Array.isArray(resp.drops) && resp.drops.length > 0) {
                                    applyInventoryData(resp.platform || platform, resp.drops, callback);
                                } else {
                                    log(`Страница инвентаря открыта, но данные дропов не загрузились (возможно, требуется авторизация).`);
                                    callback && callback({ ok: false, error: 'В инвентаре не найдено дропов (убедитесь, что вы авторизованы)' });
                                }
                            });
                        } catch(e) {
                            cleanup();
                            callback && callback({ ok: false, error: e.message });
                        }
                    }, 5500);
                });
            }
        });
    });
}

function startInventoryAutoSync() {
    if (inventorySyncInterval) return;
    inventorySyncInterval = setInterval(() => {
        if (isRunning) {
            performInventorySync('auto', () => {});
        }
    }, 3 * 60 * 1000);
}

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

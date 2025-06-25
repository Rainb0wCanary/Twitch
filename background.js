let isRunning = false;
let currentChannelIndex = 0;
let timerInterval = null;
let channels = [];
let searchUrlPart = "";
let defaultWatchTime = 30;
let defaultWaitBeforeCheck = 5;
let logBuffer = [];
let activeTabId = null;
let streamTabId = null; // id вкладки, где крутятся стримы
let totalWatched = {}; // { url: seconds }
let currentStreamInfo = { url: null, secondsLeft: 0 };
let userPrevTabId = null; // id вкладки пользователя до переключения на стрим
let loggingEnabled = false;

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
    // Для popup: если открыт, отправим обновление
    chrome.runtime.sendMessage({ action: "logUpdate", log: logBuffer });
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

function setStreamTab(url, cb) {
    if (streamTabId !== null) {
        // Проверяем, существует ли вкладка
        chrome.tabs.get(streamTabId, tab => {
            if (chrome.runtime.lastError || !tab) {
                // Вкладка была закрыта, создаём новую
                chrome.tabs.create({ url, active: false }, tab => {
                    streamTabId = tab.id;
                    cb && cb();
                });
            } else {
                // Вкладка есть, просто обновляем url
                chrome.tabs.update(streamTabId, { url }, () => cb && cb());
            }
        });
    } else {
        // Вкладка ещё не создана
        chrome.tabs.create({ url, active: false }, tab => {
            streamTabId = tab.id;
            cb && cb();
        });
    }
}

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
                setTimeout(() => {
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
                setTimeout(() => {
                    doFindLink(tabId, url, watchTime, attempt, maxAttempts);
                }, 1500);
            });
        });
    } else {
        // Уже на вкладке со стримом, просто пробуем снова
        setTimeout(() => {
            doFindLink(tabId, url, watchTime, attempt, maxAttempts);
        }, 1000);
    }
}

// Заменяем вызов chrome.tabs.sendMessage на safeSendMessage в doFindLink
function doFindLink(tabId, url, watchTime, attempt, maxAttempts) {
    log(`Проверка наличия ссылки "${searchUrlPart}"... (попытка ${attempt})`);
    safeSendMessage(tabId, { action: "findLink", text: searchUrlPart }, (response) => {
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
        if (response && response.found) {
            log(`Ссылка найдена на ${url}. Остаемся на странице ${watchTime} сек.`);
            if (userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            startWatchTimer(tabId, url, watchTime);
        } else if (attempt < maxAttempts) {
            log(`Ссылка не найдена, повторная попытка...`);
            checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
        } else {
            log(`Ссылка не найдена на ${url} после ${maxAttempts} попыток. Канал будет добавлен в черный список. Переходим к следующему каналу.`);
            if (userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            addToBlacklist(url);
            nextChannel();
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
    let secondsLeft = watchTime;
    currentStreamInfo = { url, secondsLeft };
    let timerStopped = false;
    let linkCheckInterval = null;
    let checkIntervalMs = 2 * 60 * 1000; // по умолчанию 2 минуты

    // Получаем интервал из конфига
    chrome.storage.local.get("userConfig", (data) => {
        let config = data.userConfig;
        if (config && typeof config.checkIntervalMinutes === "number" && config.checkIntervalMinutes > 0) {
            checkIntervalMs = config.checkIntervalMinutes * 60 * 1000;
        }

        // Запускаем основной таймер просмотра
        timerInterval = setInterval(() => {
            if (!isRunning || timerStopped) {
                clearInterval(timerInterval);
                if (linkCheckInterval) clearInterval(linkCheckInterval);
                currentStreamInfo = { url: null, secondsLeft: 0 };
                return;
            }

            chrome.storage.local.get("userConfig", (data) => {
                let config = data.userConfig;
                // Если канал в permanent ЧС — сразу останавливаем таймер и переходим к следующему
                if (config && typeof config.blacklist === "object" && config.blacklist[url] === "permanent") {
                    clearInterval(timerInterval);
                    if (linkCheckInterval) clearInterval(linkCheckInterval);
                    timerStopped = true;
                    currentStreamInfo = { url: null, secondsLeft: 0 };
                    log(`Канал ${url} находится в черном списке навсегда. Таймер остановлен.`);
                    nextChannel();
                    return;
                }

                // Проверяем лимит времени просмотра
                let channel = (config.channels || []).find(
                    ch => (typeof ch === "string" ? ch : ch.url) === url
                );
                let wTime = 0;
                if (channel) {
                    wTime = typeof channel === "string"
                        ? parseTimeToSeconds(config.watchTime)
                        : parseTimeToSeconds(channel.watchTime || config.watchTime);
                }

                // Если лимит достигнут — ставим permanent, останавливаем таймер и переходим к следующему
                if (wTime > 0 && totalWatched[url] >= wTime) {
                    if (config.blacklist[url] !== "permanent") {
                        config.blacklist[url] = "permanent";
                        chrome.storage.local.set({ userConfig: config }, () => {
                            log(`Канал ${url} навсегда добавлен в черный список (достигнуто время просмотра).`);
                        });
                    }
                    clearInterval(timerInterval);
                    if (linkCheckInterval) clearInterval(linkCheckInterval);
                    timerStopped = true;
                    currentStreamInfo = { url: null, secondsLeft: 0 };
                    log(`Время на ${url} истекло (лимит достигнут).`);
                    nextChannel();
                    return;
                }

                // Если лимит не достигнут — продолжаем отсчет
                secondsLeft--;
                currentStreamInfo = { url, secondsLeft };
                if (!totalWatched[url]) totalWatched[url] = 0;
                totalWatched[url]++;
                chrome.storage.local.set({ totalWatched });

                if (secondsLeft <= 0) {
                    clearInterval(timerInterval);
                    if (linkCheckInterval) clearInterval(linkCheckInterval);
                    timerStopped = true;
                    currentStreamInfo = { url: null, secondsLeft: 0 };
                    log(`Время на ${url} истекло.`);
                    nextChannel();
                }
            });
        }, 1000);

        // Запускаем периодическую проверку наличия ссылки
        linkCheckInterval = setInterval(() => {
            if (!isRunning || timerStopped) {
                if (linkCheckInterval) clearInterval(linkCheckInterval);
                return;
            }
            // Получаем searchUrlPart из конфига
            chrome.storage.local.get("userConfig", (data) => {
                let config = data.userConfig;
                let searchUrlPart = config && config.searchUrlPart ? config.searchUrlPart : "";
                safeSendMessage(tabId, { action: "findLink", text: searchUrlPart }, (response) => {
                    if (!response || !response.found) {
                        log(`Ссылка '${searchUrlPart}' пропала во время просмотра ${url}. Досрочно завершаем просмотр.`);
                        clearInterval(timerInterval);
                        if (linkCheckInterval) clearInterval(linkCheckInterval);
                        timerStopped = true;
                        currentStreamInfo = { url: null, secondsLeft: 0 };
                        // Добавляем канал в ЧС на время просмотра
                        addToBlacklist(url, watchTime);
                        nextChannel();
                    }
                });
            });
        }, checkIntervalMs);
    });
}

function nextChannel() {
    if (timerInterval) clearInterval(timerInterval);
    currentChannelIndex++;
    if (isRunning) watchNextChannel();
}

function stopWatching() {
    isRunning = false;
    if (timerInterval) clearInterval(timerInterval);
    currentStreamInfo = { url: null, secondsLeft: 0 };
    log("Просмотр остановлен.");
    // Останавливаем авторазблокировку, если не нужно (по желанию)
    // if (blacklistAutoUnlockInterval) {
    //     clearInterval(blacklistAutoUnlockInterval);
    //     blacklistAutoUnlockInterval = null;
    // }
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
    if (request.action === "getStats") {
        sendResponse({ stats: totalWatched });
    }
    if (request.action === "getCurrentStreamInfo") {
        sendResponse(currentStreamInfo);
    }
    if (request.action === "clearLogs") {
        logBuffer = [];
        chrome.storage.local.set({ logBuffer }, () => {
            sendResponse && sendResponse();
        });
        return true; // async response
    }
    if (request.action === "resetWatchTime" && request.url) {
        // Сбрасываем время и сохраняем даже если оно было 0
        totalWatched[request.url] = 0;
        chrome.storage.local.set({ totalWatched }, () => {
            log(`Суммарное время просмотра для ${request.url} сброшено.`);
            if (typeof sendResponse === "function") sendResponse();
        });
        return true; // async response
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

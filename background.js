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

function log(msg) {
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
        const parts = val.split(".").map(Number);
        // часы.минуты.секунды
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
    const blacklist = Array.isArray(config.blacklist) ? config.blacklist : [];
    channels = config.channels
        .map(ch =>
            typeof ch === "string"
                ? { url: ch, watchTime: parseTimeToSeconds(config.watchTime), waitBeforeCheck: config.waitBeforeCheck }
                : {
                    url: ch.url,
                    watchTime: parseTimeToSeconds(ch.watchTime || config.watchTime),
                    waitBeforeCheck: ch.waitBeforeCheck !== undefined ? ch.waitBeforeCheck : config.waitBeforeCheck
                }
        )
        .filter(ch => !blacklist.includes(ch.url));
    searchUrlPart = config.searchUrlPart || "";
    defaultWatchTime = parseTimeToSeconds(config.watchTime) || 30;
    defaultWaitBeforeCheck = config.waitBeforeCheck || 5;
    isRunning = true;
    currentChannelIndex = 0;
    log("Запуск просмотра каналов...");
    watchNextChannel();
}

function watchNextChannel() {
    if (!isRunning) return;
    if (channels.length === 0) {
        log("Список каналов пуст.");
        return;
    }
    if (currentChannelIndex >= channels.length) currentChannelIndex = 0;
    const { url, watchTime, waitBeforeCheck } = channels[currentChannelIndex];
    log(`Переход на канал: ${url}`);
    setStreamTab(url, () => {
        const waitSec = waitBeforeCheck !== undefined ? waitBeforeCheck : defaultWaitBeforeCheck;
        log(`Ждем ${waitSec} сек. перед проверкой ссылки...`);
        setTimeout(() => {
            checkChannel(streamTabId, url, watchTime || defaultWatchTime);
        }, waitSec * 1000);
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

function doFindLink(tabId, url, watchTime, attempt, maxAttempts) {
    log(`Проверка наличия ссылки "${searchUrlPart}"... (попытка ${attempt})`);
    chrome.tabs.sendMessage(tabId, { action: "findLink", text: searchUrlPart }, (response) => {
        if (chrome.runtime.lastError) {
            log("Ошибка при поиске ссылки.");
            // После всех попыток возвращаем пользователя на его вкладку
            if (attempt >= maxAttempts && userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            nextChannel();
            return;
        }
        if (response && response.found) {
            log(`Ссылка найдена на ${url}. Остаемся на странице ${watchTime} сек.`);
            // После успешной попытки возвращаем пользователя на его вкладку
            if (userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            startWatchTimer(tabId, url, watchTime);
        } else if (attempt < maxAttempts) {
            log(`Ссылка не найдена, повторная попытка...`);
            checkChannel(tabId, url, watchTime, attempt + 1, maxAttempts);
        } else {
            log(`Ссылка не найдена на ${url} после ${maxAttempts} попыток. Переходим к следующему каналу.`);
            // После всех попыток возвращаем пользователя на его вкладку
            if (userPrevTabId && userPrevTabId !== tabId) {
                switchToTab(userPrevTabId);
            }
            nextChannel();
        }
    });
}

function startWatchTimer(tabId, url, watchTime) {
    let secondsLeft = watchTime;
    currentStreamInfo = { url, secondsLeft };
    log(`Осталось на ${url}: ${secondsLeft} сек.`);
    timerInterval = setInterval(() => {
        if (!isRunning) {
            clearInterval(timerInterval);
            currentStreamInfo = { url: null, secondsLeft: 0 };
            return;
        }
        secondsLeft--;
        currentStreamInfo = { url, secondsLeft };
        log(`Осталось на ${url}: ${secondsLeft} сек.`);
        if (!totalWatched[url]) totalWatched[url] = 0;
        totalWatched[url]++;
        chrome.storage.local.set({ totalWatched });
        if (secondsLeft <= 0) {
            clearInterval(timerInterval);
            currentStreamInfo = { url: null, secondsLeft: 0 };
            log(`Время на ${url} истекло.`);
            nextChannel();
        }
    }, 1000);
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
    // Можно закрыть вкладку со стримом, если нужно:
    // if (streamTabId !== null) chrome.tabs.remove(streamTabId);
    // streamTabId = null;
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
});

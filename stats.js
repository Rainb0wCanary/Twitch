function secondsToHMS(sec) {
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Унифицированные вспомогательные функции для сообщений (можно заменить на UI позже)
function showAlert(msg) {
    try { alert(msg); } catch (e) { console.log('Alert:', msg); }
}
function showConfirm(msg) {
    try { return confirm(msg); } catch (e) { console.log('Confirm:', msg); return false; }
}
function showPrompt(msg, defaultVal) {
    try { return prompt(msg, defaultVal); } catch (e) { console.log('Prompt:', msg); return null; }
}

function msToHMS(ms) {
    let sec = Math.ceil(ms / 1000);
    if (sec < 0) sec = 0;
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function updateStatsTable(stats) {
    const tbody = document.querySelector("#statsTable tbody");
    if (!tbody) return;
    // Сохраняем текущую высоту таблицы для предотвращения мерцания
    const prevHeight = tbody.offsetHeight;
    // Используем DocumentFragment для минимизации перерисовок
    const fragment = document.createDocumentFragment();
    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        const config = data.userConfig;
        const blacklist = typeof config?.blacklist === "object" ? config.blacklist : {};
        const channels = Array.isArray(config?.channels) ? config.channels : [];
        const totalWatched = data.totalWatched || {};
        channels.forEach(ch => {
            const url = typeof ch === "string" ? ch : ch.url;
            const sec = stats && stats[url] ? stats[url] : 0;
            // Получаем целевое время просмотра
            let targetSec = 0;
            if (typeof ch === "string") {
                targetSec = config && config.watchTime ? parseTimeToSeconds(config.watchTime) : 0;
            } else {
                targetSec = ch.watchTime ? parseTimeToSeconds(ch.watchTime) : (config && config.watchTime ? parseTimeToSeconds(config.watchTime) : 0);
            }
            let statusText = "";
            let untilText = "";

            if (blacklist[url] === "permanent") {
                statusText = "В ЧС навсегда";
                untilText = "∞";
            } else if (blacklist[url]) {
                const msLeft = blacklist[url] - Date.now();
                statusText = "В ЧС";
                untilText = msLeft > 0 ? msToHMS(msLeft) : "0:00:00";
            } else {
                statusText = "Активен";
                untilText = "";
            }

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></td>
                <td>${secondsToHMS(sec)}</td>
                <td>${secondsToHMS(targetSec)}</td>
                <td>${statusText}</td>
                <td class="table-actions">
                    <button type="button" class="btn btn-sm btn-accent edit-btn" data-url="${url}"><span class="icon">${svgEdit()}</span>Изменить</button>
                    <button type="button" class="btn btn-sm btn-danger delete-btn" data-url="${url}"><span class="icon">${svgDelete()}</span>Удалить</button>
                    <button type="button" class="btn btn-sm btn-warning reset-watch-btn" data-url="${url}"><span class="icon">${svgReset()}</span>Сброс</button>
                    <button type="button" class="btn btn-sm btn-primary blacklist-toggle-btn" data-url="${url}">${blacklist[url] ? 'Разблокировать' : 'В ЧС'}</button>
                </td>
                <td>${untilText}</td>
                <td>
                    <span class="watch-percent" data-url="${url}">--%</span>
                </td>
            `;
            fragment.appendChild(tr);
        });
        // Очищаем только после формирования нового содержимого
        tbody.innerHTML = "";
        tbody.appendChild(fragment);
        // Восстанавливаем высоту, чтобы не было скачков
        tbody.style.minHeight = prevHeight + "px";
        setTimeout(() => { tbody.style.minHeight = ""; }, 100);

    // Удалять обработчики через clone нельзя (могло вызывать двойные клики), поэтому мы перезаписываем контейнер tbody выше

    // Делегированный обработчик кликов по таблице — один обработчик на tbody
        const tbodyEl = document.querySelector('#statsTable tbody');
        if (tbodyEl && !tbodyEl._hasDelegate) {
            tbodyEl.addEventListener('click', function (ev) {
                const btn = ev.target.closest('button');
                if (!btn) return;
                const url = btn.getAttribute('data-url');
                if (!url) return;
                if (btn.classList.contains('edit-btn')) {
                    chrome.storage.local.get('userConfig', (data) => {
                        const cfg = data.userConfig || { channels: [] };
                        const idx = (cfg.channels || []).findIndex(ch => (typeof ch === 'string' ? ch : ch.url) === url);
                        if (idx === -1) return;
                        const ch = cfg.channels[idx];
                        const curUrl = typeof ch === 'string' ? ch : ch.url;
                        const curWatch = typeof ch === 'string' ? '' : (ch.watchTime || '');
                        const newUrl = showPrompt('Изменить URL канала:', curUrl);
                        if (!newUrl) return;
                        const newWatch = showPrompt('Изменить время просмотра (H.MM.SS) или оставьте пустым для значения по умолчанию:', curWatch);
                        const newEntry = newWatch ? { url: newUrl, watchTime: newWatch } : newUrl;
                        cfg.channels[idx] = newEntry;
                        chrome.storage.local.set({ userConfig: cfg }, () => { pollStats(); });
                    });
                    return;
                }
                if (btn.classList.contains('delete-btn')) {
                    if (!showConfirm('Удалить канал ' + url + '?')) return;
                    chrome.storage.local.get('userConfig', (data) => {
                        const cfg = data.userConfig || { channels: [] };
                        cfg.channels = (cfg.channels || []).filter(ch => (typeof ch === 'string' ? ch : ch.url) !== url);
                        chrome.storage.local.set({ userConfig: cfg }, () => { pollStats(); });
                    });
                    return;
                }
                if (btn.classList.contains('reset-watch-btn')) {
                    resetWatchTime(url);
                    return;
                }
                if (btn.classList.contains('blacklist-toggle-btn')) {
                    const text = btn.textContent && btn.textContent.trim();
                    const isUnblock = text === 'Разблокировать';
                    if (isUnblock) {
                        setChannelActive(url, true);
                        return;
                    }
                    const defaultVal = (typeof window !== 'undefined' && window.defaultBlacklistInput) ? window.defaultBlacklistInput : '';
                    const input = showPrompt('Укажите время бана (H.MM.SS) или 0 для перманентного бана. Оставьте пустым для значения по умолчанию:', defaultVal || '');
                    if (input === null) return; // отмена
                    const trimmed = ('' + input).trim();
                    if (trimmed === '' ) {
                        setChannelActive(url, false);
                        return;
                    }
                    if (/^0+$/.test(trimmed)) {
                        chrome.storage.local.get('userConfig', (data) => {
                            const cfg = data.userConfig || {};
                            if (typeof cfg.blacklist !== 'object' || Array.isArray(cfg.blacklist)) cfg.blacklist = {};
                            cfg.blacklist[url] = 'permanent';
                            chrome.storage.local.set({ userConfig: cfg }, () => { pollStats(); });
                        });
                        return;
                    }
                    let seconds = 0;
                    if (/^[0-9]+$/.test(trimmed)) {
                        seconds = Number(trimmed);
                    } else {
                        seconds = parseTimeToSeconds(trimmed);
                    }
                    if (!seconds || seconds <= 0) { showAlert('Неверный формат времени. Используйте H.MM.SS или число секунд.'); return; }
                    const ts = Date.now() + seconds * 1000;
                    chrome.storage.local.get('userConfig', (data) => {
                        const cfg = data.userConfig || {};
                        if (typeof cfg.blacklist !== 'object' || Array.isArray(cfg.blacklist)) cfg.blacklist = {};
                        cfg.blacklist[url] = ts;
                        chrome.storage.local.set({ userConfig: cfg }, () => { pollStats(); });
                    });
                    return;
                }
            });
            tbodyEl._hasDelegate = true;
        }

        // обновляем проценты асинхронно
        document.querySelectorAll('.watch-percent').forEach(el => {
            const url = el.getAttribute('data-url');
            try {
                chrome.runtime.sendMessage({ action: 'getWatchPercent', url }, (resp) => {
                    if (chrome.runtime.lastError) {
                        el.textContent = '--%';
                        return;
                    }
                    if (resp && typeof resp.percent === 'number') {
                        el.textContent = resp.percent + '%';
                        el.title = `${secondsToHMS(resp.watched)} / ${secondsToHMS(resp.targetSec)}`;
                    } else {
                        el.textContent = '--%';
                    }
                });
            } catch (e) {
                el.textContent = '--%';
            }
        });
    });
}

function setChannelActive(url, active) {
    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        let config = data.userConfig;
        const totalWatched = data.totalWatched || {};
        if (!config) return;
        if (typeof config.blacklist !== "object" || Array.isArray(config.blacklist)) config.blacklist = {};
        if (active) {
            // Удалить из blacklist
            delete config.blacklist[url];
        } else {
            // Помещение в ЧС: если конфиг содержит tempBlacklistSeconds — ставим временную метку, иначе permanent
            const tempVal = config.tempBlacklistSeconds || (config.tempBlacklist || null);
            if (tempVal) {
                // parseTimeToSeconds возвращает секунды
                const seconds = parseTimeToSeconds(tempVal);
                const ts = Date.now() + seconds * 1000;
                config.blacklist[url] = ts; // timestamp in ms until when blocked
            } else {
                config.blacklist[url] = "permanent";
            }
        }
        chrome.storage.local.set({ userConfig: config }, () => {
            pollStats();
        });
    });
}

function addToBlacklist(url) {
    chrome.storage.local.get("userConfig", (data) => {
        let config = data.userConfig;
        if (!config) return;
        if (!Array.isArray(config.blacklist)) config.blacklist = [];
        if (!config.blacklist.includes(url)) {
            config.blacklist.push(url);
            chrome.storage.local.set({ userConfig: config }, () => {
                showAlert("Канал добавлен в черный список!");
            });
        }
    });
}

function pollStats() {
    chrome.runtime.sendMessage({ action: "getStats" }, (resp) => {
        if (resp && resp.stats) updateStatsTable(resp.stats);
    });
}

function updateLogView(logArr) {
    const logDiv = document.getElementById("log");
    if (logDiv) {
        logDiv.innerHTML = (logArr || []).join("<br>");
        logDiv.scrollTop = logDiv.scrollHeight;
    }
}

function pollLog() {
    chrome.runtime.sendMessage({ action: "getLog" }, (resp) => {
        if (resp && resp.log) updateLogView(resp.log);
    });
}

function resetWatchTime(url) {
    chrome.runtime.sendMessage({ action: "resetWatchTime", url }, () => {
        // После сброса сразу обновляем таблицу
        pollStats();
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

// SVG-помощники (маленькие монохромные иконки)
function svgEdit(){ return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>` }
function svgDelete(){ return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>` }
function svgReset(){ return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-5 5 5 5 0 0 1-4.9-4H5a7 7 0 0 0 7 7c3.87 0 7-3.13 7-7s-3.13-7-7-7z"/></svg>` }

document.addEventListener("DOMContentLoaded", () => {
    pollStats();
    pollLog();
    setInterval(pollStats, 1000); // обновлять каждую секунду для актуального таймера
    setInterval(pollLog, 2000);

    // Переключатель логов
    const toggleLogs = document.getElementById("toggleLogsCheckbox");
    if (toggleLogs) {
        chrome.runtime.sendMessage({ action: "getLog" }, (resp) => {
            // Если логи пустые, выключаем чекбокс
            if (resp && Array.isArray(resp.log) && resp.log.length === 0) {
                toggleLogs.checked = false;
            }
        });
        toggleLogs.addEventListener("change", function() {
            chrome.runtime.sendMessage({ action: "setLoggingEnabled", enabled: this.checked });
            if (!this.checked) {
                document.getElementById("log").innerHTML = "<i>Логи отключены</i>";
            } else {
                pollLog();
            }
        });
    }

    // Восстановленная загрузка конфига: кнопка вызывает скрытый input, выбранный JSON сохраняется в storage
    const uploadBtn = document.getElementById("uploadConfigButton");
    const fileInput = document.getElementById("configFileInput");
    if (uploadBtn && fileInput) {
        uploadBtn.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", (event) => {
            const file = event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const config = JSON.parse(e.target.result);
                    if (config && config.searchUrlPart) {
                        chrome.storage.local.set({ userConfig: config }, () => {
                            showAlert("Конфиг успешно загружен!");
                            pollStats();
                        });
                    } else {
                        showAlert("В конфиге отсутствует searchUrlPart!");
                    }
                } catch (err) {
                    console.error('Ошибка чтения файла конфига', err);
                    showAlert("Ошибка чтения файла конфига!");
                }
            };
            reader.readAsText(file);
            // очистить input, чтобы можно было снова выбрать тот же файл при повторной загрузке
            fileInput.value = "";
        });
    }

    // Кнопка очистки логов
    const clearBtn = document.getElementById("clearLogsButton");
    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "clearLogs" }, () => {
                pollLog();
            });
        });
    }

    const deleteConfigButton = document.getElementById("deleteConfigButton");
    if (deleteConfigButton) {
        deleteConfigButton.addEventListener("click", function() {
            if (showConfirm("Вы уверены, что хотите полностью удалить конфиг из хранилища браузера? Это действие необратимо.")) {
                chrome.storage.local.remove(["userConfig"], function() {
                    showAlert("Конфиг удалён из хранилища.");
                    location.reload();
                });
            }
        });
    }

    // --- Привязки формы конфигурации ---
    const searchUrlPartInput = document.getElementById('searchUrlPartInput');
    const checkIntervalMinutesInput = document.getElementById('checkIntervalMinutesInput');
    const waitBeforeCheckInput = document.getElementById('waitBeforeCheckInput');
    const maxAttemptsInput = document.getElementById('maxAttemptsInput');
    const tempBlacklistSecondsInput = document.getElementById('tempBlacklistSecondsInput');
    const saveConfigFormButton = document.getElementById('saveConfigFormButton');

    function loadConfigForm() {
        chrome.storage.local.get('userConfig', (data) => {
            const cfg = data.userConfig || {};
            if (searchUrlPartInput) searchUrlPartInput.value = cfg.searchUrlPart || '';
            if (checkIntervalMinutesInput) checkIntervalMinutesInput.value = cfg.checkIntervalMinutes || '';
            if (waitBeforeCheckInput) waitBeforeCheckInput.value = cfg.waitBeforeCheck || '';
            if (maxAttemptsInput) maxAttemptsInput.value = cfg.maxAttempts || '';
            if (tempBlacklistSecondsInput) tempBlacklistSecondsInput.value = cfg.tempBlacklistSeconds || '';
        });
    }

    if (saveConfigFormButton) {
        saveConfigFormButton.addEventListener('click', () => {
            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || {};
                cfg.searchUrlPart = searchUrlPartInput ? searchUrlPartInput.value.trim() : cfg.searchUrlPart;
                cfg.checkIntervalMinutes = checkIntervalMinutesInput ? Number(checkIntervalMinutesInput.value) || cfg.checkIntervalMinutes : cfg.checkIntervalMinutes;
                cfg.waitBeforeCheck = waitBeforeCheckInput ? Number(waitBeforeCheckInput.value) || cfg.waitBeforeCheck : cfg.waitBeforeCheck;
                cfg.maxAttempts = maxAttemptsInput ? Number(maxAttemptsInput.value) || cfg.maxAttempts : cfg.maxAttempts;
                cfg.tempBlacklistSeconds = tempBlacklistSecondsInput ? tempBlacklistSecondsInput.value.trim() || cfg.tempBlacklistSeconds : cfg.tempBlacklistSeconds;
                chrome.storage.local.set({ userConfig: cfg }, () => {
                    showAlert('Конфиг сохранён');
                    pollStats();
                });
            });
        });
    }

    // загрузить текущие значения в форму
    loadConfigForm();

    // --- Добавление строки канала ---
    const newChannelUrlInput = document.getElementById('newChannelUrlInput');
    const newChannelWatchTimeInput = document.getElementById('newChannelWatchTimeInput');
    const addChannelRowButton = document.getElementById('addChannelRowButton');

    if (addChannelRowButton) {
        addChannelRowButton.addEventListener('click', () => {
            const url = newChannelUrlInput ? newChannelUrlInput.value.trim() : '';
            const watchTime = newChannelWatchTimeInput ? newChannelWatchTimeInput.value.trim() : '';
            if (!url) { showAlert('Введите URL канала'); return; }
            // простая валидация URL
            if (!/^https?:\/\/.+/.test(url)) { if (!/^www\./.test(url)) { showAlert('Введите корректный URL'); return; } }
            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || { channels: [] };
                if (!Array.isArray(cfg.channels)) cfg.channels = [];
                const entry = watchTime ? { url, watchTime } : url;
                cfg.channels.push(entry);
                chrome.storage.local.set({ userConfig: cfg }, () => {
                    newChannelUrlInput.value = '';
                    newChannelWatchTimeInput.value = '';
                    pollStats();
                });
            });
        });
    }

});

function secondsToHMS(sec) {
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
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
            let btnText = "";
            let btnClass = "";
            let untilText = "";

            if (blacklist[url] === "permanent") {
                statusText = "В ЧС навсегда";
                btnText = "Сделать активным";
                btnClass = "activate-btn";
                untilText = "∞";
            } else if (blacklist[url]) {
                const msLeft = blacklist[url] - Date.now();
                statusText = "В ЧС";
                btnText = "Сделать активным";
                btnClass = "activate-btn";
                untilText = msLeft > 0 ? msToHMS(msLeft) : "0:00:00";
            } else {
                statusText = "Активен";
                btnText = "Сделать неактивным";
                btnClass = "deactivate-btn";
                untilText = "";
            }

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></td>
                <td>${secondsToHMS(sec)}</td>
                <td>${secondsToHMS(targetSec)}</td>
                <td>${statusText}</td>
                <td>
                    <button type="button" class="${btnClass}" data-url="${url}">${btnText}</button>
                </td>
                <td>${untilText}</td>
                <td>
                    <button type="button" class="reset-watch-btn" data-url="${url}">Сбросить</button>
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

        // Сначала удаляем все старые обработчики (на случай повторного вызова)
        document.querySelectorAll(".deactivate-btn").forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });
        document.querySelectorAll(".activate-btn").forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });
        document.querySelectorAll(".reset-watch-btn").forEach(btn => {
            btn.replaceWith(btn.cloneNode(true));
        });

        // Навешиваем обработчики на новые кнопки
        document.querySelectorAll(".deactivate-btn").forEach(btn => {
            btn.addEventListener("click", function() {
                const url = this.getAttribute("data-url");
                setChannelActive(url, false);
            });
        });
        document.querySelectorAll(".activate-btn").forEach(btn => {
            btn.addEventListener("click", function() {
                const url = this.getAttribute("data-url");
                setChannelActive(url, true);
            });
        });
        document.querySelectorAll(".reset-watch-btn").forEach(btn => {
            btn.addEventListener("click", function() {
                const url = this.getAttribute("data-url");
                resetWatchTime(url);
            });
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
            // Ручное помещение в ЧС — всегда permanent
            config.blacklist[url] = "permanent";
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
                alert("Канал добавлен в черный список!");
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

    // Загрузка конфига
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
                    if (config.searchUrlPart) {
                        chrome.storage.local.set({ userConfig: config }, () => {
                            alert("Конфиг успешно загружен!");
                        });
                    } else {
                        alert("В конфиге отсутствует searchUrlPart!");
                    }
                } catch {
                    alert("Ошибка чтения файла конфига!");
                }
            };
            reader.readAsText(file);
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
            if (confirm("Вы уверены, что хотите полностью удалить конфиг из хранилища браузера? Это действие необратимо.")) {
                chrome.storage.local.remove(["userConfig"], function() {
                    alert("Конфиг удалён из хранилища.");
                    location.reload();
                });
            }
        });
    }
});

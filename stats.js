function secondsToHMS(sec) {
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function updateStatsTable(stats) {
    const tbody = document.querySelector("#statsTable tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    chrome.storage.local.get("userConfig", (data) => {
        const config = data.userConfig;
        const blacklist = Array.isArray(config?.blacklist) ? config.blacklist : [];
        const channels = Array.isArray(config?.channels) ? config.channels : [];

        channels.forEach(ch => {
            const url = typeof ch === "string" ? ch : ch.url;
            const sec = stats && stats[url] ? stats[url] : 0;
            const isActive = !blacklist.includes(url);
            const statusText = isActive ? "Активен" : "Неактивен";
            const btnText = isActive ? "Сделать неактивным" : "Сделать активным";
            const btnClass = isActive ? "deactivate-btn" : "activate-btn";
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${url}</td>
                <td>${secondsToHMS(sec)}</td>
                <td>${statusText}</td>
                <td><button class="${btnClass}" data-url="${url}">${btnText}</button></td>
            `;
            tbody.appendChild(tr);
        });

        // Навешиваем обработчики на кнопки
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
    });
}

function setChannelActive(url, active) {
    chrome.storage.local.get("userConfig", (data) => {
        let config = data.userConfig;
        if (!config) return;
        if (!Array.isArray(config.blacklist)) config.blacklist = [];
        if (active) {
            // Удалить из blacklist
            config.blacklist = config.blacklist.filter(u => u !== url);
        } else {
            // Добавить в blacklist
            if (!config.blacklist.includes(url)) config.blacklist.push(url);
        }
        chrome.storage.local.set({ userConfig: config });
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

document.addEventListener("DOMContentLoaded", () => {
    pollStats();
    pollLog();
    setInterval(pollStats, 2000);
    setInterval(pollLog, 2000);

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
});

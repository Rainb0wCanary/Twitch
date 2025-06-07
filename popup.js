document.addEventListener("DOMContentLoaded", () => {
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
                        // Удаляем прошлый конфиг перед загрузкой нового
                        chrome.storage.local.remove("userConfig", () => {
                            chrome.storage.local.set({ userConfig: config }, () => {
                                alert("Конфиг успешно загружен!");
                            });
                        });
                    } else {
                        alert("В конфиге отсутствует searchUrlPart!");
                    }
                } catch {
                    // Удаляем прошлый конфиг если новый некорректен
                    chrome.storage.local.remove("userConfig", () => {
                        alert("Ошибка чтения файла конфига! Прошлый конфиг удалён.");
                    });
                }
            };
            reader.readAsText(file);
        });
    }

    // Навешиваем обработчики только после полной загрузки DOM
    const startBtn = document.getElementById("startButton");
    const stopBtn = document.getElementById("stopButton");

    if (startBtn) {
        startBtn.addEventListener("click", () => {
            // Проверяем наличие userConfig перед запуском
            chrome.storage.local.get("userConfig", (data) => {
                const hasConfig = !!(data && data.userConfig && data.userConfig.channels && data.userConfig.channels.length);
                if (!hasConfig) {
                    setStatusIndicator(false, false);
                    return;
                }
                startBtn.disabled = true;
                chrome.runtime.sendMessage({ action: "startWatching" });
                setTimeout(() => {
                    updateCurrentTimer();
                    checkConfigAndStatus();
                }, 500);
            });
        });
    }

    if (stopBtn) {
        stopBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "stopWatching" });
            setTimeout(() => {
                updateCurrentTimer();
                checkConfigAndStatus();
            }, 500);
        });
    }

    updateCurrentTimer();
    setInterval(updateCurrentTimer, 1000);
    checkConfigAndStatus();
    setInterval(checkConfigAndStatus, 2000);
});

// Удалите или закомментируйте этот блок, если searchButton отсутствует в popup.html
// document.getElementById("searchButton").addEventListener("click", () => {
//     chrome.storage.local.get("userConfig", (data) => {
//         if (data.userConfig && data.userConfig.searchUrlPart) {
//             runSearch(data.userConfig.searchUrlPart);
//         } else {
//             fetch(chrome.runtime.getURL('config.json'))
//                 .then(response => response.json())
//                 .then(config => {
//                     const inputText = config.searchUrlPart?.trim();
//                     if (!inputText) {
//                         alert("Часть ссылки для поиска не указана в config.json!");
//                         return;
//                     }
//                     runSearch(inputText);
//                 })
//                 .catch(() => alert("Ошибка загрузки config.json!"));
//         }
//     });
// });

function updateCurrentTimer() {
    chrome.runtime.sendMessage({ action: "getCurrentStreamInfo" }, (resp) => {
        const div = document.getElementById("currentTimer");
        if (!div) return;
        if (resp && resp.url) {
            div.innerHTML = `<b>Сейчас:</b><br>${resp.url}<br><b>Осталось:</b> ${secondsToHMS(resp.secondsLeft || 0)}`;
        } else {
            div.textContent = "Нет активного просмотра";
        }
    });
}

function setStatusIndicator(isRunning, hasConfig) {
    const indicator = document.getElementById("statusIndicator");
    const statusText = document.getElementById("statusText");
    const startBtn = document.getElementById("startButton");

    if (!hasConfig) {
        if (indicator) indicator.style.background = "#bbb";
        if (statusText) statusText.textContent = "Конфиг не загружен";
        if (startBtn) startBtn.disabled = true;
        return;
    }

    if (isRunning) {
        if (indicator) indicator.style.background = "#4CAF50";
        if (statusText) statusText.textContent = "Запущено";
        if (startBtn) startBtn.disabled = true;
    } else {
        if (indicator) indicator.style.background = "#f44336";
        if (statusText) statusText.textContent = "Остановлено";
        if (startBtn) startBtn.disabled = false;
    }
}

function checkConfigAndStatus() {
    // Разрешаем запуск только если userConfig есть в storage
    chrome.storage.local.get("userConfig", (data) => {
        const hasConfig = !!(data && data.userConfig && data.userConfig.channels && data.userConfig.channels.length);
        chrome.runtime.sendMessage({ action: "getIsRunning" }, (resp) => {
            setStatusIndicator(resp && resp.isRunning, hasConfig);
        });
    });
}

function secondsToHMS(sec) {
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Дублируем функцию parseTimeToSeconds для popup.js, если она используется
function parseTimeToSeconds(val) {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
        let parts = val.split(/[.,]/).map(Number);
        let h = parts[0] || 0, m = parts[1] || 0, s = parts[2] || 0;
        return h * 3600 + m * 60 + s;
    }
    return 0;
}

// Дублируем функцию resetWatchTime для popup.js, если она используется в popup.html
function resetWatchTime(url) {
    chrome.runtime.sendMessage({ action: "resetWatchTime", url }, () => {
        // После сброса можно обновить UI, если нужно
    });
}

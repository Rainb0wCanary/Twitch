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
                    if (config && config.searchUrlPart && Array.isArray(config.channels) && config.channels.length > 0) {
                        chrome.storage.local.set({ userConfig: config }, () => {
                            showAlert("Конфиг успешно загружен!");
                            checkConfigAndStatus();
                            updateCurrentTimer();
                        });
                    } else if (!config || !config.searchUrlPart) {
                        showAlert("В конфиге отсутствует searchUrlPart!");
                    } else {
                        showAlert("В конфиге отсутствует список channels!");
                    }
                } catch (err) {
                    showAlert("Ошибка чтения файла конфига! Проверьте валидность JSON.");
                } finally {
                    fileInput.value = "";
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
                chrome.runtime.sendMessage({ action: "startWatching" }, () => { if (chrome.runtime.lastError) {/*ignore*/} });
                setTimeout(() => {
                    updateCurrentTimer();
                    checkConfigAndStatus();
                }, 500);
            });
        });
    }

    if (stopBtn) {
        stopBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "stopWatching" }, () => { if (chrome.runtime.lastError) {/*ignore*/} });
            setTimeout(() => {
                updateCurrentTimer();
                checkConfigAndStatus();
            }, 500);
        });
    }

    // Кнопки 'Предыдущий'/'Следующий'
    const prevBtn = document.getElementById('prevButton');
    const nextBtn = document.getElementById('nextButton');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'manualPrev' }, (resp) => {
                if (resp && resp.ok) updateCurrentTimer();
            });
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'manualNext' }, (resp) => {
                if (resp && resp.ok) updateCurrentTimer();
            });
        });
    }

    updateCurrentTimer();
    setInterval(updateCurrentTimer, 1000);
    checkConfigAndStatus();
    setInterval(checkConfigAndStatus, 2000);
});


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
    if (typeof sec !== "number" || isNaN(sec) || sec <= 0) return "0:00:00";
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

// Дублируем функцию resetWatchTime для popup.js, если она используется в popup.html
function resetWatchTime(url) {
    chrome.runtime.sendMessage({ action: "resetWatchTime", url }, () => {
        // После сброса можно обновить UI, если нужно
    });
}

// Унифицированные вспомогательные функции для взаимодействия с пользователем (такие же простые обёртки, как в stats.js)
function showAlert(msg) {
    try { alert(msg); } catch (e) { console.log('Alert:', msg); }
}
function showConfirm(msg) {
    try { return confirm(msg); } catch (e) { console.log('Confirm:', msg); return false; }
}
function showPrompt(msg, def) {
    try { return prompt(msg, def); } catch (e) { console.log('Prompt:', msg); return null; }
}

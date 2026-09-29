document.addEventListener("DOMContentLoaded", () => {
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


let lastRenderedUrl = null;
let lastRenderedDropId = null;

function updateCurrentTimer() {
    chrome.runtime.sendMessage({ action: "getCurrentStreamInfo" }, (resp) => {
        // Обновление плашки активной кампании
        const campBar = document.getElementById("popupCampaignBar");
        const campNameEl = document.getElementById("popupCampaignName");
        const campTimeEl = document.getElementById("popupCampaignTime");
        if (resp && resp.campaign && campNameEl) {
            campNameEl.textContent = resp.campaign.gameName || 'Twitch Кампания';
            if (campTimeEl) {
                campTimeEl.textContent = resp.campaign.timeLeftStr || 'Активна';
                campTimeEl.className = 'popup-campaign-time' + (resp.campaign.isEnded ? ' is-ended' : '');
            }
            if (campBar) campBar.classList.add('has-campaign');
        } else if (campNameEl) {
            campNameEl.textContent = 'Кампания не выбрана';
            if (campTimeEl) {
                campTimeEl.textContent = 'Выбрать →';
                campTimeEl.className = 'popup-campaign-time is-empty';
            }
            if (campBar) campBar.classList.remove('has-campaign');
        }

        const div = document.getElementById("currentTimer");
        if (!div) return;
        if (resp && resp.url) {
            let channelName = resp.url;
            try {
                const u = new URL(resp.url);
                const pathParts = u.pathname.split('/').filter(Boolean);
                if (pathParts.length > 0) channelName = pathParts[0];
            } catch(e) {}

            const target = resp.targetSec || 0;
            const watched = resp.watched || 0;
            const pct = target > 0 ? Math.min(100, Math.round((watched / target) * 100)) : 0;
            const videoUrl = resp.videoUrl || '';
            const imageUrl = resp.imageUrl || '';
            const dropName = resp.dropName || resp.dropId || '';

            // Если стрим или дроп сменился (или первый рендер):
            if (lastRenderedUrl !== resp.url || lastRenderedDropId !== resp.dropId || !div.classList.contains("has-stream")) {
                lastRenderedUrl = resp.url;
                lastRenderedDropId = resp.dropId;

                const dropBadge = dropName ? `<span class="timer-drop-badge" title="Дроп: ${dropName}">${dropName}</span>` : '';
                div.innerHTML = `
                    <div class="timer-card-inner">
                        <div class="timer-stream-header">
                            <div class="timer-live-indicator">
                                <span class="pulse-dot"></span>
                                <span class="live-tag">LIVE</span>
                            </div>
                            <a href="${resp.url}" target="_blank" class="timer-channel-link" title="${resp.url}">${channelName}</a>
                            ${dropBadge}
                        </div>
                        <div class="popup-stream-content">
                            ${(videoUrl || imageUrl) ? `
                            <div class="popup-drop-media" title="${dropName}">
                                ${videoUrl ? `
                                <video class="popup-preview-video" autoplay loop muted playsinline poster="${imageUrl || ''}">
                                    <source src="${videoUrl}" type="video/mp4">
                                    ${imageUrl ? `<img src="${imageUrl}" class="popup-preview-img" alt="${dropName}">` : ''}
                                </video>
                                ` : `
                                <img class="popup-preview-img" src="${imageUrl}" alt="${dropName}">
                                `}
                            </div>
                            ` : ''}
                            <div class="timer-countdown-area">
                                <div class="timer-desc-row">
                                    <span class="timer-desc">Осталось до получения:</span>
                                    <span class="timer-pct-badge">${pct}%</span>
                                </div>
                                <span class="timer-digits">${secondsToHMS(resp.secondsLeft || 0)}</span>
                                <div class="popup-mini-progress">
                                    <div class="popup-mini-bar" style="width: ${pct}%;"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                div.classList.add("has-stream");
            } else {
                // In-place обновление времени без пересоздания DOM, чтобы видео не сбрасывалось каждую секунду
                const digitsEl = div.querySelector('.timer-digits');
                if (digitsEl) digitsEl.textContent = secondsToHMS(resp.secondsLeft || 0);

                const pctBadge = div.querySelector('.timer-pct-badge');
                if (pctBadge) pctBadge.textContent = `${pct}%`;

                const miniBar = div.querySelector('.popup-mini-bar');
                if (miniBar) miniBar.style.width = `${pct}%`;
            }
        } else {
            lastRenderedUrl = null;
            lastRenderedDropId = null;
            if (div.classList.contains("has-stream") || !div.querySelector(".timer-idle")) {
                div.innerHTML = `
                    <div class="timer-idle">
                        <span class="timer-idle-icon">💤</span>
                        <span class="timer-idle-text">Нет активного просмотра</span>
                    </div>
                `;
                div.classList.remove("has-stream");
            }
        }
    });
}

function setStatusIndicator(isRunning, hasConfig) {
    const indicator = document.getElementById("statusIndicator");
    const statusText = document.getElementById("statusText");
    const startBtn = document.getElementById("startButton");
    const stopBtn = document.getElementById("stopButton");

    if (!hasConfig) {
        if (indicator) {
            indicator.style.background = "var(--text-muted, #64748b)";
            indicator.classList.remove("pulse");
        }
        if (statusText) statusText.textContent = "Конфиг не загружен";
        if (startBtn) {
            startBtn.style.display = "inline-flex";
            startBtn.disabled = true;
        }
        if (stopBtn) stopBtn.style.display = "none";
        return;
    }

    if (isRunning) {
        if (indicator) {
            indicator.style.background = "var(--accent-emerald, #10b981)";
            indicator.classList.add("pulse");
        }
        if (statusText) statusText.textContent = "В эфире";
        if (startBtn) startBtn.style.display = "none";
        if (stopBtn) {
            stopBtn.style.display = "inline-flex";
            stopBtn.disabled = false;
        }
    } else {
        if (indicator) {
            indicator.style.background = "var(--text-muted, #64748b)";
            indicator.classList.remove("pulse");
        }
        if (statusText) statusText.textContent = "Остановлено";
        if (startBtn) {
            startBtn.style.display = "inline-flex";
            startBtn.disabled = false;
        }
        if (stopBtn) stopBtn.style.display = "none";
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

// =========================================================
// Вспомогательные функции форматирования и парсинга времени
// =========================================================

function secondsToHMS(sec) {
    if (typeof sec !== "number" || isNaN(sec) || sec <= 0) return "0:00:00";
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function msToHMS(ms) {
    let sec = Math.ceil(ms / 1000);
    if (sec <= 0) return "0:00:00";
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
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
            return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60;
        }
        return parts[0] || 0;
    }
    return 0;
}

function normalizeChannelUrl(rawUrl) {
    if (!rawUrl) return '';
    let url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
    }
    try {
        const u = new URL(url);
        const cleanPath = u.pathname.replace(/\/+$/, '');
        return `${u.protocol}//${u.host.toLowerCase()}${cleanPath}`;
    } catch (e) {
        return url.replace(/\/+$/, '');
    }
}

// Плавная интерполяция цвета прогресса для современного тёмного интерфейса
function getProgressColors(percent) {
    const p = Math.min(100, Math.max(0, percent));
    if (p === 0) {
        return {
            color: '#64748b',
            barGradient: 'linear-gradient(90deg, #334155, #475569)',
            badgeBg: 'rgba(100, 116, 139, 0.25)',
            borderLeft: '#334155',
            cardGlow: '0 4px 16px rgba(0, 0, 0, 0.2)',
            tintBg: 'rgba(18, 23, 34, 0.85)'
        };
    }
    if (p >= 100) {
        return {
            color: '#10b981',
            barGradient: 'linear-gradient(90deg, #059669, #10b981)',
            badgeBg: 'rgba(16, 185, 129, 0.2)',
            borderLeft: '#10b981',
            cardGlow: '0 4px 20px rgba(16, 185, 129, 0.18)',
            tintBg: 'rgba(16, 185, 129, 0.03)'
        };
    }
    // В процессе (1% - 99%): Twitch фиолетовый переходящий в неоновый cyan
    return {
        color: '#9146ff',
        barGradient: 'linear-gradient(90deg, #9146ff, #06b6d4)',
        badgeBg: 'rgba(145, 70, 255, 0.25)',
        borderLeft: '#9146ff',
        cardGlow: '0 4px 20px rgba(145, 70, 255, 0.18)',
        tintBg: 'rgba(145, 70, 255, 0.03)'
    };
}

// Сообщения
function showAlert(msg) {
    try { alert(msg); } catch (e) { console.log('Alert:', msg); }
}
function showConfirm(msg) {
    try { return confirm(msg); } catch (e) { console.log('Confirm:', msg); return false; }
}
function showPrompt(msg, defaultVal) {
    try { return prompt(msg, defaultVal); } catch (e) { console.log('Prompt:', msg); return null; }
}

function getGroupProgressPercent(dropId, config, totalWatched) {
    if (!dropId || !config || !Array.isArray(config.channels)) return 0;
    const groupCh = config.channels.find(ch => typeof ch === 'object' && ch.dropId === dropId && ch.watchTime);
    const targetSec = groupCh ? parseTimeToSeconds(groupCh.watchTime) : parseTimeToSeconds(config.watchTime || '1:00:00');
    if (targetSec <= 0) return 0;

    const urls = config.channels
        .filter(ch => typeof ch === 'object' && ch.dropId === dropId)
        .map(ch => ch.url);
    let watchedSec = 0;
    const map = totalWatched || {};
    urls.forEach(u => { watchedSec += (map[u] || 0); });
    return Math.min(100, Math.round((watchedSec / targetSec) * 100));
}

function sortGroupIdsByProgress(groupIds, config, totalWatched) {
    if (!Array.isArray(groupIds)) return [];
    const ids = [...groupIds];
    const map = totalWatched || {};

    ids.sort((a, b) => {
        const pA = getGroupProgressPercent(a, config, map);
        const pB = getGroupProgressPercent(b, config, map);

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

        // 3. Среди частично начатых: чем ближе к завершению (выше процент), тем выше приоритет (убывание: 80% выше 77%)
        if (hasStartedA && hasStartedB) {
            if (pB !== pA) return pB - pA;
        }

        // 4. Если оба 0% или равны, сохраняем исходный порядок
        return 0;
    });

    return ids;
}

// =========================================================
// Активная кампания Twitch Drops (баннер и оставшееся время)
// =========================================================

function renderActiveCampaignBanner(campaign) {
    const coverImg = document.getElementById('campaignCoverImg');
    const coverPlaceholder = document.getElementById('campaignCoverPlaceholder');
    const gameNameEl = document.getElementById('campaignGameName');
    const badgeEl = document.getElementById('campaignBadgeTime');
    const titleSubEl = document.getElementById('campaignTitleSub');
    const dot1 = document.getElementById('campaignMetaDot1');
    const dateRangeEl = document.getElementById('campaignDateRange');
    const dot2 = document.getElementById('campaignMetaDot2');
    const catLink = document.getElementById('campaignCategoryLink');

    if (!gameNameEl || !badgeEl) return;

    if (campaign && (campaign.gameName || campaign.title)) {
        gameNameEl.textContent = campaign.gameName || campaign.title;

        // Обложка игры
        if (campaign.coverImg && coverImg) {
            coverImg.src = campaign.coverImg;
            coverImg.style.display = 'block';
            if (coverPlaceholder) coverPlaceholder.style.display = 'none';
            coverImg.onerror = () => {
                coverImg.style.display = 'none';
                if (coverPlaceholder) coverPlaceholder.style.display = 'block';
            };
        } else {
            if (coverImg) coverImg.style.display = 'none';
            if (coverPlaceholder) coverPlaceholder.style.display = 'block';
        }

        // Подзаголовок / название кампании
        if (titleSubEl) {
            if (campaign.title && campaign.title !== campaign.gameName) {
                titleSubEl.textContent = campaign.title;
                titleSubEl.style.display = 'inline';
            } else {
                titleSubEl.textContent = 'Активная кампания Drops';
                titleSubEl.style.display = 'inline';
            }
        }

        // Сроки кампании
        if (dateRangeEl) {
            if (campaign.dateStr) {
                dateRangeEl.textContent = `📅 ${campaign.dateStr}`;
                dateRangeEl.style.display = 'inline';
                if (dot1) dot1.style.display = 'inline';
            } else {
                dateRangeEl.style.display = 'none';
                if (dot1) dot1.style.display = 'none';
            }
        }

        // Ссылка на категорию Twitch
        if (catLink) {
            if (campaign.categoryUrl) {
                catLink.href = campaign.categoryUrl;
                catLink.style.display = 'inline-flex';
                if (dot2) dot2.style.display = 'inline';
            } else {
                catLink.style.display = 'none';
                if (dot2) dot2.style.display = 'none';
            }
        }

        // Бейдж оставшегося времени кампании
        badgeEl.className = 'badge-time-left';
        const timeLeft = campaign.timeLeftStr || '';
        const isEnded = campaign.isEnded || timeLeft.includes('Завершен') || timeLeft.includes('Истекло');

        if (isEnded) {
            badgeEl.classList.add('badge-ended');
            badgeEl.textContent = '⌛ Завершена';
        } else if (timeLeft) {
            if (timeLeft.includes('мин') && !timeLeft.includes('д') && !timeLeft.includes('ч')) {
                badgeEl.classList.add('badge-urgent');
            }
            badgeEl.textContent = `⏳ ${timeLeft}`;
        } else {
            badgeEl.classList.add('badge-neutral');
            badgeEl.textContent = 'Активна';
        }
    } else {
        // Кампания не выбрана
        gameNameEl.textContent = 'Кампания не выбрана';
        if (coverImg) coverImg.style.display = 'none';
        if (coverPlaceholder) coverPlaceholder.style.display = 'block';
        if (titleSubEl) titleSubEl.textContent = 'Нажмите «Выбрать кампанию», чтобы загрузить актуальные дропсы';
        if (dot1) dot1.style.display = 'none';
        if (dateRangeEl) dateRangeEl.style.display = 'none';
        if (dot2) dot2.style.display = 'none';
        if (catLink) catLink.style.display = 'none';

        badgeEl.className = 'badge-time-left badge-neutral';
        badgeEl.textContent = 'Не выбрана';
    }
}

// =========================================================
// Отрисовка карточного интерфейса
// =========================================================

function renderCardsView() {
    const container = document.getElementById('groupsContainer');
    if (!container) return;

    // Сохраняем фокус и значения инпутов добавления каналов перед перерисовкой
    const activeEl = document.activeElement;
    let focusedInputDropId = null;
    let focusedInputValue = '';
    if (activeEl && activeEl.classList.contains('add-channel-input')) {
        focusedInputDropId = activeEl.getAttribute('data-dropid');
        focusedInputValue = activeEl.value;
    }

    chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
        const config = data.userConfig || { channels: [] };
        const totalWatched = data.totalWatched || {};

        // Обновляем верхний баннер активной кампании
        renderActiveCampaignBanner(config.campaign);

        const blacklist = (typeof config.blacklist === 'object' && !Array.isArray(config.blacklist)) ? config.blacklist : {};
        const channels = Array.isArray(config.channels) ? config.channels : [];
        const groupOrder = Array.isArray(config.groupOrder) ? config.groupOrder : [];
        const dropMedia = (config && typeof config.dropMedia === 'object') ? config.dropMedia : {};

        // Группируем каналы
        const groups = {};
        const ungrouped = [];

        channels.forEach(ch => {
            const url = typeof ch === 'string' ? ch : ch.url;
            const dropId = (typeof ch === 'object' && ch.dropId) ? ch.dropId : null;
            const watchTime = typeof ch === 'object' ? ch.watchTime : null;
            const dropName = (typeof ch === 'object' && ch.dropName) ? ch.dropName : dropId;

            if (dropId) {
                if (!groups[dropId]) {
                    groups[dropId] = {
                        dropId,
                        dropName,
                        watchTime: watchTime || config.watchTime || '1:00:00',
                        channels: []
                    };
                }
                groups[dropId].channels.push({ url, ch, watchTime });
            } else {
                ungrouped.push({ url, ch, watchTime });
            }
        });

        // Гарантируем наличие всех групп из groupOrder в объекте groups
        groupOrder.forEach(gId => {
            if (!groups[gId]) {
                const media = dropMedia[gId] || {};
                groups[gId] = {
                    dropId: gId,
                    dropName: media.name || gId.replace(/^drop_/, '').replace(/_/g, ' '),
                    watchTime: config.watchTime || '01:00:00',
                    channels: []
                };
            }
        });

        // Сортировка групп согласно приоритету (groupOrder)
        const existingGroupIds = Object.keys(groups);
        let sortedGroupIds = groupOrder.filter(id => groups[id]).concat(
            existingGroupIds.filter(id => !groupOrder.includes(id))
        );

        // Перемещаем завершенные на 100% группы в самый низ очереди приоритета единожды,
        // если за ними следуют ещё не завершенные (<100%)
        let orderShifted = false;
        for (let i = 0; i < sortedGroupIds.length - 1; i++) {
            const gId = sortedGroupIds[i];
            const p = getGroupProgressPercent(gId, config, totalWatched);
            if (p >= 100) {
                const hasIncompleteAfter = sortedGroupIds.slice(i + 1).some(otherId => getGroupProgressPercent(otherId, config, totalWatched) < 100);
                if (hasIncompleteAfter) {
                    sortedGroupIds.splice(i, 1);
                    sortedGroupIds.push(gId);
                    orderShifted = true;
                    i--;
                }
            }
        }

        // Если порядок изменился из-за добавления новых групп или смещения 100% групп вниз — сохраняем
        if (orderShifted || JSON.stringify(sortedGroupIds) !== JSON.stringify(groupOrder)) {
            config.groupOrder = sortedGroupIds;
            chrome.storage.local.set({ userConfig: config });
        }

        // Обновляем верхние сводные счетчики (Обзор статистики)
        let totalWatchedAllSec = 0;
        let inProgressCount = 0;
        let completedCount = 0;

        for (const dropId of sortedGroupIds) {
            const p = getGroupProgressPercent(dropId, config, totalWatched);
            if (p >= 100) completedCount++;
            else if (p > 0) inProgressCount++;
        }
        for (const url in totalWatched) {
            totalWatchedAllSec += (totalWatched[url] || 0);
        }

        const elTotal = document.getElementById('statTotalDrops');
        if (elTotal) elTotal.textContent = sortedGroupIds.length;
        const elInProg = document.getElementById('statInProgress');
        if (elInProg) elInProg.textContent = inProgressCount;
        const elComp = document.getElementById('statCompleted');
        if (elComp) elComp.textContent = completedCount;
        const elTime = document.getElementById('statTotalTime');
        if (elTime) elTime.textContent = secondsToHMS(totalWatchedAllSec);

        const now = Date.now();

        // Проверяем, существует ли уже точная структура карточек в DOM для in-place обновления
        // Это предотвращает мигание, сброс видео <video> на 0:00, потерю фокуса и дергания каждую секунду
        const existingCardEls = Array.from(container.querySelectorAll(':scope > .drop-card[data-dropid]'));
        const existingCardIds = existingCardEls.map(el => el.getAttribute('data-dropid'));
        const existingUngroupedCard = container.querySelector(':scope > .drop-card.ungrouped-card');
        const needsUngrouped = ungrouped.length > 0;

        let canUpdateInPlace = (
            existingCardIds.length === sortedGroupIds.length &&
            existingCardIds.every((id, idx) => id === sortedGroupIds[idx]) &&
            (!!existingUngroupedCard === needsUngrouped)
        );

        if (canUpdateInPlace) {
            for (let i = 0; i < sortedGroupIds.length; i++) {
                const dropId = sortedGroupIds[i];
                const cardEl = existingCardEls[i];
                const group = groups[dropId];
                const channelEls = Array.from(cardEl.querySelectorAll('.channel-item[data-url]'));
                if (channelEls.length !== group.channels.length) {
                    canUpdateInPlace = false;
                    break;
                }
                const allUrlsMatch = group.channels.every((item, ci) => channelEls[ci].getAttribute('data-url') === item.url);
                if (!allUrlsMatch) {
                    canUpdateInPlace = false;
                    break;
                }
            }
        }

        if (canUpdateInPlace && needsUngrouped && existingUngroupedCard) {
            const channelEls = Array.from(existingUngroupedCard.querySelectorAll('.channel-item[data-url]'));
            if (channelEls.length !== ungrouped.length) {
                canUpdateInPlace = false;
            } else {
                const allUrlsMatch = ungrouped.every((item, ci) => channelEls[ci].getAttribute('data-url') === item.url);
                if (!allUrlsMatch) canUpdateInPlace = false;
            }
        }

        if (canUpdateInPlace) {
            // Быстрое in-place обновление чисел, бейджей и прогресс-баров без пересоздания DOM
            sortedGroupIds.forEach((dropId, index) => {
                const group = groups[dropId];
                const cardEl = existingCardEls[index];
                const priorityNumber = index + 1;
                const targetSeconds = parseTimeToSeconds(group.watchTime);

                let groupTotalTime = 0;
                let blockedCount = 0;
                group.channels.forEach(item => {
                    groupTotalTime += (totalWatched[item.url] || 0);
                    if (blacklist[item.url]) {
                        if (blacklist[item.url] === 'permanent' || blacklist[item.url] > now) {
                            blockedCount++;
                        }
                    }
                });

                const allChannelsBlocked = group.channels.length > 0 && blockedCount === group.channels.length;
                const progress = targetSeconds > 0 ? Math.min(100, Math.round((groupTotalTime / targetSeconds) * 100)) : 0;
                const colors = getProgressColors(progress);

                cardEl.style.borderLeftColor = colors.borderLeft;
                cardEl.style.background = colors.tintBg;
                cardEl.style.boxShadow = colors.cardGlow;

                const priorityBadge = cardEl.querySelector('.priority-badge');
                if (priorityBadge) {
                    priorityBadge.textContent = `#${priorityNumber}`;
                    priorityBadge.setAttribute('data-priority', priorityNumber);
                }
                const upBtn = cardEl.querySelector('.move-group-up');
                if (upBtn) upBtn.disabled = (index === 0);
                const downBtn = cardEl.querySelector('.move-group-down');
                if (downBtn) downBtn.disabled = (index === sortedGroupIds.length - 1);

                const toggleGroupBtn = cardEl.querySelector('.toggle-group-blacklist-btn');
                if (toggleGroupBtn) {
                    toggleGroupBtn.className = `btn btn-xs ${allChannelsBlocked ? 'btn-success' : 'btn-danger-outline'} toggle-group-blacklist-btn`;
                    toggleGroupBtn.textContent = allChannelsBlocked ? '✓ Разблок' : '⛔ В ЧС';
                    toggleGroupBtn.title = allChannelsBlocked ? 'Разблокировать все каналы группы' : 'Заблокировать все каналы группы';
                }

                const targetEl = cardEl.querySelector('.metric-target');
                if (targetEl) targetEl.textContent = secondsToHMS(targetSeconds);

                const watchedEl = cardEl.querySelector('.metric-watched');
                if (watchedEl) watchedEl.textContent = secondsToHMS(groupTotalTime);

                const percentBadge = cardEl.querySelector('.progress-percent-badge');
                if (percentBadge) {
                    percentBadge.textContent = `${progress === 100 ? '✓ ' : ''}${progress}%`;
                    percentBadge.style.background = colors.badgeBg;
                }

                const progressBar = cardEl.querySelector('.drop-progress-bar');
                if (progressBar) {
                    progressBar.style.width = `${progress}%`;
                    progressBar.style.background = colors.barGradient;
                }

                const channelEls = cardEl.querySelectorAll('.channel-item[data-url]');
                group.channels.forEach((item, ci) => {
                    const li = channelEls[ci];
                    if (!li) return;
                    const url = item.url;
                    const watched = totalWatched[url] || 0;
                    const isBlocked = !!blacklist[url];
                    const isPermanent = blacklist[url] === 'permanent';
                    const msLeft = (!isPermanent && isBlocked) ? (blacklist[url] - now) : 0;
                    const isBlockedNow = isPermanent || msLeft > 0;

                    const timeEl = li.querySelector('.channel-time');
                    if (timeEl) timeEl.textContent = secondsToHMS(watched);

                    const statusEl = li.querySelector('.channel-status');
                    if (statusEl) {
                        if (targetSeconds > 0 && groupTotalTime >= targetSeconds) {
                            statusEl.className = 'channel-status status-badge-completed';
                            statusEl.title = 'Цель группы достигнута';
                            statusEl.textContent = '✓ Завершён';
                        } else if (isPermanent) {
                            statusEl.className = 'channel-status status-badge-permanent';
                            statusEl.title = 'Канал заблокирован навсегда';
                            statusEl.textContent = '⛔ ЧС (навсегда)';
                        } else if (isBlockedNow) {
                            statusEl.className = 'channel-status status-badge-blacklist';
                            statusEl.title = `Осталось: ${msToHMS(msLeft)}`;
                            statusEl.textContent = `⏳ В ЧС (${msToHMS(msLeft)})`;
                        } else {
                            statusEl.className = 'channel-status status-badge-active';
                            statusEl.title = '';
                            statusEl.textContent = '● Активен';
                        }
                    }

                    const toggleChanBtn = li.querySelector('.toggle-channel-blacklist-btn');
                    if (toggleChanBtn) {
                        toggleChanBtn.className = `btn btn-xs btn-icon-only ${isBlockedNow ? 'btn-success' : 'btn-danger'} toggle-channel-blacklist-btn`;
                        toggleChanBtn.textContent = isBlockedNow ? '✓' : '⛔';
                        toggleChanBtn.title = isBlockedNow ? 'Разблокировать' : 'Отправить в чёрный список';
                    }
                });
            });

            if (needsUngrouped && existingUngroupedCard) {
                const unchEls = existingUngroupedCard.querySelectorAll('.channel-item[data-url]');
                ungrouped.forEach((item, ci) => {
                    const li = unchEls[ci];
                    if (!li) return;
                    const url = item.url;
                    const watched = totalWatched[url] || 0;
                    const isBlocked = !!blacklist[url];
                    const isPermanent = blacklist[url] === 'permanent';
                    const msLeft = (!isPermanent && isBlocked) ? (blacklist[url] - now) : 0;
                    const isBlockedNow = isPermanent || msLeft > 0;
                    const targetSec = parseTimeToSeconds(item.watchTime || config.watchTime);

                    const timeEl = li.querySelector('.channel-time');
                    if (timeEl) timeEl.textContent = secondsToHMS(watched);

                    const statusEl = li.querySelector('.channel-status');
                    if (statusEl) {
                        if (targetSec > 0 && watched >= targetSec) {
                            statusEl.className = 'channel-status status-badge-completed';
                            statusEl.title = 'Цель достигнута';
                            statusEl.textContent = '✓ Завершён';
                        } else if (isPermanent) {
                            statusEl.className = 'channel-status status-badge-permanent';
                            statusEl.textContent = '⛔ ЧС (навсегда)';
                        } else if (isBlockedNow) {
                            statusEl.className = 'channel-status status-badge-blacklist';
                            statusEl.textContent = `⏳ В ЧС (${msToHMS(msLeft)})`;
                        } else {
                            statusEl.className = 'channel-status status-badge-active';
                            statusEl.textContent = '● Активен';
                        }
                    }

                    const toggleChanBtn = li.querySelector('.toggle-channel-blacklist-btn');
                    if (toggleChanBtn) {
                        toggleChanBtn.className = `btn btn-xs btn-icon-only ${isBlockedNow ? 'btn-success' : 'btn-danger'} toggle-channel-blacklist-btn`;
                        toggleChanBtn.textContent = isBlockedNow ? '✓' : '⛔';
                    }
                });
            }

            return; // In-place обновление успешно выполнено без пересоздания DOM
        }

        container.innerHTML = '';

        if (sortedGroupIds.length === 0 && ungrouped.length === 0) {
            container.innerHTML = `
                <div class="card" style="padding:32px;text-align:center;color:#64748b;">
                    <h3 style="margin-top:0;color:#1e293b;">Список каналов пуст</h3>
                    <p style="margin-bottom:16px;">Создайте первую группу дропа или загрузите конфигурационный JSON-файл.</p>
                    <button class="btn btn-primary" onclick="document.getElementById('createNewGroup').click()">+ Создать группу дропа</button>
                </div>
            `;
            return;
        }

        // 1. Отрисовываем группы
        sortedGroupIds.forEach((dropId, index) => {
            const group = groups[dropId];
            const priorityNumber = index + 1;
            const targetSeconds = parseTimeToSeconds(group.watchTime);

            let groupTotalTime = 0;
            let blockedCount = 0;

            group.channels.forEach(item => {
                groupTotalTime += (totalWatched[item.url] || 0);
                if (blacklist[item.url]) {
                    if (blacklist[item.url] === 'permanent' || blacklist[item.url] > now) {
                        blockedCount++;
                    }
                }
            });

            const allChannelsBlocked = group.channels.length > 0 && blockedCount === group.channels.length;
            const progress = targetSeconds > 0 ? Math.min(100, Math.round((groupTotalTime / targetSeconds) * 100)) : 0;
            const colors = getProgressColors(progress);

            // Получаем медиа дропа (видео анимация и постер)
            const media = dropMedia[dropId] || {};
            const firstChWithMedia = group.channels.find(item => item.ch && (item.ch.videoUrl || item.ch.imageUrl));
            const videoUrl = media.videoUrl || (firstChWithMedia && firstChWithMedia.ch && firstChWithMedia.ch.videoUrl) || '';
            const imageUrl = media.imageUrl || (firstChWithMedia && firstChWithMedia.ch && firstChWithMedia.ch.imageUrl) || '';

            const card = document.createElement('div');
            card.className = 'drop-card';
            card.setAttribute('data-dropid', dropId);
            card.style.borderLeftColor = colors.borderLeft;
            card.style.background = colors.tintBg;
            card.style.boxShadow = colors.cardGlow;

            card.innerHTML = `
                <div class="drop-card-header">
                    <div class="drop-title-area">
                        <div class="priority-controls">
                            <button class="priority-btn move-group-up" data-dropid="${dropId}" title="Повысить приоритет" ${index === 0 ? 'disabled' : ''}>▲</button>
                            <span class="priority-badge set-group-priority" data-dropid="${dropId}" data-priority="${priorityNumber}" title="Нажмите, чтобы изменить приоритет">#${priorityNumber}</span>
                            <button class="priority-btn move-group-down" data-dropid="${dropId}" title="Понизить приоритет" ${index === sortedGroupIds.length - 1 ? 'disabled' : ''}>▼</button>
                        </div>
                        <h3 class="drop-id" title="${dropId}">${group.dropName && group.dropName !== dropId ? `${group.dropName} <span style="font-size:11px;font-weight:normal;opacity:0.75;">(${dropId})</span>` : dropId}</h3>
                    </div>
                    <div class="group-actions">
                        <button class="btn btn-xs btn-surface edit-group-btn" data-dropid="${dropId}" title="Изменить ID или целевое время">✏️ Изм</button>
                        <button class="btn btn-xs btn-surface reset-group-btn" data-dropid="${dropId}" title="Сбросить накопленное время группы">🔄 Сброс</button>
                        <button class="btn btn-xs ${allChannelsBlocked ? 'btn-success' : 'btn-danger-outline'} toggle-group-blacklist-btn" data-dropid="${dropId}" title="${allChannelsBlocked ? 'Разблокировать все каналы группы' : 'Заблокировать все каналы группы'}">
                            ${allChannelsBlocked ? '✓ Разблок' : '⛔ В ЧС'}
                        </button>
                        <button class="btn btn-xs btn-danger-outline delete-group-btn" data-dropid="${dropId}" title="Удалить группу и все её каналы">🗑️</button>
                    </div>
                </div>

                <div class="drop-metrics">
                    <div class="metric-item">
                        <span>Цель:</span>
                        <span class="metric-value metric-target">${secondsToHMS(targetSeconds)}</span>
                    </div>
                    <div class="metric-item">
                        <span>Просмотрено:</span>
                        <span class="metric-value metric-watched">${secondsToHMS(groupTotalTime)}</span>
                    </div>
                    <div class="metric-item">
                        <span class="progress-percent-badge" style="background:${colors.badgeBg};">
                            ${progress === 100 ? '✓ ' : ''}${progress}%
                        </span>
                    </div>
                </div>

                <div class="drop-progress-container">
                    <div class="drop-progress-bar" style="width:${progress}%;background:${colors.barGradient};"></div>
                </div>

                <div class="drop-card-body">
                    ${(videoUrl || imageUrl) ? `
                    <div class="drop-preview-container" title="${group.dropName || dropId}">
                        ${videoUrl ? `
                        <video class="drop-preview-video" autoplay loop muted playsinline poster="${imageUrl || ''}">
                            <source src="${videoUrl}" type="video/mp4">
                            ${imageUrl ? `<img src="${imageUrl}" class="drop-preview-img" alt="${dropId}">` : ''}
                        </video>
                        ` : `
                        <img class="drop-preview-img" src="${imageUrl}" alt="${dropId}">
                        `}
                    </div>
                    ` : ''}
                    <div class="channels-section">
                        <div class="channels-header">
                            <span>Каналы в группе (${group.channels.length})</span>
                        </div>
                        <ul class="channel-list" id="channel-list-${dropId}"></ul>
                        <div class="add-channel-bar">
                            <input type="text" class="add-channel-input" data-dropid="${dropId}" id="input-add-${dropId}" placeholder="https://www.twitch.tv/никнейм">
                            <button class="btn btn-sm btn-primary add-channel-to-group-btn" data-dropid="${dropId}">+ Добавить канал</button>
                        </div>
                    </div>
                </div>
            `;

            container.appendChild(card);

            // Заполняем каналы группы
            const listEl = card.querySelector(`#channel-list-${dropId}`);
            if (group.channels.length === 0) {
                const emptyLi = document.createElement('li');
                emptyLi.className = 'channel-item channel-item-empty';
                emptyLi.style.cssText = 'padding:14px;color:#94a3b8;font-size:13px;display:flex;justify-content:center;align-items:center;background:rgba(255,255,255,0.02);border-radius:6px;';
                emptyLi.innerHTML = `<span>Каналы не привязаны. Добавьте URL стрима ниже.</span>`;
                listEl.appendChild(emptyLi);
            }
            group.channels.forEach(item => {
                const url = item.url;
                const watched = totalWatched[url] || 0;
                const isBlocked = !!blacklist[url];
                const isPermanent = blacklist[url] === 'permanent';
                const msLeft = (!isPermanent && isBlocked) ? (blacklist[url] - now) : 0;
                const isBlockedNow = isPermanent || msLeft > 0;

                let statusBadge = '<span class="channel-status status-badge-active">● Активен</span>';
                if (targetSeconds > 0 && groupTotalTime >= targetSeconds) {
                    statusBadge = '<span class="channel-status status-badge-completed" title="Цель группы достигнута">✓ Завершён</span>';
                } else if (isPermanent) {
                    statusBadge = '<span class="channel-status status-badge-permanent" title="Канал заблокирован навсегда">⛔ ЧС (навсегда)</span>';
                } else if (isBlockedNow) {
                    statusBadge = `<span class="channel-status status-badge-blacklist" title="Осталось: ${msToHMS(msLeft)}">⏳ В ЧС (${msToHMS(msLeft)})</span>`;
                }

                const li = document.createElement('li');
                li.className = 'channel-item';
                li.setAttribute('data-url', url);
                li.innerHTML = `
                    <div class="channel-info">
                        <a href="${url}" target="_blank" class="channel-link">${url}</a>
                        <span class="channel-time">${secondsToHMS(watched)}</span>
                        ${statusBadge}
                    </div>
                    <div class="channel-actions">
                        <button class="btn btn-xs btn-icon-only edit-channel-btn" data-url="${url}" title="Изменить URL или время">✏️</button>
                        <button class="btn btn-xs btn-icon-only reset-channel-btn" data-url="${url}" title="Сбросить время этого канала">🔄</button>
                        <button class="btn btn-xs btn-icon-only ${isBlockedNow ? 'btn-success' : 'btn-danger'} toggle-channel-blacklist-btn" data-url="${url}" title="${isBlockedNow ? 'Разблокировать' : 'Отправить в чёрный список'}">
                            ${isBlockedNow ? '✓' : '⛔'}
                        </button>
                        <button class="btn btn-xs btn-icon-only btn-danger-outline delete-channel-btn" data-url="${url}" title="Удалить канал">🗑️</button>
                    </div>
                `;
                listEl.appendChild(li);
            });
        });

        // 2. Отрисовываем негруппированные каналы (если есть)
        if (ungrouped.length > 0) {
            const ungroupedCard = document.createElement('div');
            ungroupedCard.className = 'drop-card ungrouped-card';
            ungroupedCard.style.borderLeftColor = '#475569';
            ungroupedCard.style.background = 'var(--bg-card)';

            ungroupedCard.innerHTML = `
                <div class="drop-card-header">
                    <div class="drop-title-area">
                        <span class="priority-badge" style="background:#334155;color:#94a3b8;">Общие</span>
                        <h3 class="drop-id" style="color:#94a3b8;">Каналы без группы</h3>
                    </div>
                    <div class="group-actions">
                        <button class="btn btn-xs btn-warning reset-ungrouped-btn">Сбросить всё время</button>
                    </div>
                </div>
                <div class="channels-section" style="border-top:none;padding-top:0;">
                    <ul class="channel-list" id="ungrouped-channel-list"></ul>
                    <div class="add-channel-bar">
                        <input type="text" class="add-channel-input" data-dropid="" id="input-add-ungrouped" placeholder="https://www.twitch.tv/никнейм">
                        <button class="btn btn-sm btn-primary add-channel-to-group-btn" data-dropid="">+ Добавить одиночный канал</button>
                    </div>
                </div>
            `;

            container.appendChild(ungroupedCard);

            const listEl = ungroupedCard.querySelector('#ungrouped-channel-list');
            ungrouped.forEach(item => {
                const url = item.url;
                const watched = totalWatched[url] || 0;
                const isBlocked = !!blacklist[url];
                const isPermanent = blacklist[url] === 'permanent';
                const msLeft = (!isPermanent && isBlocked) ? (blacklist[url] - now) : 0;
                const isBlockedNow = isPermanent || msLeft > 0;

                const targetSec = parseTimeToSeconds(item.watchTime || config.watchTime);
                let statusBadge = '<span class="channel-status status-badge-active">● Активен</span>';
                if (targetSec > 0 && watched >= targetSec) {
                    statusBadge = '<span class="channel-status status-badge-completed" title="Цель достигнута">✓ Завершён</span>';
                } else if (isPermanent) {
                    statusBadge = '<span class="channel-status status-badge-permanent">⛔ ЧС (навсегда)</span>';
                } else if (isBlockedNow) {
                    statusBadge = `<span class="channel-status status-badge-blacklist">⏳ В ЧС (${msToHMS(msLeft)})</span>`;
                }

                const li = document.createElement('li');
                li.className = 'channel-item';
                li.setAttribute('data-url', url);
                li.innerHTML = `
                    <div class="channel-info">
                        <a href="${url}" target="_blank" class="channel-link">${url}</a>
                        <span class="channel-time">${secondsToHMS(watched)}</span>
                        ${statusBadge}
                    </div>
                    <div class="channel-actions">
                        <button class="btn btn-xs btn-icon-only edit-channel-btn" data-url="${url}" title="Изменить">✏️</button>
                        <button class="btn btn-xs btn-icon-only reset-channel-btn" data-url="${url}" title="Сбросить">🔄</button>
                        <button class="btn btn-xs btn-icon-only ${isBlockedNow ? 'btn-success' : 'btn-danger'} toggle-channel-blacklist-btn" data-url="${url}">
                            ${isBlockedNow ? '✓' : '⛔'}
                        </button>
                        <button class="btn btn-xs btn-icon-only btn-danger-outline delete-channel-btn" data-url="${url}">🗑️</button>
                    </div>
                `;
                listEl.appendChild(li);
            });
        }

        // Восстанавливаем фокус и введённый текст в инпут, если пользователь печатал
        if (focusedInputDropId !== null) {
            const inputSelector = focusedInputDropId === '' ? '#input-add-ungrouped' : `#input-add-${focusedInputDropId}`;
            const inputToRestore = document.querySelector(inputSelector);
            if (inputToRestore) {
                inputToRestore.value = focusedInputValue;
                inputToRestore.focus();
            }
        }

        // Навешиваем слушатели событий
        attachCardHandlers(sortedGroupIds);
    });
}

// =========================================================
// Обработчики действий в карточках
// =========================================================

function attachCardHandlers(sortedGroupIds) {
    // 1. Повысить приоритет (▲)
    document.querySelectorAll('.move-group-up').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            const idx = sortedGroupIds.indexOf(dropId);
            if (idx <= 0) return;
            [sortedGroupIds[idx], sortedGroupIds[idx - 1]] = [sortedGroupIds[idx - 1], sortedGroupIds[idx]];
            saveGroupOrder(sortedGroupIds);
        });
    });

    // 2. Понизить приоритет (▼)
    document.querySelectorAll('.move-group-down').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            const idx = sortedGroupIds.indexOf(dropId);
            if (idx === -1 || idx >= sortedGroupIds.length - 1) return;
            [sortedGroupIds[idx], sortedGroupIds[idx + 1]] = [sortedGroupIds[idx + 1], sortedGroupIds[idx]];
            saveGroupOrder(sortedGroupIds);
        });
    });

    // 3. Прямой ввод приоритета (клик по бейджу #N)
    document.querySelectorAll('.set-group-priority').forEach(badge => {
        badge.addEventListener('click', () => {
            const dropId = badge.getAttribute('data-dropid');
            const currentPriority = badge.getAttribute('data-priority');
            const input = showPrompt(`Укажите новый приоритет для группы "${dropId}" (от 1 до ${sortedGroupIds.length}):`, currentPriority);
            if (!input) return;
            const newPriority = parseInt(input.trim(), 10);
            if (isNaN(newPriority) || newPriority < 1 || newPriority > sortedGroupIds.length) {
                showAlert(`Введите корректное число от 1 до ${sortedGroupIds.length}`);
                return;
            }
            const oldIdx = sortedGroupIds.indexOf(dropId);
            if (oldIdx === -1) return;
            const targetIdx = newPriority - 1;
            sortedGroupIds.splice(oldIdx, 1);
            sortedGroupIds.splice(targetIdx, 0, dropId);
            saveGroupOrder(sortedGroupIds);
        });
    });

    // 4. Редактирование группы (ID и целевое время)
    document.querySelectorAll('.edit-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
                const config = data.userConfig || { channels: [] };
                const totalWatched = data.totalWatched || {};
                const groupChannel = config.channels.find(ch => typeof ch === 'object' && ch.dropId === dropId);
                const currentWatch = groupChannel ? (groupChannel.watchTime || '1:00:00') : '1:00:00';

                const newDropId = showPrompt('Изменить ID группы дропа:', dropId);
                if (!newDropId) return;
                const newWatchTime = showPrompt('Изменить целевое время группы (H:MM:SS):', currentWatch);
                if (!newWatchTime) return;

                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

                const newTargetSec = parseTimeToSeconds(newWatchTime);
                let groupWatched = 0;

                // Обновляем каналы группы
                config.channels = config.channels.map(ch => {
                    if (typeof ch === 'object' && ch.dropId === dropId) {
                        groupWatched += (totalWatched[ch.url] || 0);
                        return { ...ch, dropId: newDropId, watchTime: newWatchTime };
                    }
                    return ch;
                });

                // Обновляем groupOrder
                if (Array.isArray(config.groupOrder)) {
                    config.groupOrder = config.groupOrder.map(id => id === dropId ? newDropId : id);
                }

                // Проверяем: если новое время просмотра уже достигнуто, помечаем группу в ЧС как завершенную
                const groupChannels = config.channels.filter(ch => typeof ch === 'object' && ch.dropId === newDropId);
                if (newTargetSec > 0 && groupWatched >= newTargetSec) {
                    groupChannels.forEach(ch => {
                        config.blacklist[ch.url] = 'permanent';
                    });
                } else if (newTargetSec > groupWatched) {
                    // Если время увеличили, разблокируем каналы группы, если они были заблокированы перманентно
                    groupChannels.forEach(ch => {
                        if (config.blacklist[ch.url] === 'permanent') {
                            delete config.blacklist[ch.url];
                        }
                    });
                }

                chrome.storage.local.set({ userConfig: config }, () => {
                    renderCardsView();
                });
            });
        });
    });

    // 5. Сбросить накопленное время группы
    document.querySelectorAll('.reset-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            if (!showConfirm(`Сбросить время просмотра для всех каналов группы "${dropId}"?`)) return;

            chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
                const config = data.userConfig || { channels: [] };
                const totalWatched = data.totalWatched || {};
                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

                config.channels.forEach(ch => {
                    if (typeof ch === 'object' && ch.dropId === dropId) {
                        totalWatched[ch.url] = 0;
                        if (config.blacklist[ch.url] === 'permanent') {
                            delete config.blacklist[ch.url];
                        }
                    }
                });

                chrome.storage.local.set({ userConfig: config, totalWatched }, () => {
                    renderCardsView();
                });
            });
        });
    });

    // 6. Блокировка / разблокировка всей группы
    document.querySelectorAll('.toggle-group-blacklist-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');

            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

                const groupChannels = config.channels.filter(ch => typeof ch === 'object' && ch.dropId === dropId);
                const now = Date.now();

                // Проверяем: есть ли заблокированные каналы в группе прямо сейчас
                const anyBlocked = groupChannels.some(ch => {
                    const b = config.blacklist[ch.url];
                    return b === 'permanent' || (typeof b === 'number' && b > now);
                });

                if (anyBlocked) {
                    // Разблокируем все каналы группы
                    groupChannels.forEach(ch => {
                        delete config.blacklist[ch.url];
                    });
                } else {
                    // Блокируем все каналы группы
                    const tempVal = config.tempBlacklistSeconds;
                    let banTime = 'permanent';
                    if (tempVal) {
                        const sec = parseTimeToSeconds(tempVal);
                        if (sec > 0) banTime = Date.now() + sec * 1000;
                    }
                    groupChannels.forEach(ch => {
                        config.blacklist[ch.url] = banTime;
                    });
                }

                chrome.storage.local.set({ userConfig: config }, () => {
                    renderCardsView();
                });
            });
        });
    });

    // 7. Удаление группы
    document.querySelectorAll('.delete-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            if (!showConfirm(`Удалить группу "${dropId}" и все её каналы?`)) return;

            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                config.channels = config.channels.filter(ch => !(typeof ch === 'object' && ch.dropId === dropId));
                if (Array.isArray(config.groupOrder)) {
                    config.groupOrder = config.groupOrder.filter(id => id !== dropId);
                }

                chrome.storage.local.set({ userConfig: config }, () => {
                    renderCardsView();
                });
            });
        });
    });

    // 8. Добавление канала в группу (инлайн форма)
    document.querySelectorAll('.add-channel-to-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            const inputSelector = dropId === '' ? '#input-add-ungrouped' : `#input-add-${dropId}`;
            const input = document.querySelector(inputSelector);
            if (!input) return;

            const url = normalizeChannelUrl(input.value);
            if (!url) {
                showAlert('Введите корректный URL канала (например, https://www.twitch.tv/никнейм)');
                return;
            }

            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                if (!Array.isArray(config.channels)) config.channels = [];

                const exists = config.channels.some(ch => {
                    const chUrl = typeof ch === 'string' ? ch : ch.url;
                    return (chUrl || '').toLowerCase() === url.toLowerCase();
                });

                if (exists) {
                    showAlert('Этот канал уже добавлен в список!');
                    return;
                }

                let watchTime = config.watchTime || '1:00:00';
                if (dropId) {
                    const existing = config.channels.find(ch => typeof ch === 'object' && ch.dropId === dropId);
                    if (existing && existing.watchTime) watchTime = existing.watchTime;
                }

                const newEntry = { url, watchTime };
                if (dropId) newEntry.dropId = dropId;

                config.channels.push(newEntry);
                chrome.storage.local.set({ userConfig: config }, () => {
                    input.value = '';
                    renderCardsView();
                });
            });
        });
    });

    // 9. Блокировка / разблокировка отдельного канала
    document.querySelectorAll('.toggle-channel-blacklist-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.getAttribute('data-url');

            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

                const now = Date.now();
                const isBlocked = config.blacklist[url] === 'permanent' || (typeof config.blacklist[url] === 'number' && config.blacklist[url] > now);

                if (isBlocked) {
                    delete config.blacklist[url];
                    chrome.storage.local.set({ userConfig: config }, () => renderCardsView());
                } else {
                    const defaultTemp = config.tempBlacklistSeconds || '0.05.00';
                    const input = showPrompt(
                        `Укажите длительность бана канала (H:MM:SS или H.MM.SS).\nВведите 0 для перманентного бана. Оставьте пустым для значения по умолчанию:`,
                        defaultTemp
                    );
                    if (input === null) return; // Отмена

                    const trimmed = input.trim();
                    if (trimmed === '0') {
                        config.blacklist[url] = 'permanent';
                    } else {
                        const sec = parseTimeToSeconds(trimmed || defaultTemp);
                        if (sec > 0) {
                            config.blacklist[url] = Date.now() + sec * 1000;
                        } else {
                            config.blacklist[url] = 'permanent';
                        }
                    }
                    chrome.storage.local.set({ userConfig: config }, () => renderCardsView());
                }
            });
        });
    });

    // 10. Сброс времени отдельного канала
    document.querySelectorAll('.reset-channel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.getAttribute('data-url');
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || {};
                if (config.blacklist && config.blacklist[url] === 'permanent') {
                    delete config.blacklist[url];
                    chrome.storage.local.set({ userConfig: config }, () => {
                        resetWatchTime(url);
                    });
                } else {
                    resetWatchTime(url);
                }
            });
        });
    });

    // 11. Редактирование отдельного канала
    document.querySelectorAll('.edit-channel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.getAttribute('data-url');
            chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
                const config = data.userConfig || { channels: [] };
                const totalWatched = data.totalWatched || {};
                const idx = config.channels.findIndex(ch => (typeof ch === 'string' ? ch : ch.url) === url);
                if (idx === -1) return;

                const current = config.channels[idx];
                const curUrl = typeof current === 'string' ? current : current.url;
                const curWatch = typeof current === 'object' ? (current.watchTime || '') : '';
                const curDrop = typeof current === 'object' ? (current.dropId || '') : '';

                const newUrl = showPrompt('URL канала:', curUrl);
                if (!newUrl) return;
                const newWatch = showPrompt('Целевое время (H:MM:SS) или пусто для значения по умолчанию:', curWatch);
                const newDrop = showPrompt('ID группы дропа (или пусто для одиночного канала):', curDrop);

                const normalizedUrl = normalizeChannelUrl(newUrl);
                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

                if (normalizedUrl !== curUrl) {
                    if (totalWatched[curUrl] !== undefined) {
                        totalWatched[normalizedUrl] = totalWatched[curUrl];
                        delete totalWatched[curUrl];
                        chrome.storage.local.set({ totalWatched });
                    }
                    if (config.blacklist[curUrl] !== undefined) {
                        config.blacklist[normalizedUrl] = config.blacklist[curUrl];
                        delete config.blacklist[curUrl];
                    }
                }

                config.channels[idx] = {
                    url: normalizedUrl,
                    ...(newWatch && { watchTime: newWatch }),
                    ...(newDrop && { dropId: newDrop })
                };

                const targetSec = parseTimeToSeconds(newWatch || config.watchTime);
                const dropId = newDrop || (typeof current === 'object' ? current.dropId : null);
                let watchedSec = 0;
                if (dropId) {
                    config.channels.forEach(ch => {
                        if (typeof ch === 'object' && ch.dropId === dropId) {
                            watchedSec += (totalWatched[ch.url] || 0);
                        }
                    });
                } else {
                    watchedSec = totalWatched[normalizedUrl] || 0;
                }

                if (targetSec > 0 && watchedSec >= targetSec) {
                    config.blacklist[normalizedUrl] = 'permanent';
                } else if (targetSec > watchedSec && config.blacklist[normalizedUrl] === 'permanent') {
                    delete config.blacklist[normalizedUrl];
                }

                chrome.storage.local.set({ userConfig: config }, () => renderCardsView());
            });
        });
    });

    // 12. Удаление отдельного канала
    document.querySelectorAll('.delete-channel-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.getAttribute('data-url');
            if (!showConfirm(`Удалить канал "${url}"?`)) return;

            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                config.channels = config.channels.filter(ch => (typeof ch === 'string' ? ch : ch.url) !== url);
                chrome.storage.local.set({ userConfig: config }, () => renderCardsView());
            });
        });
    });

    // 13. Сброс всего времени негруппированных каналов
    const resetUngrouped = document.querySelector('.reset-ungrouped-btn');
    if (resetUngrouped) {
        resetUngrouped.addEventListener('click', () => {
            if (!showConfirm('Сбросить накопленное время для всех одиночных каналов?')) return;
            chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
                const config = data.userConfig || { channels: [] };
                const totalWatched = data.totalWatched || {};
                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};

                config.channels.forEach(ch => {
                    const url = typeof ch === 'string' ? ch : ch.url;
                    const dropId = typeof ch === 'object' ? ch.dropId : null;
                    if (!dropId) {
                        totalWatched[url] = 0;
                        if (config.blacklist[url] === 'permanent') {
                            delete config.blacklist[url];
                        }
                    }
                });

                chrome.storage.local.set({ userConfig: config, totalWatched }, () => renderCardsView());
            });
        });
    }
}

function saveGroupOrder(newOrder) {
    chrome.storage.local.get('userConfig', (data) => {
        const config = data.userConfig || {};
        config.groupOrder = newOrder;
        chrome.storage.local.set({ userConfig: config }, () => {
            renderCardsView();
        });
    });
}

function resetWatchTime(url) {
    chrome.runtime.sendMessage({ action: "resetWatchTime", url }, () => {
        renderCardsView();
    });
}

// =========================================================
// Логи и настройки бота
// =========================================================

function updateLogView(logArr) {
    const logDiv = document.getElementById("log");
    if (logDiv) {
        const isNearBottom = logDiv.scrollHeight - logDiv.scrollTop - logDiv.clientHeight < 60;
        const prevScrollTop = logDiv.scrollTop;
        const prevScrollHeight = logDiv.scrollHeight;

        logDiv.innerHTML = (logArr || []).join("<br>");

        if (isNearBottom) {
            // Пользователь у низа — авто-прокрутка вниз
            logDiv.scrollTop = logDiv.scrollHeight;
        } else {
            // Пользователь листает вверх — сохраняем позицию прокрутки
            const newScrollHeight = logDiv.scrollHeight;
            logDiv.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
        }
    }
}

function pollLog() {
    chrome.runtime.sendMessage({ action: "getLog" }, (resp) => {
        if (resp && resp.log) updateLogView(resp.log);
    });
}

// =========================================================
// Управление кампаниями Twitch Drops (Universal Campaigns)
// =========================================================

let allCampaignsList = [];
let isFetchingCampaigns = false;

function initCampaignExplorer() {
    const modal = document.getElementById('campaignModal');
    const openBtn = document.getElementById('openCampaignsBtn');
    const bannerPickBtn = document.getElementById('bannerPickCampaignBtn');
    const settingsPickBtn = document.getElementById('openCampaignsFromSettingsBtn');
    const closeBtn = document.getElementById('closeCampaignModalBtn');
    const closeBottomBtn = document.getElementById('closeCampaignModalBottomBtn');
    const searchInput = document.getElementById('campaignSearchInput');
    const clearSearchBtn = document.getElementById('clearCampaignSearchBtn');
    const fetchTwitchBtn = document.getElementById('fetchTwitchCampaignsBtn');
    const manualCategoryBtn = document.getElementById('manualCategoryModalBtn');
    const statusBanner = document.getElementById('campaignStatusBanner');
    const statusMsg = document.getElementById('campaignStatusMsg');
    const grid = document.getElementById('campaignsGrid');
    const emptyState = document.getElementById('campaignsEmptyState');

    if (!modal) return;

    function showStatus(text) {
        if (statusMsg) statusMsg.textContent = text;
        if (statusBanner) statusBanner.style.display = 'flex';
    }

    function hideStatus() {
        if (statusBanner) statusBanner.style.display = 'none';
    }

    function openModal() {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        if (searchInput) {
            searchInput.focus();
        }
        if (allCampaignsList.length === 0) {
            autoLoadCampaigns();
        }
    }

    function closeModal() {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }

    if (openBtn) openBtn.addEventListener('click', openModal);
    if (bannerPickBtn) bannerPickBtn.addEventListener('click', openModal);
    if (settingsPickBtn) settingsPickBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (closeBottomBtn) closeBottomBtn.addEventListener('click', closeModal);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            closeModal();
        }
    });

    try {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('openCampaigns') === '1') {
            openModal();
        }
    } catch(e) {}

    function autoLoadCampaigns() {
        loadFromTwitch();
    }

    function loadFromTwitch() {
        if (isFetchingCampaigns) return;
        isFetchingCampaigns = true;
        showStatus('Считывание активных кампаний со страницы Twitch...');
        if (fetchTwitchBtn) {
            fetchTwitchBtn.disabled = true;
            fetchTwitchBtn.textContent = '⏳ Считывание...';
        }

        chrome.runtime.sendMessage({ action: "getTwitchCampaigns", forceRefresh: true }, (resp) => {
            isFetchingCampaigns = false;
            hideStatus();
            if (fetchTwitchBtn) {
                fetchTwitchBtn.disabled = false;
                fetchTwitchBtn.innerHTML = '<span>🌐</span> Считать с Twitch';
            }

            if (resp && resp.ok && Array.isArray(resp.campaigns) && resp.campaigns.length > 0) {
                allCampaignsList = resp.campaigns;
                renderCampaignsGrid(allCampaignsList);
            } else {
                showAlert('⚠️ Не удалось считать список кампаний с Twitch.\nПожалуйста, убедитесь, что страница twitch.tv/drops/campaigns доступна в браузере.');
            }
        });
    }

    if (fetchTwitchBtn) {
        fetchTwitchBtn.addEventListener('click', () => loadFromTwitch());
    }

    if (manualCategoryBtn) {
        manualCategoryBtn.addEventListener('click', () => {
            const catUrl = showPrompt('Введите URL категории на Twitch (например, https://www.twitch.tv/directory/category/rust):');
            if (!catUrl) return;
            const normUrl = normalizeChannelUrl(catUrl);
            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || {};
                cfg.searchUrlPart = normUrl;
                chrome.storage.local.set({ userConfig: cfg }, () => {
                    showAlert(`Категория поиска обновлена на: ${normUrl}`);
                    renderCardsView();
                    closeModal();
                });
            });
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim().toLowerCase();
            if (clearSearchBtn) {
                clearSearchBtn.style.display = q ? 'block' : 'none';
            }
            if (!q) {
                renderCampaignsGrid(allCampaignsList);
                return;
            }
            const filtered = allCampaignsList.filter(c => {
                const gn = (c.gameName || '').toLowerCase();
                const ct = (c.campaignTitle || '').toLowerCase();
                return gn.includes(q) || ct.includes(q);
            });
            renderCampaignsGrid(filtered);
        });
    }

    if (clearSearchBtn && searchInput) {
        clearSearchBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearSearchBtn.style.display = 'none';
            renderCampaignsGrid(allCampaignsList);
            searchInput.focus();
        });
    }

    function renderCampaignsGrid(list) {
        if (!grid) return;
        grid.innerHTML = '';

        if (!list || list.length === 0) {
            if (emptyState) emptyState.style.display = 'flex';
            return;
        }
        if (emptyState) emptyState.style.display = 'none';

        list.forEach((c, idx) => {
            const card = document.createElement('div');
            card.className = 'campaign-card';

            const thumb = document.createElement('div');
            thumb.className = 'campaign-card-thumb';
            if (c.coverImg) {
                const img = document.createElement('img');
                img.src = c.coverImg;
                img.alt = c.gameName || 'Cover';
                img.onerror = () => { thumb.innerHTML = '🎮'; };
                thumb.appendChild(img);
            } else {
                thumb.innerHTML = '🎮';
            }
            card.appendChild(thumb);

            const content = document.createElement('div');
            content.className = 'campaign-card-content';

            const headerRow = document.createElement('div');
            headerRow.className = 'campaign-card-header';

            const title = document.createElement('h3');
            title.className = 'campaign-card-title';
            title.textContent = c.gameName || 'Без названия';
            title.title = c.gameName || '';
            headerRow.appendChild(title);

            const badge = document.createElement('span');
            badge.className = 'badge-time-left';
            const timeLeft = c.timeLeftStr || '';
            const isEnded = c.isEnded || timeLeft.includes('Завершен') || timeLeft.includes('Истекло');
            if (isEnded) {
                badge.classList.add('badge-ended');
                badge.textContent = '⌛ Завершена';
            } else if (timeLeft) {
                if (timeLeft.includes('мин') && !timeLeft.includes('д') && !timeLeft.includes('ч')) {
                    badge.classList.add('badge-urgent');
                }
                badge.textContent = `⏳ ${timeLeft}`;
            } else {
                badge.classList.add('badge-neutral');
                badge.textContent = 'Активна';
            }
            headerRow.appendChild(badge);
            content.appendChild(headerRow);

            if (c.campaignTitle && c.campaignTitle !== c.gameName) {
                const sub = document.createElement('div');
                sub.className = 'campaign-card-sub';
                sub.textContent = c.campaignTitle;
                sub.title = c.campaignTitle;
                content.appendChild(sub);
            }

            const dates = document.createElement('div');
            dates.className = 'campaign-card-dates';
            dates.textContent = c.dateStr ? `📅 ${c.dateStr}` : '📅 Сроки не указаны';
            content.appendChild(dates);

            card.appendChild(content);

            const actionArea = document.createElement('div');
            actionArea.className = 'campaign-card-action';

            const selectBtn = document.createElement('button');
            selectBtn.className = 'btn btn-primary btn-sm';
            selectBtn.textContent = '📥 Выбрать';
            selectBtn.title = `Настроить бота под "${c.gameName}"`;

            selectBtn.addEventListener('click', () => {
                selectCampaign(c, idx, selectBtn);
            });

            actionArea.appendChild(selectBtn);
            card.appendChild(actionArea);

            grid.appendChild(card);
        });
    }

    function selectCampaign(c, index, btnEl) {
        if (!c) return;
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = '⏳ Импорт...';
        }
        showStatus(`Импорт кампании "${c.gameName}"...`);

        const rawIdx = (c.rawIndex !== undefined) ? c.rawIndex : ((c.index !== undefined) ? c.index : index);

        chrome.runtime.sendMessage({
            action: "importTwitchCampaign",
            gameName: c.gameName,
            index: rawIdx
        }, (resp) => {
            hideStatus();
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.textContent = '📥 Выбрать';
            }

            if (resp && resp.ok) {
                const channelsCount = resp.channelsCount || 0;
                const groupsCount = resp.groupsCount || 0;
                const campaignObj = resp.campaign || c;

                renderActiveCampaignBanner(campaignObj);
                renderCardsView();
                loadConfigForm();
                closeModal();

                if (channelsCount === 0) {
                    const wantLive = showConfirm(`✅ Кампания "${c.gameName}" выбрана!\nНаград: ${groupsCount}.\n\nВ этой кампании нет закреплённых стримеров (только общие дропы категории).\n\nНайти сейчас каналы, которые в прямом эфире с Drops в этой категории?`);
                    if (wantLive) {
                        fetchAndAddLiveCategoryStreamers((campaignObj && campaignObj.categoryUrl) || resp.categoryUrl, c.gameName);
                    }
                } else {
                    showAlert(`✅ Кампания "${c.gameName}" успешно выбрана!\nГрупп наград: ${groupsCount}, каналов: ${channelsCount}\nСрок: ${campaignObj.timeLeftStr || 'активна'}`);
                }
            } else {
                showAlert(`❌ Ошибка импорта кампании: ${(resp && resp.error) || 'неизвестная ошибка'}`);
            }
        });
    }

    function fetchAndAddLiveCategoryStreamers(categoryUrl, gameName) {
        showStatus(`Поиск активных стримеров в категории "${gameName}"...`);
        chrome.runtime.sendMessage({ action: "fetchCategoryLiveChannels", categoryUrl, gameName }, (resp) => {
            hideStatus();
            if (resp && resp.ok && Array.isArray(resp.channels) && resp.channels.length > 0) {
                chrome.storage.local.get("userConfig", (data) => {
                    const cfg = data.userConfig || {};
                    if (!Array.isArray(cfg.channels)) cfg.channels = [];
                    const defaultDropId = (cfg.groupOrder && cfg.groupOrder[0]) || 'drop_general';
                    let added = 0;
                    resp.channels.forEach(url => {
                        const norm = normalizeChannelUrl(url);
                        if (!cfg.channels.some(ch => (typeof ch === 'string' ? ch : ch.url) === norm)) {
                            cfg.channels.push({
                                url: norm,
                                watchTime: cfg.watchTime || '01:00:00',
                                dropId: defaultDropId,
                                dropName: gameName || 'Общий дроп'
                            });
                            added++;
                        }
                    });
                    chrome.storage.local.set({ userConfig: cfg }, () => {
                        showAlert(`✅ Успешно добавлено ${added} активных стримеров в категорию "${gameName}"!`);
                        renderCardsView();
                    });
                });
            } else {
                showAlert(`⚠️ Не удалось автоматически найти активных стримеров: ${(resp && resp.error) || 'стримы офлайн'}.\nВы можете вручную добавить нужный канал через "+ Новая группа" или форму настроек.`);
            }
        });
    }
}

document.addEventListener("DOMContentLoaded", () => {
    // Первоначальный рендер карточек
    renderCardsView();
    pollLog();

    // Проверка и фоновая подгрузка анимаций/медиа дропов с Facepunch, если они ещё не подтянуты
    chrome.storage.local.get('userConfig', (data) => {
        const cfg = data.userConfig;
        if (cfg && Array.isArray(cfg.channels) && cfg.channels.length > 0) {
            const hasMedia = cfg.dropMedia && Object.keys(cfg.dropMedia).length > 0;
            const hasDropIds = cfg.channels.some(ch => typeof ch === 'object' && ch.dropId);
            if (!hasMedia && hasDropIds) {
                chrome.runtime.sendMessage({ action: "syncDropMedia" });
            }
        }
    });

    // Ежесекундное обновление для обновления времени и таймеров
    setInterval(renderCardsView, 1000);
    setInterval(pollLog, 2000);

    // Мгновенная реакция на изменение времени просмотра или настроек
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && (changes.totalWatched || changes.userConfig)) {
            renderCardsView();
        }
    });

    // Переключатель логов
    const toggleLogs = document.getElementById("toggleLogsCheckbox");
    if (toggleLogs) {
        chrome.runtime.sendMessage({ action: "getLoggingEnabled" }, (resp) => {
            if (resp && typeof resp.loggingEnabled === "boolean") {
                toggleLogs.checked = resp.loggingEnabled;
            }
        });
        toggleLogs.addEventListener("change", function() {
            chrome.runtime.sendMessage({ action: "setLoggingEnabled", enabled: this.checked });
            if (!this.checked) {
                document.getElementById("log").innerHTML = "<i>Логирование отключено</i>";
            } else {
                pollLog();
            }
        });
    }

    // Загрузка конфига из файла JSON
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
                            loadConfigForm();
                            renderCardsView();
                        });
                    } else if (!config || !config.searchUrlPart) {
                        showAlert("В файле отсутствует обязательное поле searchUrlPart!");
                    } else {
                        showAlert("В файле отсутствует список channels!");
                    }
                } catch (err) {
                    console.error('Ошибка чтения файла конфига', err);
                    showAlert("Ошибка чтения JSON файла! Проверьте синтаксис.");
                } finally {
                    fileInput.value = "";
                }
            };
            reader.readAsText(file);
        });
    }

    // Очистка логов
    const clearBtn = document.getElementById("clearLogsButton");
    if (clearBtn) {
        clearBtn.addEventListener("click", () => {
            chrome.runtime.sendMessage({ action: "clearLogs" }, () => pollLog());
        });
    }

    // Удаление конфига из хранилища
    const deleteConfigButton = document.getElementById("deleteConfigButton");
    if (deleteConfigButton) {
        deleteConfigButton.addEventListener("click", function() {
            if (showConfirm("Вы уверены, что хотите полностью удалить конфиг из браузера? Это действие необратимо.")) {
                chrome.runtime.sendMessage({ action: "stopWatching" }, () => {
                    chrome.storage.local.remove(["userConfig"], function() {
                        showAlert("Конфиг удалён.");
                        location.reload();
                    });
                });
            }
        });
    }

    // Форма параметров
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
            if (waitBeforeCheckInput) waitBeforeCheckInput.value = (cfg.waitBeforeCheck !== undefined) ? cfg.waitBeforeCheck : '';
            if (maxAttemptsInput) maxAttemptsInput.value = cfg.maxAttempts || '';
            if (tempBlacklistSecondsInput) tempBlacklistSecondsInput.value = cfg.tempBlacklistSeconds || '';
        });
    }

    if (saveConfigFormButton) {
        saveConfigFormButton.addEventListener('click', () => {
            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || {};
                if (searchUrlPartInput) cfg.searchUrlPart = searchUrlPartInput.value.trim();
                if (checkIntervalMinutesInput && checkIntervalMinutesInput.value !== '') {
                    cfg.checkIntervalMinutes = Math.max(1, Number(checkIntervalMinutesInput.value) || 1);
                }
                if (waitBeforeCheckInput && waitBeforeCheckInput.value !== '') {
                    cfg.waitBeforeCheck = Math.max(0, Number(waitBeforeCheckInput.value) || 0);
                }
                if (maxAttemptsInput && maxAttemptsInput.value !== '') {
                    cfg.maxAttempts = Math.max(1, Number(maxAttemptsInput.value) || 1);
                }
                if (tempBlacklistSecondsInput) {
                    cfg.tempBlacklistSeconds = tempBlacklistSecondsInput.value.trim();
                }
                chrome.storage.local.set({ userConfig: cfg }, () => {
                    showAlert('Настройки сохранены');
                    renderCardsView();
                });
            });
        });
    }

    loadConfigForm();

    // Создание новой группы дропа
    const createNewGroup = document.getElementById('createNewGroup');
    if (createNewGroup) {
        createNewGroup.addEventListener('click', () => {
            const dropId = showPrompt('Введите ID новой группы дропа (например, drop_17):');
            if (!dropId) return;

            const watchTime = showPrompt('Введите целевое время просмотра (H:MM:SS):', '01:00:00');
            if (!watchTime) return;

            const rawChannelUrl = showPrompt('Введите URL первого канала группы (например, https://www.twitch.tv/...):');
            if (!rawChannelUrl) return;

            const channelUrl = normalizeChannelUrl(rawChannelUrl);

            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || { channels: [] };
                if (!Array.isArray(cfg.channels)) cfg.channels = [];
                if (!Array.isArray(cfg.groupOrder)) cfg.groupOrder = [];

                const existsGroup = cfg.channels.some(ch => typeof ch === 'object' && ch.dropId === dropId);
                if (existsGroup) {
                    showAlert(`Группа с ID "${dropId}" уже существует!`);
                    return;
                }

                cfg.channels.push({
                    url: channelUrl,
                    watchTime,
                    dropId
                });

                if (!cfg.groupOrder.includes(dropId)) {
                    cfg.groupOrder.push(dropId);
                }

                chrome.storage.local.set({ userConfig: cfg }, () => {
                    renderCardsView();
                });
            });
        });
    }

    // Импорт Facepunch (Twitch)
    const importTwitchBtn = document.getElementById('importTwitchFacepunchBtn');
    if (importTwitchBtn) {
        importTwitchBtn.addEventListener('click', () => {
            importTwitchBtn.disabled = true;
            importTwitchBtn.textContent = '⏳ Загрузка...';
            chrome.runtime.sendMessage({ action: "importFacepunchDrops", platform: "twitch", url: "https://twitch.facepunch.com/" }, (resp) => {
                importTwitchBtn.disabled = false;
                importTwitchBtn.textContent = '📥 Facepunch (Twitch)';
                if (resp && resp.ok) {
                    showAlert(`✅ Успешно загружено ${resp.dropsCount} стример-дропов с Facepunch (Twitch)!\n(Общих дропов: ${resp.generalDropsCount || 0}, категория: ${resp.categoryUrl || ''})`);
                    renderCardsView();
                } else {
                    showAlert(`❌ Ошибка загрузки дропов: ${(resp && resp.error) || (resp && resp.reason) || 'неизвестная ошибка'}`);
                }
            });
        });
    }

    // Импорт Facepunch (Kick)
    const importKickBtn = document.getElementById('importKickFacepunchBtn');
    if (importKickBtn) {
        importKickBtn.addEventListener('click', () => {
            importKickBtn.disabled = true;
            importKickBtn.textContent = '⏳ Загрузка...';
            chrome.runtime.sendMessage({ action: "importFacepunchDrops", platform: "kick", url: "https://kick.facepunch.com/" }, (resp) => {
                importKickBtn.disabled = false;
                importKickBtn.textContent = '📥 Facepunch (Kick)';
                if (resp && resp.ok) {
                    showAlert(`✅ Успешно загружено ${resp.dropsCount} стример-дропов с Facepunch (Kick)!\n(Общих дропов: ${resp.generalDropsCount || 0}, категория: ${resp.categoryUrl || ''})`);
                    renderCardsView();
                } else {
                    showAlert(`⚠️ ${(resp && resp.error) || (resp && resp.reason) || 'На kick.facepunch.com сейчас нет активной кампании дропов.'}`);
                }
            });
        });
    }

    // Сверка с инвентарём
    const syncInventoryBtn = document.getElementById('syncInventoryBtn');
    if (syncInventoryBtn) {
        syncInventoryBtn.addEventListener('click', () => {
            syncInventoryBtn.disabled = true;
            syncInventoryBtn.textContent = '⏳ Сверка...';
            chrome.runtime.sendMessage({ action: "syncInventory", platform: "auto" }, (resp) => {
                syncInventoryBtn.disabled = false;
                syncInventoryBtn.textContent = '🔄 Сверить инвентарь';
                if (resp && resp.ok) {
                    const total = resp.totalScraped !== undefined ? resp.totalScraped : 0;
                    const completed = resp.completedCount !== undefined ? resp.completedCount : 0;
                    const synced = resp.syncedCount !== undefined ? resp.syncedCount : 0;
                    const untouched = resp.untouchedCount !== undefined ? resp.untouchedCount : 0;
                    showAlert(`✅ Сверка завершена!\nВсего в инвентаре: ${total}\nВыполнено на 100%: ${completed}\nСинхронизировано по времени: ${synced}\nНе начато (0%): ${untouched}`);
                    renderCardsView();
                } else {
                    showAlert(`⚠️ Не удалось сверить с инвентарём: ${(resp && resp.error) || (resp && resp.reason) || 'убедитесь, что вы авторизованы на Twitch/Kick'}`);
                }
            });
        });
    }

    // Авто-сортировка приоритетов
    const autoSortPriorityBtn = document.getElementById('autoSortPriorityBtn');
    if (autoSortPriorityBtn) {
        autoSortPriorityBtn.addEventListener('click', () => {
            autoSortPriorityBtn.disabled = true;
            autoSortPriorityBtn.textContent = '⏳ Сортировка...';
            chrome.runtime.sendMessage({ action: "autoSortPriority" }, (resp) => {
                autoSortPriorityBtn.disabled = false;
                autoSortPriorityBtn.textContent = '⚡ Авто-приоритет';
                if (resp && resp.ok) {
                    showAlert('✅ Приоритеты успешно отсортированы!\n1. Частично просмотренные (по % прогресса: ближе к 100% -> выше)\n2. Не начатые (0%)\n3. Завершённые (100%) в самом низу.');
                    renderCardsView();
                } else {
                    showAlert('⚠️ Не удалось отсортировать приоритеты');
                }
            });
        });
    }

    // Сворачивание / разворачивание панели настроек бота
    const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const configSection = document.getElementById('configSection');
    if (toggleSettingsBtn && configSection) {
        toggleSettingsBtn.addEventListener('click', () => {
            configSection.classList.toggle('collapsed');
        });
    }
    if (closeSettingsBtn && configSection) {
        closeSettingsBtn.addEventListener('click', () => {
            configSection.classList.add('collapsed');
        });
    }

    // Сворачивание / разворачивание блока системных логов
    const toggleLogsCollapse = document.getElementById('toggleLogsCollapse');
    const logsSection = document.querySelector('.logs-section');
    if (toggleLogsCollapse && logsSection) {
        toggleLogsCollapse.addEventListener('click', () => {
            logsSection.classList.toggle('collapsed');
        });
    }

    // Инициализация модального каталога кампаний Twitch Drops
    initCampaignExplorer();

    // Первоначальный запрос времени кампании и периодический опрос (раз в 30 сек)
    chrome.runtime.sendMessage({ action: "getCampaignTimeLeft" }, (resp) => {
        if (resp && resp.ok && resp.campaign) renderActiveCampaignBanner(resp.campaign);
    });
    setInterval(() => {
        chrome.runtime.sendMessage({ action: "getCampaignTimeLeft" }, (resp) => {
            if (resp && resp.ok && resp.campaign) renderActiveCampaignBanner(resp.campaign);
        });
    }, 30000);
});

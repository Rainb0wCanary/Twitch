function secondsToHMS(sec) {
    sec = Math.floor(sec);
    let h = Math.floor(sec / 3600);
    let m = Math.floor((sec % 3600) / 60);
    let s = sec % 60;
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Функции для работы с группами
function getDropGroups(config) {
    const groups = {};
    if (!config || !Array.isArray(config.channels)) return groups;
    
    config.channels.forEach(ch => {
        if (typeof ch === 'object' && ch.dropId) {
            if (!groups[ch.dropId]) {
                groups[ch.dropId] = {
                    dropId: ch.dropId,
                    watchTime: ch.watchTime,
                    channels: []
                };
            }
            groups[ch.dropId].channels.push(ch.url);
        }
    });
    
    return groups;
}

function renderGroupsView() {
    const container = document.getElementById('groupsContainer');
    if (!container) return;
    
    chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
        const config = data.userConfig || { channels: [] };
        const totalWatched = data.totalWatched || {};
        const groups = getDropGroups(config);
        
        container.innerHTML = '';
        
        if (Object.keys(groups).length === 0) {
            container.innerHTML = '<p style="color:#888;padding:12px;">Нет групп дропов. Каналы без dropId не группируются.</p>';
            return;
        }
        
        Object.values(groups).forEach(group => {
            const groupDiv = document.createElement('div');
            groupDiv.className = 'card';
            groupDiv.style.marginBottom = '12px';
            groupDiv.style.padding = '12px';
            groupDiv.style.border = '1px solid #444';
            
            // Вычисляем суммарное время группы
            let groupTotalTime = 0;
            group.channels.forEach(url => {
                groupTotalTime += (totalWatched[url] || 0);
            });
            
            const targetSeconds = parseTimeToSeconds(group.watchTime);
            const progress = targetSeconds > 0 ? Math.min(100, Math.round((groupTotalTime / targetSeconds) * 100)) : 0;
            
            groupDiv.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <h3 style="margin:0;color:#4a9eff;">${group.dropId}</h3>
                    <div style="display:flex;gap:8px;">
                        <button class="btn btn-sm btn-accent edit-group-btn" data-dropid="${group.dropId}">Изменить</button>
                        <button class="btn btn-sm btn-danger delete-group-btn" data-dropid="${group.dropId}">Удалить группу</button>
                    </div>
                </div>
                <div style="margin-bottom:8px;">
                    <strong>Целевое время:</strong> ${secondsToHMS(targetSeconds)} | 
                    <strong>Просмотрено:</strong> ${secondsToHMS(groupTotalTime)} | 
                    <strong>Прогресс:</strong> ${progress}%
                </div>
                <div style="background:#333;height:8px;border-radius:4px;overflow:hidden;margin-bottom:8px;">
                    <div style="background:#4a9eff;height:100%;width:${progress}%;transition:width 0.3s;"></div>
                </div>
                <div style="margin-bottom:8px;"><strong>Каналы в группе:</strong></div>
                <ul style="margin:0;padding-left:20px;" id="group-${group.dropId}-channels"></ul>
                <div style="margin-top:8px;">
                    <input type="text" id="add-to-group-${group.dropId}" placeholder="https://www.twitch.tv/..." style="width:calc(100% - 120px);margin-right:8px;">
                    <button class="btn btn-sm btn-primary add-to-group-btn" data-dropid="${group.dropId}">Добавить канал</button>
                </div>
            `;
            
            container.appendChild(groupDiv);
            
            // Заполняем список каналов
            const channelsList = document.getElementById(`group-${group.dropId}-channels`);
            group.channels.forEach(url => {
                const li = document.createElement('li');
                const watched = totalWatched[url] || 0;
                li.innerHTML = `
                    <a href="${url}" target="_blank" style="color:#4a9eff;">${url}</a> 
                    <span style="color:#888;">(${secondsToHMS(watched)})</span>
                    <button class="btn btn-sm btn-danger remove-from-group-btn" data-url="${url}" data-dropid="${group.dropId}" style="margin-left:8px;">Удалить</button>
                `;
                channelsList.appendChild(li);
            });
        });
        
        // Обработчики для групп
        attachGroupHandlers();
    });
}

function attachGroupHandlers() {
    // Редактирование группы
    document.querySelectorAll('.edit-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                const newDropId = prompt('Новый ID группы:', dropId);
                if (!newDropId || newDropId === dropId) return;
                
                // Обновляем dropId для всех каналов группы
                config.channels = config.channels.map(ch => {
                    if (typeof ch === 'object' && ch.dropId === dropId) {
                        return { ...ch, dropId: newDropId };
                    }
                    return ch;
                });
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    renderGroupsView();
                    pollStats();
                });
            });
        });
    });
    
    // Удаление группы
    document.querySelectorAll('.delete-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            if (!confirm(`Удалить группу "${dropId}" и все её каналы?`)) return;
            
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                config.channels = config.channels.filter(ch => {
                    return !(typeof ch === 'object' && ch.dropId === dropId);
                });
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    renderGroupsView();
                    pollStats();
                });
            });
        });
    });
    
    // Добавление канала в группу
    document.querySelectorAll('.add-to-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            const input = document.getElementById(`add-to-group-${dropId}`);
            const url = input.value.trim();
            
            if (!url) {
                alert('Введите URL канала');
                return;
            }
            
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                
                // Проверяем, что канал ещё не в конфиге
                const exists = config.channels.some(ch => {
                    const chUrl = typeof ch === 'string' ? ch : ch.url;
                    return chUrl === url;
                });
                
                if (exists) {
                    alert('Этот канал уже есть в конфигурации');
                    return;
                }
                
                // Получаем watchTime из группы
                const group = config.channels.find(ch => typeof ch === 'object' && ch.dropId === dropId);
                const watchTime = group ? group.watchTime : '2.00.00';
                
                config.channels.push({
                    url,
                    watchTime,
                    dropId
                });
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    input.value = '';
                    renderGroupsView();
                    pollStats();
                });
            });
        });
    });
    
    // Удаление канала из группы
    document.querySelectorAll('.remove-from-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.getAttribute('data-url');
            const dropId = btn.getAttribute('data-dropid');
            
            if (!confirm(`Удалить канал ${url} из группы?`)) return;
            
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                config.channels = config.channels.filter(ch => {
                    if (typeof ch === 'string') return true;
                    return !(ch.url === url && ch.dropId === dropId);
                });
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    renderGroupsView();
                    pollStats();
                });
            });
        });
    });
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

function statusClassFor(statusText) {
    if (statusText === "Активен") return "status-active";
    if (statusText === "Частично") return "status-partial";
    if (statusText === "В ЧС" || statusText === "В ЧС навсегда") return "status-blacklist";
    return "";
}

// Обработчики для drag-and-drop переупорядочивания групп
// Обработчики для кнопок перемещения групп
function attachMoveGroupHandlers(tbody) {
    const groupRows = Array.from(tbody.querySelectorAll('tr[data-group-row-start]'));
    const groupIds = groupRows.map(r => r.dataset.groupId);
    
    const move = (rowId, direction) => {
        const idx = groupIds.indexOf(rowId);
        if (idx === -1) return;
        const swapWith = direction === 'up' ? idx - 1 : idx + 1;
        if (swapWith < 0 || swapWith >= groupIds.length) return;
        [groupIds[idx], groupIds[swapWith]] = [groupIds[swapWith], groupIds[idx]];
        saveGroupOrderArray(groupIds);
        pollStats();
    };
    
    groupRows.forEach((row) => {
        const moveUpBtn = row.querySelector('.move-group-up-btn');
        const moveDownBtn = row.querySelector('.move-group-down-btn');
        const rowId = row.dataset.groupId;
        
        if (moveUpBtn) {
            moveUpBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                move(rowId, 'up');
            });
        }
        
        if (moveDownBtn) {
            moveDownBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                move(rowId, 'down');
            });
        }
    });
}

function saveGroupOrder(tbody) {
    const newOrder = [];
    tbody.querySelectorAll('tr[data-group-row-start]').forEach(r => {
        if (r.dataset.groupId) {
            newOrder.push(r.dataset.groupId);
        }
    });
    
    saveGroupOrderArray(newOrder);
}

function saveGroupOrderArray(orderArr) {
    chrome.storage.local.get('userConfig', (data) => {
        const config = data.userConfig || {};
        config.groupOrder = orderArr;
        chrome.storage.local.set({ userConfig: config });
    });
}

// Обработчики для групповых кнопок в таблице
function attachGroupRowHandlers() {
    // Редактирование группы (изменение ID)
    document.querySelectorAll('.edit-group-row-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            const newDropId = prompt('Новый ID группы:', dropId);
            if (!newDropId || newDropId === dropId) return;
            
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                config.channels = config.channels.map(ch => {
                    if (typeof ch === 'object' && ch.dropId === dropId) {
                        return { ...ch, dropId: newDropId };
                    }
                    return ch;
                });
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    pollStats();
                    renderGroupsView();
                });
            });
        });
    });
    
    // Удаление группы
    document.querySelectorAll('.delete-group-row-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            if (!confirm(`Удалить группу "${dropId}" и все её каналы?`)) return;
            
            chrome.storage.local.get('userConfig', (data) => {
                const config = data.userConfig || { channels: [] };
                config.channels = config.channels.filter(ch => {
                    return !(typeof ch === 'object' && ch.dropId === dropId);
                });
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    pollStats();
                    renderGroupsView();
                });
            });
        });
    });
    
        // Сброс времени группы
    document.querySelectorAll('.reset-group-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
                const config = data.userConfig || { channels: [] };
                const totalWatched = data.totalWatched || {};
                
                // Находим все каналы этой группы
                const channelsInGroup = config.channels.filter(ch => typeof ch === 'object' && ch.dropId === dropId).map(ch => ch.url);
                
                // Сбрасываем время для всех каналов группы
                channelsInGroup.forEach(url => {
                    totalWatched[url] = 0;
                });
                
                chrome.storage.local.set({ totalWatched }, () => {
                    pollStats();
                });
            });
        });
    });
    
    // Блокировка каналов в группе (индивидуально для каждого канала)
    document.querySelectorAll('.blacklist-group-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const dropId = btn.getAttribute('data-dropid');
            const isUnblock = btn.textContent.trim() === 'Разбл.';
            
            chrome.storage.local.get(['userConfig', 'totalWatched'], (data) => {
                const config = data.userConfig || { channels: [] };
                if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};
                
                // Находим все каналы этой группы
                const channelsInGroup = config.channels.filter(ch => typeof ch === 'object' && ch.dropId === dropId).map(ch => ch.url);
                
                if (isUnblock) {
                    // Разблокируем все каналы группы (каждый независимо)
                    channelsInGroup.forEach(url => {
                        delete config.blacklist[url];
                    });
                } else {
                    // Блокируем каждый канал индивидуально (на время по умолчанию или перманентно)
                    const tempVal = config.tempBlacklistSeconds || (config.tempBlacklist || null);
                    if (tempVal) {
                        const seconds = parseTimeToSeconds(tempVal);
                        const ts = Date.now() + seconds * 1000;
                        channelsInGroup.forEach(url => {
                            config.blacklist[url] = ts;
                        });
                    } else {
                        channelsInGroup.forEach(url => {
                            config.blacklist[url] = 'permanent';
                        });
                    }
                }
                
                chrome.storage.local.set({ userConfig: config }, () => {
                    pollStats();
                });
            });
        });
    });
}

function updateStatsTable(stats) {
    const tbody = document.querySelector("#statsTable tbody");
    if (!tbody) return;
    
    chrome.storage.local.get(["userConfig", "totalWatched"], (data) => {
        const config = data.userConfig;
        const blacklist = typeof config?.blacklist === "object" ? config.blacklist : {};
        const channels = Array.isArray(config?.channels) ? config.channels : [];
        const totalWatched = data.totalWatched || {};
        const groupOrder = Array.isArray(config?.groupOrder) ? config.groupOrder : [];
        
        // Группируем каналы по dropId
        const groups = {};
        const ungrouped = [];
        
        channels.forEach(ch => {
            const url = typeof ch === "string" ? ch : ch.url;
            const dropId = (typeof ch === "object" && ch.dropId) ? ch.dropId : null;
            
            if (dropId) {
                if (!groups[dropId]) {
                    groups[dropId] = {
                        dropId,
                        watchTime: typeof ch === "object" ? ch.watchTime : null,
                        channels: []
                    };
                }
                groups[dropId].channels.push({ url, ch });
            } else {
                ungrouped.push({ url, ch });
            }
        });
        
        // Сортируем группы по сохраненному порядку
        const sortedGroupIds = groupOrder.filter(id => groups[id]).concat(
            Object.keys(groups).filter(id => !groupOrder.includes(id))
        );
        
        const fragment = document.createDocumentFragment();
        
        // Отрисовываем группы (одна строка на канал, group-данные в rowspan)
        let groupOrderCounter = 0;
        sortedGroupIds.forEach(dropId => {
            const group = groups[dropId];
            groupOrderCounter += 1;
            const targetSec = group.watchTime ? parseTimeToSeconds(group.watchTime) : 0;
            let groupTotalTime = 0;
            let hasAnyBlocked = false;
            let allPermanent = true;
            
            // Вычисляем суммарное время группы и статус
            group.channels.forEach(item => {
                groupTotalTime += (totalWatched[item.url] || 0);
                if (blacklist[item.url]) {
                    hasAnyBlocked = true;
                    if (blacklist[item.url] !== "permanent") allPermanent = false;
                }
            });
            
            const allChannelsBlocked = group.channels.every(item => blacklist[item.url]);
            let groupStatus = "Активен";
            if (allChannelsBlocked) {
                groupStatus = allPermanent ? "В ЧС навсегда" : "В ЧС";
            } else if (hasAnyBlocked) {
                groupStatus = "Частично";
            }
            
            const progressPercent = targetSec > 0 ? Math.min(100, Math.floor((groupTotalTime / targetSec) * 100)) : 0;
            const groupRowspan = group.channels.length;
            
            // Каждый канал группы — отдельная строка
            group.channels.forEach((item, idx) => {
                const channelTime = totalWatched[item.url] || 0;
                const isChannelBlocked = !!blacklist[item.url];
                let channelStatus = "Активен";
                let channelUntil = "";
                
                if (blacklist[item.url] === "permanent") {
                    channelStatus = "В ЧС навсегда";
                    channelUntil = "∞";
                } else if (blacklist[item.url]) {
                    const msLeft = blacklist[item.url] - Date.now();
                    channelStatus = "В ЧС";
                    channelUntil = msLeft > 0 ? msToHMS(msLeft) : "0:00:00";
                }
                
                const tr = document.createElement("tr");
                tr.classList.add("group-row");
                if (idx === 0) {
                    tr.classList.add("group-first");
                    tr.dataset.groupId = group.dropId;
                    tr.dataset.groupRowStart = true;
                }
                
                // Колонки с rowspan только для суммы/цели/прогресса/приоритета; статус теперь поканально
                if (idx === 0) {
                    tr.innerHTML = `
                        <td class="group-cell" rowspan="${groupRowspan}">
                            <div style="display:flex;flex-direction:column;gap:4px;align-items:center;">
                                <button class="btn btn-xs move-group-up-btn" title="Переместить вверх">↑</button>
                                <span>${group.dropId}</span>
                                <button class="btn btn-xs move-group-down-btn" title="Переместить вниз">↓</button>
                            </div>
                        </td>
                        <td><a href="${item.url}" target="_blank" class="channel-link">${item.url}</a></td>
                        <td class="time-cell">${secondsToHMS(channelTime)}</td>
                        <td class="group-cell time-cell" rowspan="${groupRowspan}">${secondsToHMS(groupTotalTime)}</td>
                        <td class="group-cell time-cell" rowspan="${groupRowspan}">${secondsToHMS(targetSec)}</td>
                        <td class="status-cell ${statusClassFor(channelStatus)}">${channelStatus}${channelUntil ? ` (${channelUntil})` : ''}</td>
                        <td class="group-cell" rowspan="${groupRowspan}"><span class="progress-text">${progressPercent}%</span></td>
                        <td class="table-actions">
                            <button class="btn btn-xs btn-accent edit-channel-btn" data-url="${item.url}" title="Изменить канал">Изм</button>
                            <button class="btn btn-xs btn-danger delete-channel-btn" data-url="${item.url}" title="Удалить канал">Удл</button>
                            <button class="btn btn-xs btn-warning reset-channel-btn" data-url="${item.url}" title="Сбросить время">Сбр</button>
                            <button class="btn btn-xs btn-primary channel-blacklist-btn" data-url="${item.url}">${isChannelBlocked ? 'Раз' : 'ЧС'}</button>
                        </td>
                        <td class="priority-cell" rowspan="${groupRowspan}">${groupOrderCounter}</td>
                    `;
                } else {
                    tr.innerHTML = `
                        <td><a href="${item.url}" target="_blank" class="channel-link">${item.url}</a></td>
                        <td class="time-cell">${secondsToHMS(channelTime)}</td>
                        <td class="status-cell ${statusClassFor(channelStatus)}">${channelStatus}${channelUntil ? ` (${channelUntil})` : ''}</td>
                        <td class="table-actions">
                            <button class="btn btn-xs btn-accent edit-channel-btn" data-url="${item.url}" title="Изменить канал">Изм</button>
                            <button class="btn btn-xs btn-danger delete-channel-btn" data-url="${item.url}" title="Удалить канал">Удл</button>
                            <button class="btn btn-xs btn-warning reset-channel-btn" data-url="${item.url}" title="Сбросить время">Сбр</button>
                            <button class="btn btn-xs btn-primary channel-blacklist-btn" data-url="${item.url}">${isChannelBlocked ? 'Раз' : 'ЧС'}</button>
                        </td>
                        
                    `;
                }
                
                fragment.appendChild(tr);
            });
        });
        
        // Отрисовываем негруппированные каналы
        ungrouped.forEach((item, idx) => {
            const url = item.url;
            const ch = item.ch;
            const sec = stats && stats[url] ? stats[url] : 0;
            let targetSec = 0;
            if (typeof ch === "string") {
                targetSec = config && config.watchTime ? parseTimeToSeconds(config.watchTime) : 0;
            } else {
                targetSec = ch.watchTime ? parseTimeToSeconds(ch.watchTime) : (config && config.watchTime ? parseTimeToSeconds(config.watchTime) : 0);
            }
            
            let statusText = "Активен";
            let statusClass = "status-active";
            let untilText = "";
            
            if (blacklist[url] === "permanent") {
                statusText = "В ЧС навсегда";
                statusClass = "status-blacklist";
                untilText = "∞";
            } else if (blacklist[url]) {
                const msLeft = blacklist[url] - Date.now();
                statusText = "В ЧС";
                statusClass = "status-blacklist";
                untilText = msLeft > 0 ? msToHMS(msLeft) : "0:00:00";
            }
            
            const progressPercent = targetSec > 0 ? Math.min(100, Math.floor((sec / targetSec) * 100)) : 0;
            const isBlacklisted = !!blacklist[url];
            
            const tr = document.createElement("tr");
            tr.classList.add("ungrouped-row");
            tr.innerHTML = `
                <td style="text-align:center;">—</td>
                <td><a href="${url}" target="_blank" class="channel-link">${url}</a></td>
                <td class="time-cell">${secondsToHMS(sec)}</td>
                <td class="time-cell">${secondsToHMS(sec)}</td>
                <td class="time-cell">${secondsToHMS(targetSec)}</td>
                <td class="${statusClass}">${statusText}</td>
                <td><span class="progress-text">${progressPercent}%</span></td>
                <td class="table-actions">
                    <button class="btn btn-xs btn-accent edit-btn" data-url="${url}">Изм</button>
                    <button class="btn btn-xs btn-danger delete-btn" data-url="${url}">Удл</button>
                    <button class="btn btn-xs btn-warning reset-watch-btn" data-url="${url}">Сбр</button>
                    <button class="btn btn-xs btn-primary blacklist-toggle-btn" data-url="${url}">${isBlacklisted ? 'Раз' : 'ЧС'}</button>
                </td>
                <td>—</td>
            `;
            fragment.appendChild(tr);
        });
        
        // Обновляем таблицу
        tbody.innerHTML = "";
        tbody.appendChild(fragment);
        
        // Добавляем обработчики для кнопок перемещения групп
        attachMoveGroupHandlers(tbody);
        
        // Обработчики для групповых кнопок
        attachGroupRowHandlers();
        
        // Обработчики для блокировки отдельных каналов в группе
        document.querySelectorAll('.channel-blacklist-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-url');
                const isUnblock = btn.textContent.trim() === 'Раз';
                
                chrome.storage.local.get('userConfig', (data) => {
                    const config = data.userConfig || { channels: [] };
                    if (typeof config.blacklist !== 'object' || Array.isArray(config.blacklist)) config.blacklist = {};
                    
                    if (isUnblock) {
                        delete config.blacklist[url];
                    } else {
                        const tempVal = config.tempBlacklistSeconds || (config.tempBlacklist || null);
                        if (tempVal) {
                            const seconds = parseTimeToSeconds(tempVal);
                            const ts = Date.now() + seconds * 1000;
                            config.blacklist[url] = ts;
                        } else {
                            config.blacklist[url] = 'permanent';
                        }
                    }
                    
                    chrome.storage.local.set({ userConfig: config }, () => {
                        pollStats();
                    });
                });
            });
        });
        
        // Обработчики для кнопок редактирования/удаления/сброса каналов в группах
        document.querySelectorAll('.edit-channel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-url');
                chrome.storage.local.get('userConfig', (data) => {
                    const cfg = data.userConfig || { channels: [] };
                    const idx = (cfg.channels || []).findIndex(ch => (typeof ch === 'string' ? ch : ch.url) === url);
                    if (idx === -1) return;
                    const ch = cfg.channels[idx];
                    const curUrl = typeof ch === 'string' ? ch : ch.url;
                    const curWatch = typeof ch === 'string' ? '' : (ch.watchTime || '');
                    const curDropId = typeof ch === 'object' ? (ch.dropId || '') : '';
                    
                    const newUrl = showPrompt('Изменить URL канала:', curUrl);
                    if (!newUrl) return;
                    const newWatch = showPrompt('Изменить время просмотра (H.MM.SS) или оставьте пустым для значения по умолчанию:', curWatch);
                    const newDropId = showPrompt('Изменить ID группы дропа (или оставьте пустым):', curDropId);
                    
                    const newEntry = {
                        url: newUrl,
                        ...(newWatch && { watchTime: newWatch }),
                        ...(newDropId && { dropId: newDropId })
                    };
                    
                    cfg.channels[idx] = newEntry;
                    chrome.storage.local.set({ userConfig: cfg }, () => { 
                        pollStats();
                        renderGroupsView();
                    });
                });
            });
        });
        
        document.querySelectorAll('.delete-channel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-url');
                if (!showConfirm('Удалить канал ' + url + '?')) return;
                chrome.storage.local.get('userConfig', (data) => {
                    const cfg = data.userConfig || { channels: [] };
                    cfg.channels = (cfg.channels || []).filter(ch => (typeof ch === 'string' ? ch : ch.url) !== url);
                    chrome.storage.local.set({ userConfig: cfg }, () => { pollStats(); });
                });
            });
        });
        
        document.querySelectorAll('.reset-channel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = btn.getAttribute('data-url');
                resetWatchTime(url);
            });
        });

        
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
                        const curDropId = typeof ch === 'object' ? (ch.dropId || '') : '';
                        
                        const newUrl = showPrompt('Изменить URL канала:', curUrl);
                        if (!newUrl) return;
                        const newWatch = showPrompt('Изменить время просмотра (H.MM.SS) или оставьте пустым для значения по умолчанию:', curWatch);
                        const newDropId = showPrompt('Изменить ID группы дропа (или оставьте пустым):', curDropId);
                        
                        const newEntry = {
                            url: newUrl,
                            ...(newWatch && { watchTime: newWatch }),
                            ...(newDropId && { dropId: newDropId })
                        };
                        
                        cfg.channels[idx] = newEntry;
                        chrome.storage.local.set({ userConfig: cfg }, () => { 
                            pollStats();
                            renderGroupsView();
                        });
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
            const dropId = el.getAttribute('data-dropid');
            
            if (url) {
                // Для нгеруппированных каналов
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
            } else if (dropId) {
                // Для групп
                chrome.runtime.sendMessage({ action: 'getDropGroupPercent', dropId }, (resp) => {
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
                            // Обновляем значения формы конфигурации сразу после загрузки
                            try { loadConfigForm(); } catch (e) { /* если функция недоступна — игнорируем */ }
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
    const newChannelDropIdInput = document.getElementById('newChannelDropIdInput');
    const addChannelRowButton = document.getElementById('addChannelRowButton');

    if (addChannelRowButton) {
        addChannelRowButton.addEventListener('click', () => {
            const url = newChannelUrlInput ? newChannelUrlInput.value.trim() : '';
            const watchTime = newChannelWatchTimeInput ? newChannelWatchTimeInput.value.trim() : '';
            const dropId = newChannelDropIdInput ? newChannelDropIdInput.value.trim() : '';
            if (!url) { showAlert('Введите URL канала'); return; }
            // простая валидация URL
            if (!/^https?:\/\/.+/.test(url)) { if (!/^www\./.test(url)) { showAlert('Введите корректный URL'); return; } }
            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || { channels: [] };
                if (!Array.isArray(cfg.channels)) cfg.channels = [];
                const entry = {
                    url,
                    ...(watchTime && { watchTime }),
                    ...(dropId && { dropId })
                };
                cfg.channels.push(entry);
                chrome.storage.local.set({ userConfig: cfg }, () => {
                    newChannelUrlInput.value = '';
                    newChannelWatchTimeInput.value = '';
                    newChannelDropIdInput.value = '';
                    pollStats();
                    renderGroupsView();
                });
            });
        });
    }
    
    // Обработчики для секции групп
    const toggleGroupsView = document.getElementById('toggleGroupsView');
    const createNewGroup = document.getElementById('createNewGroup');
    const groupsContainer = document.getElementById('groupsContainer');
    
    if (toggleGroupsView) {
        toggleGroupsView.addEventListener('click', () => {
            if (groupsContainer.style.display === 'none') {
                groupsContainer.style.display = 'block';
                renderGroupsView();
            } else {
                groupsContainer.style.display = 'none';
            }
        });
    }
    
    if (createNewGroup) {
        createNewGroup.addEventListener('click', () => {
            const dropId = prompt('Введите ID новой группы дропа:');
            if (!dropId) return;
            
            const watchTime = prompt('Введите целевое время просмотра (H.MM.SS):', '2.00.00');
            if (!watchTime) return;
            
            const channelUrl = prompt('Введите URL первого канала группы:');
            if (!channelUrl) return;
            
            chrome.storage.local.get('userConfig', (data) => {
                const cfg = data.userConfig || { channels: [] };
                if (!Array.isArray(cfg.channels)) cfg.channels = [];
                
                // Проверяем, что такой dropId ещё не существует
                const exists = cfg.channels.some(ch => typeof ch === 'object' && ch.dropId === dropId);
                if (exists) {
                    alert(`Группа с ID "${dropId}" уже существует`);
                    return;
                }
                
                cfg.channels.push({
                    url: channelUrl,
                    watchTime,
                    dropId
                });
                
                chrome.storage.local.set({ userConfig: cfg }, () => {
                    renderGroupsView();
                    pollStats();
                });
            });
        });
    }
    
    // Инициализация отображения групп
    renderGroupsView();

});

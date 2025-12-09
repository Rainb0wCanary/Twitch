/**
 * Универсальный скрипт для сбора ссылок дропов
 * Запустите этот скрипт в консоли браузера на странице с дропами
 * 
 * Поддерживаемые платформы:
 * - Twitch,Kick
 * 
 * Скрипт соберёт все доступные дропы и сгруппирует их по ID
 */

(function collectDropsLinks() {
    console.log('🔍 Начинаю сбор ссылок дропов...');
    
    // Определяем платформу
    const hostname = window.location.hostname.toLowerCase();
    const isTwitch = hostname.includes('twitch.tv');
    const isKick = hostname.includes('kick.com');
    const isUniversal = !isTwitch && !isKick;
    
    if (isUniversal) {
        console.log('🌐 Универсальный режим: ' + hostname);
        console.log('💡 Скрипт попытается найти ссылки автоматически');
    }
    
    const drops = [];
    let dropIdCounter = 1;
    
    // Функция для парсинга времени из текста
    function parseTimeText(timeText) {
        if (!timeText) return '2.00.00';
        
        const hoursMatch = timeText.match(/(\d+)\s*hour/i);
        const minutesMatch = timeText.match(/(\d+)\s*minute/i);
        
        const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
        const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
        
        return `${hours}.${minutes.toString().padStart(2, '0')}.00`;
    }
    
    // Проверяем наличие структуры с .drop-box (универсальный формат для Rust и других)
    const dropBoxes = document.querySelectorAll('.drop-box');
    
    if (dropBoxes.length > 0) {
        console.log(`📦 Найдено ${dropBoxes.length} дроп-боксов`);
        
        dropBoxes.forEach((box, index) => {
            try {
                // Получаем название дропа
                const dropTypeElement = box.querySelector('.drop-type');
                const dropName = dropTypeElement ? dropTypeElement.textContent.trim() : `Drop ${index + 1}`;
                
                // Получаем время просмотра
                const timeElement = box.querySelector('.drop-time span');
                const watchTime = parseTimeText(timeElement ? timeElement.textContent : '');
                
                // Получаем все стримеры для этого дропа
                const streamerLinks = box.querySelectorAll('.drop-box-header a.streamer-info');
                const channels = [];
                
                streamerLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    if (href && (href.includes('twitch.tv/') || href.includes('kick.com/'))) {
                        // Нормализуем URL
                        const url = href.startsWith('http') ? href : `https://${href}`;
                        channels.push(url);
                    }
                });
                
                if (channels.length === 0) {
                    console.warn(`⚠️ Дроп "${dropName}" не имеет стримеров, пропускаем...`);
                    return;
                }
                
                const dropId = `drop_${dropIdCounter++}`;
                
                drops.push({
                    dropId,
                    name: dropName,
                    watchTime,
                    channels,
                    note: channels.length > 1 ? `Можно смотреть любого из ${channels.length} стримеров` : 'Один стример'
                });
                
                console.log(`✅ ${dropName}: ${channels.length} стример(ов), ${watchTime}`);
                
            } catch (e) {
                console.error(`Ошибка при обработке дропа ${index + 1}:`, e);
            }
        });
    } else if (isTwitch) {
        console.log('📺 Платформа: Twitch (стандартный формат)');
        
        // Ищем все карточки дропов (официальный формат Twitch)
        const dropCards = document.querySelectorAll('[data-a-target="drops-campaign-card"]');
        
        if (dropCards.length === 0) {
            console.warn('⚠️ Дропы не найдены. Убедитесь, что вы на странице https://www.twitch.tv/drops/campaigns и дропы загружены.');
            return;
        }
        
        dropCards.forEach((card, index) => {
            try {
                // Получаем название дропа
                const titleElement = card.querySelector('h3, [class*="title"]');
                const dropName = titleElement ? titleElement.textContent.trim() : `Drop ${index + 1}`;
                
                // Получаем время просмотра
                const timeElement = card.querySelector('[class*="required-watch-time"], [class*="time"]');
                let watchTime = '2.00.00'; // По умолчанию 2 часа
                
                if (timeElement) {
                    const timeText = timeElement.textContent;
                    const hoursMatch = timeText.match(/(\d+)\s*h/i);
                    const minutesMatch = timeText.match(/(\d+)\s*m/i);
                    
                    if (hoursMatch || minutesMatch) {
                        const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
                        const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
                        watchTime = `${hours}.${minutes.toString().padStart(2, '0')}.00`;
                    }
                }
                
                // Ищем каналы для этого дропа
                const channelLinks = card.querySelectorAll('a[href*="/directory/category/"]');
                const channels = new Set();
                
                channelLinks.forEach(link => {
                    const href = link.getAttribute('href');
                    if (href) {
                        channels.add(href);
                    }
                });
                
                // Если каналы указаны прямо - ищем их
                const channelElements = card.querySelectorAll('a[href^="https://www.twitch.tv/"]:not([href*="/directory/"])');
                channelElements.forEach(link => {
                    const href = link.getAttribute('href');
                    if (href && href.includes('twitch.tv/') && !href.includes('/directory/')) {
                        channels.add(href);
                    }
                });
                
                const dropId = `drop_${dropIdCounter++}`;
                
                drops.push({
                    dropId,
                    name: dropName,
                    watchTime,
                    channels: Array.from(channels),
                    note: channels.size > 1 ? 'Можно смотреть любой из каналов' : 'Один канал'
                });
                
            } catch (e) {
                console.error(`Ошибка при обработке дропа ${index + 1}:`, e);
            }
        });
    } else if (isKick) {
        console.log('🎮 Платформа: Kick');
        
        // Для Kick - адаптируйте селекторы под структуру их страницы
        console.warn('⚠️ Сбор ссылок для Kick требует адаптации селекторов под текущую структуру страницы.');
        console.log('💡 Проверьте структуру HTML и обновите селекторы в этом скрипте.');
    }
    
    if (drops.length === 0) {
        console.warn('⚠️ Не удалось собрать дропы. Проверьте структуру страницы.');
        return;
    }
    
    // Определяем searchUrlPart
    let searchUrlPart = "https://www.twitch.tv/directory/category/rust";
    
    if (dropBoxes.length > 0) {
        // Для универсального режима с .drop-box пытаемся определить игру автоматически
        // Ищем ссылки на категории в общем контексте страницы
        const categoryLinks = document.querySelectorAll('a[href*="/directory/category/"], a[href*="/category/"]');
        if (categoryLinks.length > 0) {
            searchUrlPart = categoryLinks[0].href;
            console.log(`📁 Автоматически определена категория: ${searchUrlPart}`);
        } else {
            // Запрашиваем у пользователя
            const userInput = prompt('Введите URL категории игры (например: https://www.twitch.tv/directory/category/rust):', 'https://www.twitch.tv/directory/category/rust');
            if (userInput) {
                searchUrlPart = userInput;
            }
        }
    } else if (isKick) {
        searchUrlPart = "kick_game_url";
    }
    
    // Формируем config.json
    const config = {
        searchUrlPart,
        checkIntervalMinutes: 1,
        channels: [],
        waitBeforeCheck: 20,
        maxAttempts: 5,
        tempBlacklistSeconds: "0.05.00"
    };
    
    // Добавляем каналы из дропов
    drops.forEach(drop => {
        if (drop.channels.length === 0) {
            console.warn(`⚠️ Дроп "${drop.name}" не имеет каналов, пропускаем...`);
            return;
        }
        
        if (drop.channels.length === 1) {
            // Один канал - добавляем без особой группировки
            config.channels.push({
                url: drop.channels[0],
                watchTime: drop.watchTime,
                dropId: drop.dropId
            });
        } else {
            // Несколько каналов - добавляем все с одинаковым dropId
            drop.channels.forEach(channelUrl => {
                config.channels.push({
                    url: channelUrl,
                    watchTime: drop.watchTime,
                    dropId: drop.dropId
                });
            });
        }
    });
    
    // Выводим результат
    console.log('\n✅ Сбор завершён!');
    console.log(`📊 Найдено дропов: ${drops.length}`);
    console.log(`📺 Всего каналов: ${config.channels.length}`);
    console.log('\n📋 Информация о дропах:');
    
    drops.forEach(drop => {
        console.log(`\n🎁 ${drop.name}`);
        console.log(`   ID: ${drop.dropId}`);
        console.log(`   Время: ${drop.watchTime}`);
        console.log(`   Каналов: ${drop.channels.length}`);
        if (drop.channels.length > 0) {
            console.log(`   Каналы: ${drop.channels.join(', ')}`);
        }
    });
    
    console.log('\n\n📄 config.json:');
    console.log(JSON.stringify(config, null, 2));
    
    console.log('\n\n💾 Копирование в буфер обмена...');
    
    // Копируем в буфер обмена
    const jsonString = JSON.stringify(config, null, 2);
    navigator.clipboard.writeText(jsonString).then(() => {
        console.log('✅ Config скопирован в буфер обмена!');
        console.log('📝 Теперь вы можете вставить его в файл config.json');
    }).catch(err => {
        console.error('❌ Ошибка при копировании:', err);
        console.log('📝 Скопируйте config вручную из консоли выше');
    });
    
    // Возвращаем конфиг для дальнейшего использования
    return config;
})();

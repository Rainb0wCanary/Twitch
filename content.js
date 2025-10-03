function findAndHighlightLink(searchText) {
    try {
    // Убедиться, что стиль подсветки существует
        try {
            if (!document.getElementById('tc-highlight-style')) {
                const style = document.createElement('style');
                style.id = 'tc-highlight-style';
                style.textContent = `
                .tc-highlight {
                    outline: 4px solid rgba(255,0,0,1) !important;
                    box-shadow: 0 0 12px rgba(255,0,0,0.95) !important;
                    transition: box-shadow 0.2s ease-in-out;
                    z-index: 2147483647 !important;
                }
                `;
                (document.head || document.documentElement).appendChild(style);
            }
        } catch (e) {
            // игнорируем ошибки вставки стиля
        }
        const links = document.querySelectorAll('a[data-a-target="stream-game-link"]');
        let foundLink = null;

    // Нормализуем searchText
        const needle = (typeof searchText === 'string' ? searchText.trim().toLowerCase() : '');

    // Предпочтение совпадениям в верхней области; иначе принимаем любой видимый результат
        let fallbackMatch = null;
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            try {
                const href = link.href || '';
                const rect = link.getBoundingClientRect();
                const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
                const inTopArea = rect.top >= 0 && rect.top < (window.innerHeight / 2);

                if (!visible) continue;

                if (needle === '') {
                    foundLink = link;
                    break;
                }

                const text = (link.textContent || '').trim().toLowerCase();
                const hrefMatch = href.toLowerCase().includes(needle);
                const textMatch = text && text.includes(needle);

                // предпочитаем совпадение в верхней области
                if ((hrefMatch || textMatch) && inTopArea) {
                    foundLink = link;
                    break;
                }
                // иначе запоминаем первое видимое совпадение как запасной вариант
                if ((hrefMatch || textMatch) && !fallbackMatch) {
                    fallbackMatch = link;
                }
            } catch (e) {
                continue;
            }
        }

        if (!foundLink && fallbackMatch) foundLink = fallbackMatch;

        if (foundLink) {
            const rect = foundLink.getBoundingClientRect();
            console.log(`Ссылка найдена (content.js). href=${foundLink.href} top=${Math.round(rect.top)} visibleHeight=${Math.round(rect.height)}`);
            // удалить предыдущие подсветки
            try {
                document.querySelectorAll('.tc-highlight').forEach(el => el.classList.remove('tc-highlight'));
                // добавить подсветку найденной ссылке
                foundLink.classList.add('tc-highlight');
            } catch (e) {
                // игнорируем ошибки модификации DOM
            }
            return { found: true, href: foundLink.href, position: { x: rect.left, y: rect.top } };
        }
        console.log("Ссылка не найдена (content.js).");
        return { found: false };
    } catch (err) {
        console.error("Ошибка в findAndHighlightLink:", err);
        return { found: false, error: String(err) };
    }
}

// Обработчик сообщений с обработкой ошибок
try {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        try {
            if (request.action === "findLink") {
                let result = findAndHighlightLink(request.text);
                sendResponse(result);
            }
        } catch (err) {
            console.error("Ошибка в content.js при обработке сообщения:", err);
            sendResponse({ found: false, error: String(err) });
        }
        // Для поддержки асинхронных ответов (но здесь не требуется)
        return false;
    });
} catch (err) {
    console.error("Ошибка при регистрации onMessage в content.js:", err);
}



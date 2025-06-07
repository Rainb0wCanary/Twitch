function findAndHighlightLink(searchText) {
    try {
        let links = document.querySelectorAll('a[data-a-target="stream-game-link"]');
        let foundLink = null;

        links.forEach(link => {
            if (link.href.includes(searchText)) {
                foundLink = link;
            }
        });

        if (foundLink) {
            let rect = foundLink.getBoundingClientRect();
            console.log(`Ссылка найдена! X=${rect.left}, Y=${rect.top}`);
            return { found: true, href: foundLink.href, position: { x: rect.left, y: rect.top } };
        } else {
            console.log("Ссылка не найдена.");
            return { found: false };
        }
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



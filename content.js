function findAndHighlightLink(searchText) {
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
}

// Обработчик сообщений
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "findLink") {
        let result = findAndHighlightLink(request.text);
        sendResponse(result);
    }
});

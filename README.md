# Drops — Auto Collector

Расширение для автоматизации просмотра каналов с целью сбора дропов в определённых игровых категориях.

Это MV3-расширение помогает:

- Автоматически открывать каналы из списка и проверять наличие ссылки на игровую категорию.
- Отслеживать фактическое время просмотра по каждому каналу.

- `stats.html` / `stats.js` — подробная таблица со статусом каналов, логами и ручным управлением.
- `config.json` — пример конфигурации.

## Настройка (config.json)

Откройте `config.json` и настройте поля:

- `searchUrlPart`: строка — часть URL категории/игры, которую ищет content script (например, "rust").
- `channels`: массив строк или объектов с каналами. Поддерживается как простая строка-URL, так и объект:

	- Пример объекта: { "url": "https://www.twitch.tv/templetaps", "watchTime": "0.10.30" }

	- Формат `watchTime`: "H.MM.SS" — часы, минуты, секунды. Часто используется "0.10.30" для 10 минут 30 секунд.
- `waitBeforeCheck`: число — секунд ожидания перед проверкой наличия ссылки на игру после загрузки страницы.
- `maxAttempts`: число — сколько раз пробовать найти ссылку прежде чем поместить канал во временный ЧС.
- `tempBlacklistSeconds`: строка или число — сколько времени держать временный бан; можно указать как "H.MM.SS" или как число секунд.

Пример конфигурации:

```
{
	"searchUrlPart": "rust",
	"channels": [
		{ "url": "https://www.twitch.tv/templetaps", "watchTime": "0.10.30" },
		{ "url": "https://www.twitch.tv/posty", "watchTime": "0.10.30" },
		{ "url": "https://www.twitch.tv/shroud", "watchTime": "0.10.30" }
	],
	"waitBeforeCheck": 10,
	"maxAttempts": 5,
	"tempBlacklistSeconds": "0.5.30"
}
```

## Как использовать

- Откройте popup (иконка расширения) и загрузите `config.json` при первом запуске.
- Нажмите "Start" (Старт просмотра) — фоновой воркер начнёт последовательно или параллельно открывать каналы (в фоне) и проверять наличие ссылки на категорию.
- Если ссылка найдена, канал считается валидным и начнёт отсчёт времени просмотра по указанному `watchTime`.
- Когда время просмотра закончится, расширение перейдёт к следующему каналу.
- В `stats.html` отображается подробная информация: URL канала, общее время просмотренных секунд, статус (Active / Blacklisted / Temp blacklisted), количество попыток, кнопки "Сбросить", "Сделать неактивным/активным" и пр.
- Управление логами: включите/выключите запись логов в popup — если логи выключены, они не сохраняются в storage.

Особенности поведения:

- Если все каналы оказались в ЧС — процесс приостанавливается и ждёт, пока хотя бы один канал не выйдет из ЧС.
- Временная блокировка управляется параметром `tempBlacklistSeconds` — после истечения времени канал автоматически снимается с временного бана.
- Background сервис-воркер ориентирован на хранение состояния в `chrome.storage.local`, поэтому он устойчив к перезапускам воркера.

## Быстрое формирование конфига через DevTools

Если у вас есть страница с дропами или списком стримеров, чтобы собрать `channels` автоматически — откройте DevTools (F12) и выполните этот скрипт в Console:

```js
function parseWatchTime(text) {
	let hours = 0, minutes = 0;

	if (/hour/i.test(text)) {
		const match = text.match(/(\d+)\s*hour/i);
		if (match) hours = parseInt(match[1]);
	}

	if (/minute/i.test(text)) {
		const match = text.match(/(\d+)\s*minute/i);
		if (match) minutes = parseInt(match[1]);
	}

	// Преобразуем в формат HH.MM.SS
	return `${hours}.${String(minutes).padStart(2, '0')}.30`;
}

const channels = [...document.querySelectorAll('.drop-box')].map(box => {
	const url = box.querySelector('.streamer-info')?.href;
	const rawTime = box.querySelector('.drop-time span')?.textContent.trim() || "";
	const watchTime = parseWatchTime(rawTime);
	return url ? { url, watchTime } : null;
}).filter(Boolean);

console.log(JSON.stringify({ channels }, null, 2));
```

Этот скрипт — всего лишь пример. Теги и классы на реальной странице могут отличаться: скорректируйте селекторы под конкретную структуру страницы.

## Советы по отладке

- Откройте DevTools popup (правый клик → Inspect popup) чтобы увидеть сообщения и ошибки от `popup.js`.
- Откройте DevTools для страницы со стримом, чтобы отследить работу `content.js`.
- Проверяйте `chrome.storage.local` через DevTools Application → Storage → Extensions → Local Storage или вызовом `chrome.storage.local.get(null, console.log)` в консоли background.

## Безопасность и ограничения

- Расширение использует `chrome.tabs.create({ active: false })` для незаметного открытия вкладок — не закрывайте вкладки ручным образом, иначе логика времени просмотров может быть нарушена.
- Не храните секреты в конфиге — расширение не требует токенов, но хранит настройки в `chrome.storage.local`.
- Поведение может отличаться между версиями Chrome и Chromium-подобными браузерами из-за изменений в API MV3.

## Ссылки и контакты

- Telegram: @RainbowCanary
- Discord: rainbowcanary
- Mail: rainbowcanaryyt@gmail.com
- GitHub: RainbowCanary

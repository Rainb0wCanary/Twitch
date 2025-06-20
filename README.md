# Twitch Game Link Watcher — расширение для браузера

## Описание

Данное расширение автоматически открывает Twitch-каналы, ищет ссылку на игру (по части ссылки из конфига), считает время просмотра каждого канала, ведёт статистику и позволяет управлять списком каналов и логами через удобный интерфейс.

C

## Установка

1. Скачайте или склонируйте папку с файлами расширения.
2. Откройте браузер Chrome.
3. Перейдите в раздел "Расширения" (chrome://extensions/).
4. Включите режим разработчика.
5. Нажмите "Загрузить распакованное расширение" и выберите папку с файлами.

## Настройка

1. Откройте файл `config.json` и укажите:
   - `searchUrlPart` — часть ссылки для поиска (например, "rust"). Ссылка для поиска это ссылка на категорию стрима
   - `channels` — список каналов Twitch с временем просмотра для каждого (например, `"watchTime": "0.10.30"` — 10 минут 30 секунд).
   - Остальные параметры можно оставить по умолчанию или изменить по желанию.
2. В интерфейсе расширения (popup или stats) загрузите свой конфиг через кнопку "Загрузить конфиг".

## Использование

- Для запуска автоматического просмотра нажмите "Старт просмотра" в popup.
- Для остановки — "Стоп".
- В stats.html отображается таблица каналов, время просмотра, статус (активен/в ЧС), кнопки управления и сброса времени.
- Ссылки на каналы кликабельны — можно перейти на Twitch в новой вкладке.
- Можно включать/отключать ведение логов (чекбокс "Вести логи"). Если логи отключены — они не сохраняются и не отправляются.
- Для сброса времени просмотра по каналу используйте кнопку "Сбросить".
- Для ручного помещения канала в ЧС — кнопка "Сделать неактивным" (ЧС навсегда), для активации — "Сделать активным".

## Важно
- Если все каналы в ЧС — расширение ждёт, пока хотя бы один канал не выйдет из ЧС.
- Временная блокировка (ЧС) по времени задаётся параметром `tempBlacklistSeconds` в конфиге.
- Для корректной работы расширения не закрывайте вкладку со stats.html, если хотите видеть актуальную статистику.

## Пример конфига

```
{
  "searchUrlPart": "rust",
  "channels": [
    { "url": "https://www.twitch.tv/templetaps", "watchTime": "0.10.30" },
    { "url": "https://www.twitch.tv/posty", "watchTime": "0.10.30" },
    { "url": "https://www.twitch.tv/shroud", "watchTime": "0.10.30" },
    { "url": "https://www.twitch.tv/winnie", "watchTime": "0.10.30" },
    { "url": "https://www.twitch.tv/danone_2001", "watchTime": "0.10.30" },
    { "url": "https://www.twitch.tv/chipa_rust", "watchTime": "0.10.30" },
    { "url": "https://www.twitch.tv/shamanfth", "watchTime": "0.10.30" }
  ],
  "waitBeforeCheck": 10,
  "maxAttempts": 5,
  "tempBlacklistSeconds": "0.5.30"
}
```

## Быстрое формирование конфига через DevTools

Если у вас есть страница с дропами или списком стримеров, вы можете быстро собрать список каналов и их времени просмотра с помощью следующего скрипта для консоли браузера:

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

  // Преобразуем в формат HH.MM.SS (всегда SS = 30, как ты указал)
  return `${hours}.${String(minutes).padStart(2, '0')}.30`;
}

const channels = [...document.querySelectorAll('.drop-box')].map(box => {
  const url = box.querySelector('.streamer-info')?.href;
  const rawTime = box.querySelector('.drop-time span')?.textContent.trim() || "";
  const watchTime = parseWatchTime(rawTime);
  // Фильтруем только валидные ссылки
  return url ? { url, watchTime } : null;
}).filter(Boolean);

const config = { channels };

console.log(JSON.stringify(config, null, 2));
```

1. Откройте страницу с нужными каналами в браузере.
2. Откройте DevTools (F12), вкладка Console.
3. Вставьте и выполните скрипт.
4. В консоли появится готовый JSON для вставки в ваш config.json.

## Обратная связь
Telegram: @RainbowCanary
Discord: rainbowcanary
Mail: rainbowcanaryyt@gmail.com

# RING — Telegram Stars PVP Wheel

Полностью отдельный Render-ready Telegram Mini App с PVP-колесом, реальным внутренним балансом, Telegram Stars invoices, PostgreSQL и встроенной админ-панелью.

## Что изменено в этой версии

- Убран внутренний верхний блок `Закрыть / меню` — это дублировал Telegram UI.
- Оранжевая стрелка самого колеса остаётся: она нужна для остановки на победителе.
- Кнопка `СДЕЛАТЬ СТАВКУ` находится под колесом.
- При банке 0 колесо полностью серое.
- Нет демо-баланса: баланс пользователя хранится в PostgreSQL.
- Вход проходит через Telegram Mini App `initData` с серверной проверкой подписи.
- Реальные пополнения выполняются через Telegram Stars (`XTR`).
- Ставка списывается сервером из внутреннего баланса.
- PVP win возвращает payout на внутренний баланс.
- Реализован уникальный цвет каждого участника.
- 20-секундный countdown стартует после второго участника.
- Сектор колеса соответствует доле ставки.
- Победитель выбирается на сервере криптографически стойким random.
- Комиссия 8%; payout никогда не меньше ставки победителя.
- PostgreSQL хранит пользователей, балансы, платежи, транзакции и завершённые раунды.
- Встроена админ-панель только для `ADMIN_TELEGRAM_IDS`.
- Админ может искать пользователей, выдавать Stars, списывать Stars, банить/разбанивать.
- При бане пользователь отключается от ставок и пополнений.

## Render Environment Variables

Добавьте:

`TELEGRAM_BOT_TOKEN` — токен вашего Telegram-бота из BotFather.

`TELEGRAM_WEBHOOK_SECRET` — Render генерирует автоматически в `render.yaml`; этот же секрет используется при установке webhook.

`APP_PUBLIC_URL` — публичный URL сервиса Render, например `https://telegram-stars-pvp-wheel.onrender.com`.

`TELEGRAM_MINI_APP_SHORT_NAME` — необязательно. Если у бота создан отдельный Direct Mini App в @BotFather, укажи его `short_name`; ссылки из каналов тогда будут открывать именно этот Mini App. Без этого переменная не нужна, но для прямого открытия по `?startapp=` у бота должен быть настроен Main Mini App в @BotFather.

`ADMIN_TELEGRAM_IDS` — числовой Telegram ID администратора. Несколько ID можно перечислить через запятую.

`DATABASE_URL` Render подставляет автоматически из PostgreSQL по `render.yaml`.

## Telegram Mini App authorization

Клиент передаёт `Telegram.WebApp.initData` на сервер. Сервер проверяет hash на основании bot token и срок `auth_date`. Это сделано специально, чтобы пользователь не мог подменить Telegram ID через frontend.

Если появляется ошибка авторизации, откройте `/api/telegram/status` через диагностический запрос из Telegram-клиента. Он показывает, получен ли initData, настроен ли bot token и почему проверка не прошла.

## Admin panel

Админ-панель появляется автоматически, когда Telegram ID текущего пользователя присутствует в `ADMIN_TELEGRAM_IDS`.

Доступные действия:
- список пользователей;
- поиск по ID/username/имени;
- выдача Stars;
- списание Stars;
- бан/разбан;
- общая статистика;
- история balance-транзакций через API.

Все admin API повторно проверяют Telegram initData и admin ID на сервере.

## Telegram Stars

Для цифровых товаров/услуг Telegram требует использование Stars с валютой `XTR`. Пополнение реализовано через Bot API invoice flow: createInvoiceLink → pre_checkout_query → successful_payment → идемпотентное зачисление по `telegram_payment_charge_id`.

После деплоя нужно настроить webhook вашего бота на:

`https://ВАШ-APP-PUBLIC-URL/api/telegram/webhook`

и передать тот же secret как `secret_token`.

## Локальный запуск

```bash
npm install
npm start
```

## Deploy

1. Создайте новый GitHub repository.
2. Загрузите все файлы этого проекта в корень репозитория.
3. Создайте Render Web Service из репозитория или используйте Blueprint по `render.yaml`.
4. Убедитесь, что создан PostgreSQL из Blueprint.
5. Заполните `TELEGRAM_BOT_TOKEN`, `APP_PUBLIC_URL` и `ADMIN_TELEGRAM_IDS`.
6. Настройте Mini App URL в BotFather на `APP_PUBLIC_URL`.
7. Настройте webhook на `/api/telegram/webhook`.

## Важное замечание о реальных Stars

Telegram Stars — целочисленная валюта. Поэтому invoice amounts и ставки принимаются только целыми Stars. Внутренний payout в этой версии округляется вниз до целого Star, при этом гарантируется правило `payout >= winnerBet`.


## RENDER: АВТОМАТИЧЕСКИЙ POSTGRESQL

В этом проекте `render.yaml` уже содержит одновременно:
- Web Service `telegram-stars-pvp-wheel`;
- Postgres `telegram-stars-pvp-db`;
- автоматическую передачу `DATABASE_URL` из Postgres в Web Service;
- автоматическую передачу `APP_PUBLIC_URL` из Render.

ВАЖНО: чтобы Render создал PostgreSQL автоматически из `render.yaml`, запускай проект через **Blueprint**, а не через обычное `New Web Service`.

Правильный путь:
1. Залить содержимое этого репозитория в GitHub.
2. Render Dashboard → **New → Blueprint**.
3. Выбрать GitHub-репозиторий.
4. Render прочитает `render.yaml`.
5. В списке ресурсов должны появиться:
   - `telegram-stars-pvp-wheel`
   - `telegram-stars-pvp-db`
6. На этапе создания Blueprint Render попросит значение для `ADMIN_TELEGRAM_IDS` и `TELEGRAM_BOT_TOKEN`.
7. После Apply Blueprint база автоматически создастся, а `DATABASE_URL` будет подставлен в Web Service.


## Логика цвета и процентов колеса

- При банке `0` колесо полностью серое.
- Каждый вошедший игрок получает свой уникальный цвет.
- Пока ставку сделал только один игрок, его цвет занимает **все 100% колеса**.
- Второй игрок может уже быть в комнате без ставки — его цвет есть у игрока, но сектор 0%.
- Как только второй игрок делает ставку, поле делится пропорционально ставкам.
- 10 + 10 Stars → 50% / 50% и разные цвета.
- 10 + 10 + 10 Stars → 33.33% / 33.33% / 33.33% и три разных цвета.
- Только игроки с реальной ставкой занимают сектор на колесе.
- Последний сектор нормализуется до конца 100%, поэтому на колесе нет незаполненной щели из-за округления.


## Анимация колеса
Колесо остаётся полностью неподвижным во время розыгрыша. Вращается только стрелка вокруг центра колеса и останавливается на середине сектора победителя.


## Обновления профиля

- игроки без ставки больше НЕ показываются в списке с `0.00 ⭐`;
- аватары Telegram отображаются у игроков и в профиле;
- после завершения вращения появляется отдельная карточка победителя с выигрышем;
- нижняя кнопка `Розыгрыши` заменена на `Профиль`;
- профиль показывает игры, победы, winrate и общий объём ставок;
- реферальная программа даёт 10% от успешных Telegram Stars пополнений приглашённых пользователей;
- реферальные начисления остаются `pending` и не зачисляются на основной баланс автоматически;
- кнопка `ЗАБРАТЬ НА БАЛАНС` переносит накопленные реферальные начисления на баланс;
- реферальные начисления записываются в отдельную таблицу `referral_earnings`;
- ссылка формата `https://t.me/<BOT_USERNAME>?startapp=ref_<USER_ID>` генерируется при заданном `TELEGRAM_BOT_USERNAME`.

Для существующей базы новые поля мигрируются автоматически через `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.


## Telegram /start и восстановление PVP

Проект теперь:
- автоматически устанавливает Telegram webhook при старте, если заданы `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` и `APP_PUBLIC_URL`;
- отвечает на `/start` сообщением с кнопкой `🚀 ЗАЙТИ В ПРИЛОЖЕНИЕ`;
- поддерживает `/start ref_<userId>` для реферальной привязки;
- добавляет пункт меню бота `Открыть приложение`;
- автоматически пере-регистрирует подключённого пользователя после завершения раунда;
- дополнительно восстанавливает пользователя из PostgreSQL при попытке ставки после нового раунда, поэтому ошибка `Игрок не найден` после каждого раунда больше не должна появляться.

## Timing fix
The winner is not revealed during `SPINNING`. The wheel remains fixed and only the pointer rotates
for about 6.2 seconds. The public state exposes no winner identity/status/payout until `RESULT`.
After a 150ms safety margin the server changes the state to `RESULT`, then the winner card appears.


## Referral flow

The referral link now uses the bot's private-chat deep link:

`https://t.me/<BOT_USERNAME>?start=ref_<REFERRER_ID>`

Flow:
1. User taps the referral link.
2. Telegram opens the private chat with the bot.
3. User presses Start (Telegram sends `/start ref_<REFERRER_ID>`).
4. The bot records the referral and sends an inline `🚀 ЗАЙТИ В ПРИЛОЖЕНИЕ` button.
5. The button opens the Mini App.
6. The Mini App carries the referral code so the referred user is attached to the referrer before their first Stars top-up.

## Розыгрыши

В этой версии добавлен раздел `Розыгрыши`: создание бесплатных и платных розыгрышей, списание призового фонда с баланса создателя, публикация поста ботом в канале, платные билеты, личные реферальные ссылки для +1 билета и проверка бустов канала через Bot API.

Для создания розыгрыша пользователь должен быть администратором указанного публичного канала, а бот — администратором с правом публикации сообщений. Для проверки бустов Telegram также требует, чтобы бот имел права администратора в этом канале.

### Розыгрыш из канала: прямое открытие Mini App
Кнопка `УЧАСТВОВАТЬ` в посте розыгрыша использует Telegram Mini App deep link. Чтобы Telegram открывал приложение сразу, а не страницу бота, настрой Main Mini App для бота через @BotFather. Для отдельного Direct Mini App можно задать `TELEGRAM_MINI_APP_SHORT_NAME` — тогда используется ссылка `t.me/<bot>/<short_name>?startapp=...`.

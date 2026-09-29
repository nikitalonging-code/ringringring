# Games integration

Integrated into the RING GAMES tab:

- PVP (existing)
- Upgrade (existing UI/logic, plus restored result overlay)
- Отскок (existing)
- Дроп (integrated from extracted game package)
- Пенальти (integrated from extracted game package)

Drop and Penalty use the real PostgreSQL Stars balance via Socket.IO. Penalty supports the continue/cash-out streak flow.

Added assets: `public/puck.png`, `public/assets/game-upgrade.svg`.

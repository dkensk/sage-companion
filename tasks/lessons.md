# Lessons Learned

## Git Workflow
- Always remind user to `git add`, `git commit`, then `git push` — not just `git push`
- After making changes, explicitly list the commit/push commands every time

## Timezone Handling
- Server runs in UTC (Render). Never use `new Date()` raw for user-facing dates
- Always join with `seniors.timezone` for any per-user date/time logic
- Use `todayInTz(tz)`, `midnightUtc(tz)`, `currentTimeInTz(tz)`, `getSeniorTz(seniorId)` helpers
- Frontend: parse date strings with `new Date(y, mo-1, d)` — never `new Date(dateStr + "T12:00:00")`
- Cron jobs that should fire at a specific local hour must run hourly and check `localHour`

## iOS Safari
- `opacity: 0` prevents image loading — use `opacity: 0.001` instead
- Add `-webkit-transform: translateZ(0)` for GPU compositing on images
- Always add fallback timers for IntersectionObserver-based reveals

## Auth Middleware
- `seniorAuth` only accepts `x-senior-token`; `anyAuth` accepts both senior and family tokens
- Shared endpoints (scan, delete) that family page needs must use `anyAuth`

# Sage Companion Code Review — March 9, 2026

## Issues Fixed (commit `b89a29f`)

### Untagged console.log/error statements → Tagged
| File | Line | Before | After |
|------|------|--------|-------|
| server.js | 1277 | `TTS request: voice=...` | `[TTS] Request: voice=...` |
| server.js | 1313 | `OpenAI TTS ${status}: ...` | `[TTS] OpenAI error ${status}: ...` |
| server.js | 1328 | `TTS failed: ...` | `[TTS] Failed: ...` |
| server.js | 1382 | `Transcribe error: ...` | `[Transcribe] Error: ...` |
| server.js | 1902 | `Google sync error: ...` | `[GoogleSync] Error: ...` |
| doctor.html | 564 | `Recognition error: ...` | `[DoctorVisit] Recognition error: ...` |
| reset-password.html | 456 | `Error: ...` | `[Auth] Reset password error: ...` |
| elder.html | 28 lines | `[tts]` / `[audio]` (lowercase) | `[TTS]` (uppercase, consistent) |

### Missing `.catch()` on fire-and-forget promises → Added
| File | Line | Promise chain |
|------|------|---------------|
| server.js | 895 | Timezone save `.then()` — added `.catch()` |
| server.js | 898 | Location save `.then()` — added `.catch()` |
| server.js | 1144 | Activity insert (appointment_added) — added `.catch()` |
| server.js | 1165 | Appointment insert (from reminder) — added `.catch()` |
| server.js | 1167 | Activity insert (reminder_added) — added `.catch()` |

### Service Worker cache bump
- `sw.js`: `sage-v81` → `sage-v82` (required because public/ files changed)

---

## Issues Found but NOT Fixed (require human review)

### HIGH PRIORITY — Security

1. **Token preview in auth logs** (server.js ~line 311)
   - Auth rejection logs include `tokenPreview: ${token.substring(0, 20)}` which could expose tokens in server logs.
   - **Recommendation:** Hash or remove the token preview.

2. **Admin password match logging** (server.js ~line 2002)
   - Logs `match: ${password === expected}` which reveals whether a password attempt was correct.
   - **Recommendation:** Only log failure events, not match status.

3. **Google OAuth tokens stored in plain text** (server.js ~line 1773)
   - Tokens saved directly to Supabase without encryption.
   - **Recommendation:** Encrypt tokens before storage.

4. **innerHTML with user content** (elder.html, admin.html, family.html)
   - Several places use `.innerHTML` with template literals containing user data. While `escHtml()` is used in most places, the pattern is inconsistent and some spots may miss escaping.
   - **Recommendation:** Audit all `innerHTML` usage; prefer `textContent` or `createElement` for user-controlled data.

### MEDIUM PRIORITY — Race Conditions

5. **Family code generation race** (server.js ~line 1956)
   - Generates a code, checks DB for uniqueness, then inserts — not atomic. Two simultaneous requests could generate the same code.
   - **Recommendation:** Use a DB unique constraint with retry-on-conflict.

6. **Google sync duplicate events** (server.js ~line 1859)
   - Check-then-insert for Google calendar events is not atomic.
   - **Recommendation:** Add unique constraint on `google_event_id`.

7. **Push subscription upsert race** (server.js ~line 2249)
   - Select-then-insert/update without atomic operation.
   - **Recommendation:** Use database upsert.

8. **Double-init potential in elder.html** (~line 1207)
   - `checkSeniorAuth().then(init())` could fire twice under rapid page loads.
   - **Recommendation:** Add an `initialized` guard flag.

### MEDIUM PRIORITY — Memory / Resource Leaks

9. **Rate limit cleanup interval never cleared** (server.js ~line 568)
   - `setInterval` for rate limit map cleanup has no stored reference for cleanup on server shutdown.
   - **Recommendation:** Store reference; clear on `process.on('exit')`.

10. **Google OAuth token listener accumulation** (server.js ~line 1800)
    - `client.on("tokens", ...)` listener attached but never removed per-request.
    - **Recommendation:** Remove listener after sync completes.

11. **SpeechSynthesis keepAlive interval** (elder.html ~line 2177)
    - Multiple rapid `speak()` calls could create overlapping keepalive intervals.
    - **Recommendation:** Track and clear previous interval before creating new one.

### MEDIUM PRIORITY — Error Handling

12. **Calendar feed race on init** (calendar.html ~line 315)
    - `checkGoogleStatus()` and `loadAppointments()` run in parallel without `await` — could cause UI inconsistencies on first load.

13. **Emergency API call silently swallowed** (elder.html ~line 2264)
    - `apiCall("/api/emergency", ...).catch(() => {})` — user won't know if family alert failed.
    - **Recommendation:** Show a warning toast on failure.

### LOW PRIORITY — Code Quality

14. **Hardcoded model names repeated** (server.js lines 164, 746, 759, 1055, 1351, 1586, 1602)
    - Model strings like `"claude-haiku-4-5-20251001"` appear in multiple places.
    - **Recommendation:** Extract to constants at module top.

15. **Hardcoded demo user ID** (elder.html, calendar.html, doctor.html)
    - `"00000000-0000-0000-0000-000000000001"` used as fallback in multiple files.
    - **Recommendation:** Define as a shared constant or env-driven config.

16. **localStorage/cookie sync runs only once** (elder.html ~line 1170)
    - Safari PWA standalone mode may desync localStorage and cookies mid-session.
    - **Recommendation:** Add periodic sync or event-based resync.

17. **Timezone not tracked for mid-session changes** (elder.html)
    - If user's timezone changes during a session, medication times won't adjust.
    - **Recommendation:** Detect timezone changes with a periodic check.

---

## Overall Code Health Assessment

The Sage Companion codebase is well-structured for a PWA of this complexity. Key strengths include consistent use of `escHtml()` for XSS prevention in most places, proper service worker caching strategy, and good auth token management with cookie/localStorage dual-storage for Safari PWA compatibility.

The main areas for improvement are: (1) security hardening around logging sensitive data, (2) atomicity of database operations to prevent race conditions, and (3) consistent error handling on fire-and-forget promise chains. None of the issues found are likely to cause immediate user-facing bugs in normal operation, but the race conditions could surface under concurrent usage and the security logging issues should be addressed before any compliance audit.

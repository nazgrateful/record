# Frequency Recorder — notes for making changes

Static site (no build step): open `index.html` through any web server.

## Saved data must survive every update

People keep recordings in this site's browser storage (IndexedDB database
`freq-recorder`, settings in localStorage key `freq-recorder.v1`). An update
must never lose or hide them:

- Database changes are additive only: add stores/indexes in a new
  `if (e.oldVersion < N)` block in `db.js` and bump `DB_VERSION`. Never delete,
  rename or clear a store or index, change a keyPath, or delete the database.
- Treat every field added later as optional when reading old records.
- Keep the localStorage key; new settings get defaults via `defaults` in
  `app.js`.
- Never delete recordings automatically except a recording with no saved
  audio that no tab is recording (see `recoverInterrupted`).
- Before publishing, run `npm install` (once) and `npm run test:upgrade`.
  When adding a new storage version, add it to `seed()` in
  `tests/upgrade-check.mjs` so the next update is checked against it.

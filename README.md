# SplitLine

Mobile-first, manual race timing for up to 20 athletes who start together.

## Current status

The app ships with **single-phone practice** enabled. The Firebase adapter and
database rules are supplied, but no Firebase project is configured by default.
The app must NOT be described as live multi-device timing until a real shared
project is connected, the rules are deployed, and an actual multi-phone test passes.

## Publish on GitHub Pages

In this repository, open **Settings → Pages**. Choose **Deploy from a branch**,
select **main** and **/(root)**, and save. GitHub will show the live site link
after deployment. Single-phone practice works immediately; connect Firebase
below to enable live sharing across phones.

## One-time shared backend setup

1. Open https://console.firebase.google.com/ and create a project you control.
   Review its current pricing and quotas. The app does not enable billing or
   create any accounts for you. Analytics is not needed.
2. Register a Web app. Keep the public Web `firebaseConfig` object.
3. In Authentication, enable the **Anonymous** sign-in provider. Do not turn on
   anonymous-account auto-cleanup if you want to retain starter identities.
4. Create a **Realtime Database**, NOT a Firestore database, in locked mode.
5. In its **Rules** tab, replace the rules with `database.rules.json` from this
   folder. Publish. Do not use public `.read: true` / `.write: true` test rules.
6. Include `databaseURL` in your Web config. It is the HTTPS URL shown on the
   Realtime Database page (regional databases may use `firebasedatabase.app`).
7. Either paste the JSON into **Set up live sharing** on each coach's device, or
   replace the `null` export in `firebase-config.mjs` with this public Web object
   and publish it once. Example:

   ```js
   export default {
     apiKey: "YOUR_PUBLIC_WEB_API_KEY",
     authDomain: "YOUR_PROJECT.firebaseapp.com",
     databaseURL: "https://YOUR_DATABASE.firebaseio.com",
     projectId: "YOUR_PROJECT",
     appId: "YOUR_WEB_APP_ID"
   };
   ```

   Public Web config is not a service-account credential. **Never send or commit
   passwords, service-account JSON, private keys, or admin credentials.** Access
   is enforced by the database rules and authenticated coach identities.
8. Test on at least two actual phones. Create a test race, invite a second coach,
   select different checkpoints, verify the countdown, record splits, and verify
   both phones see the same times. Turn off service on one device, record and
   undo taps, reload, reconnect, and verify the queued records arrive once.
9. After changing app files, bump the cache version in `sw.js`. Close old race
   tabs and reopen the app so all coaches run the same version. Do not update
   a timing deployment during a race.

Firebase documentation:

- https://firebase.google.com/docs/auth/web/anonymous-auth
- https://firebase.google.com/docs/database/web/offline-capabilities
- https://firebase.google.com/docs/database/security/rules-conditions
- https://firebase.google.com/docs/web/alt-setup

## Race-day flow

- The starter creates a race with athletes (`bib, name`, one per line) and
  checkpoints in order. The last checkpoint is the finish.
- Share the private invite. The invite proves membership; its secret is in the
  URL fragment, not a query string. It is NOT a public spectator link.
- Coaches enter their names, join while online, choose their checkpoint, and
  sync the clock. Check the **Crew** view before starting.
- The starter taps **Start race together**. It commits one estimated server-time
  start five seconds in the future. Give the actual whistle/start signal at zero.
  Other phones do not play a remote start sound. If the start arrives late, their
  elapsed time still uses the original shared start timestamp.
- Tap an athlete as they pass. A recorded athlete cannot be tapped again
  accidentally; tapping the tile opens details. Undo the mistaken tap to retry.
- Results are ranked at a selected checkpoint, not by whichever distance a runner
  last passed. Missing prior checkpoints do not produce made-up leg times.
- Multiple coaches may record the same checkpoint. Conflicting taps are visible;
  the earliest non-undone event is selected deterministically. The original coach
  or starter may undo an incorrect event; raw events are never overwritten.
- End a race only after coaches finish recording. Offline taps from before the
  end can still arrive. A race cannot be restarted; create another for a new heat.
- Download results CSV and a raw JSON backup. A backup excludes coach-invite
  secrets but includes raw events, undo records, and pending uploads.

## Spotty-service and accuracy limitations

- Live updates require connectivity. A coach offline before receiving the start
  cannot time the shared race until reconnecting and receiving it.
- Each tap is durably stored in browser localStorage before upload. Event IDs
  remain stable across reloads; retries use append-only transactions. Pending
  events and their undo records have different queue keys and upload in order.
- Web Firebase itself does not retain an offline queue across closed sessions;
  this app maintains its own. Reopen the same race/browser to retry. Background
  uploads while the browser is closed are not promised.
- Do not use private browsing, clear site storage, or use two timing tabs on one
  phone. Browser eviction, lost devices, or cleared browser data can lose pending
  taps. Backups remain important.
- Coach identity is an anonymous Firebase account persisted on that browser.
  Clearing it loses starter privileges; the app cannot recover the owner account
  without backend-administrator intervention. No custom password accounts yet.
- Clock calibration uses five server timestamp round-trip samples, chooses the
  lowest-latency sample, then pins an estimated clock to `performance.now` during
  the race. It shows the measured round-trip delay, NOT a guaranteed error bound.
  Reload or suspension can fall back to a cached wall-clock offset, flagged in
  recorded events. Avoid adjusting the device clock during a race.
- Human taps, asymmetric network delay, mobile sleep, and phone clocks affect
  accuracy. This is a coaching tool, not photo-finish or certified competition
  timing. No sub-second synchronization guarantee is made.
- Screen Wake Lock is requested when supported, but the phone OS may decline it.
- The service worker caches the app shell. Shared backend authentication may
  require reconnection after a reload. Cached races can still be recorded locally
  while disconnected if they already received a start and have a cached clock.

## Privacy and access

Use initials/bibs instead of full student names if desired. Follow your school's
policy before putting student data in a third-party service. Anyone with a private
invite can join as a coach and view the race; keep invites inside the coaching
crew. Database rules deny race listing and nonmember reads, restrict starting and
ending to the creator, restrict taps to members, and restrict undos to the original
recorder or creator. Raw records are immutable. Project administrators retain
administrative access. Configure retention and delete completed races through the
Firebase console when no longer needed. Public project config is not permission
to read race data. App Check, account login/recovery, spectators, and automated
retention are future hardening features, not implemented claims.

## Local development

Serve this folder over HTTP (ES modules do not work reliably from `file://`):

```sh
python3 -m http.server 8080
node --test tests/core.test.mjs
```

The test suite includes core timing/results logic and a browser integration
harness with a fake shared backend. A passing fake-backend test does not establish
that deployed Firebase rules or real-phone clock accuracy have been verified.

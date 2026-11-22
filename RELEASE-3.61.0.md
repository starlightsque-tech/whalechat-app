# WhaleChat 3.61.0

Built from the 3.60.0 release (latest `main`) with the account / status
finishing pass.

## Two account buttons below the investment dashboard card
- The **WhaleChat share price** dashboard card on WhaleChat Shares / WC-Investing
  now has a two-button row directly below it:
  **Chat** → the chat page (`#/home`) and **WC-Investing** → the WC-Investing
  account page (`#/invest/shares`).
- The same row sits under the WC-Investing dashboard summary cards and under the
  WhaleChat account crypto-balance card, so it is always one tap away.
- Layout matches the reference screenshot: two rounded cards side by side, teal
  for Chat, blue for WC-Investing, with the icon, label and chevron.

## Status privacy — pick exactly who sees a post
- When posting a status the poster chooses **Everyone on my contact list** or
  **Only selected contacts**, with a checkbox list, *Select all* / *Clear* and a
  live "N contacts selected" counter.
- Only the chosen contacts can open the status; `canViewStatus()` enforces it on
  the viewer, the story ring, the viewers list and the home status strip.
- A post with *Only selected contacts* and nothing picked is rejected, so a
  status can no longer be posted to nobody.
- The **My status** card shows the current audience, and the viewers sheet lists
  who can see the status next to who has viewed it.

## "Your contact just posted a status, view it now"
- Posting a status creates a notification for every contact who can see it:
  title **"Your contact just posted a status, view it now"**, body with the
  poster's name, link straight to `#/status`, icon `status`.
- For *Only selected contacts* the notification goes to the selected contacts
  only; for *Everyone on my contact list* it goes to the whole contact list.
- Blocked contacts are skipped. The notification syncs and is pushed to their
  devices, and the poster sees "N contacts notified" in the confirmation toast.

## Much louder notification sound
- `notify-alert.js` now drives the output through a hard limiter at full scale
  and doubles every tone with an octave layer, so the alarm is as loud as the
  device allows.
- New messages ring a **three-burst rising siren** (~4 s), other notifications a
  **two-burst chime** (~2.4 s), with a long vibration pattern (up to 4.4 s) that
  works on silent.
- A synced-data watcher rings the same alarm for notifications and messages that
  arrive from the server (a contact's status, an admin action, a message sent
  from another device), not just for locally created ones. A 450 ms guard stops
  two code paths from stacking the sound.
- Push notifications use the same loud vibration pattern and stay non-silent;
  the service-worker cache was bumped to `wc-v3.61.0-1` so every installed app
  picks up the new alarm.
